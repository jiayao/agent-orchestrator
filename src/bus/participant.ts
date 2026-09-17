// Participant runtime (v0.2): one implementation, used by Juno's hook side
// and documented for grok's loop. Each participant is a symmetric bus peer:
// it publishes its own turns and subscribes to the peer's.
//
// Peer identity is provisioned, not inferred: `peerId` comes from
// provisioning (the claim's attested participant list, or the operator's
// own bus.secret.json path). Any wire turn whose relay-attested author is
// neither us nor that provisioned peer means the channel is not the one we
// were provisioned into — the runtime aborts loudly rather than continue a
// mis-provisioned chat. This check is exactly as strong as the relay's
// authorship attestation (crash-faults-only trust model) — it detects
// provisioning/wire disagreement, not a Byzantine relay.
//
// Discipline (all durable, all crash-safe):
// - the inbound cursor advances only after the message's effects are
//   committed to the state file (the pending-reply record IS the effect for
//   a peer turn — the reply itself retries out of the durable outbox);
// - a durable seen-msg_id set gives idempotent at-least-once processing:
//   cursor loss replays from the last committed cursor and duplicates
//   collapse on msg_id;
// - the outbox holds unacked publishes, retried with backoff — a stable
//   client-generated msg_id + relay dedupe means no "did it land?" window;
// - whoever waits owns the reply deadline: an unanswered published turn is
//   re-published (same msg_id) after reply_timeout;
// - wakeups are serialized; control messages (chat_ended) jump the queue and
//   a pre-publish staleness check drops turns made stale by a newer message;
// - self-wake filtering keys on attested author plus own msg_id history;
// - strict alternation bounds the backlog to one unanswered peer turn — the
//   pending slot keeps the latest only.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatSignal, RosterEntry } from "../types.ts";
import { BusClient, BusError, type FetchFn } from "./client.ts";
import {
  decodePayload,
  encodeTurn,
  turnMsgId,
  TurnValidator,
  type BusPayload,
  type RelayMessage,
} from "./protocol.ts";
import { expectedActor, type AcceptedTurn } from "../chatcore.ts";

/**
 * Thrown when a wire turn's relay-attested author is neither this
 * participant nor the provisioned peer: the channel's live authorship
 * disagrees with what provisioning attested — a mis-provisioned channel.
 * Fatal to the run, not a transcript event: the process aborts loudly.
 */
export class PeerMismatchError extends Error {
  constructor(
    readonly channel: string,
    readonly expected: string,
    readonly observed: string,
    readonly seq: number
  ) {
    super(
      `peer mismatch on ${channel}: provisioned peer is "${expected}" but ` +
        `a turn arrived authored by "${observed}" (seq=${seq}) — ` +
        `mis-provisioned channel, aborting`
    );
    this.name = "PeerMismatchError";
  }
}

export interface TranscriptTurn {
  seq: number;
  author: string;
  in_reply_to: number | null;
  body: string;
  signal?: ChatSignal;
}

export interface TurnContext {
  agentId: string;
  peerId: string;
  /** presentation-only labels from the opening control, when published */
  roster?: RosterEntry[];
  /** display_name for the peer, when the roster carries one (else undefined) */
  peerDisplayName?: string;
  channel: string;
  topic: string | null;
  /** accepted turns so far (validated against the deterministic rule) */
  transcript: TranscriptTurn[];
  /** the peer turn being answered; null when producing the opening turn */
  peerTurn: TranscriptTurn | null;
}

export type TurnHandler = (
  ctx: TurnContext
) => Promise<{ body: string; signal?: ChatSignal } | null>;

export interface ParticipantOptions {
  busUrl: string;
  channel: string;
  epoch: string;
  token: string;
  secret: string;
  agentId: string;
  peerId: string;
  /** directory holding bus-participant.json */
  stateDir: string;
  onTurn: TurnHandler;
  /** unanswered-turn re-publish deadline; default 60s */
  replyTimeoutMs?: number;
  pollWaitMs?: number;
  fetchFn?: FetchFn;
  hooks?: {
    onAcceptedTurn?: (t: TranscriptTurn) => void;
    onPublish?: (msgId: string, seq: number) => void;
    onEnd?: (reason: string) => void;
  };
}

interface OutboxEntry {
  msg_id: string;
  plaintext: string;
  attempts: number;
  next_at: number;
}

interface AwaitingEntry {
  /** re-publishing keeps the original msg_id and payload */
  msg_id: string;
  plaintext: string;
  seq: number;
  next_at: number;
  backoff_ms: number;
}

interface ParticipantState {
  /** the channel + epoch this state file belongs to — a mismatch on load
   *  resets to a fresh state rather than inheriting another chat's cursor */
  channel?: string;
  epoch?: string;
  cursor: number;
  /** durable seen-msg_id set — idempotent at-least-once processing */
  seen: string[];
  /** msg_ids this participant has published (self-wake filter) */
  own: string[];
  transcript: TranscriptTurn[];
  firstSpeaker: string | null;
  /** presentation-only roster from chat_started; never used for validation */
  roster: RosterEntry[] | null;
  expected: string | null;
  lastAcceptedSeq: number | null;
  /** latest accepted peer turn not yet answered (coalesced) */
  pendingPeerSeq: number | null;
  outbox: OutboxEntry[];
  /** published turn awaiting the peer's reply (deadline ownership) */
  awaiting: AwaitingEntry | null;
  ended: { reason: string; seq: number } | null;
}

const SEEN_CAP = 2_000;
const OWN_CAP = 500;
const TRANSCRIPT_CAP = 200;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ParticipantRuntime {
  readonly opts: ParticipantOptions;
  readonly client: BusClient;
  private statePath: string;
  private state: ParticipantState;
  private validator: TurnValidator;
  private topic: string | null = null;
  private roster: RosterEntry[] | null = null;

  constructor(opts: ParticipantOptions) {
    this.opts = opts;
    this.client = new BusClient({
      busUrl: opts.busUrl,
      channel: opts.channel,
      token: opts.token,
      secret: opts.secret,
      fetchFn: opts.fetchFn,
    });
    this.statePath = join(opts.stateDir, "bus-participant.json");
    // deterministic participant order — the rule is symmetric
    this.validator = new TurnValidator([opts.agentId, opts.peerId].sort() as [string, string]);
    this.state = this.load();
    this.roster = this.state.roster;
    this.restoreValidator();
  }

  private load(): ParticipantState {
    const fresh = (): ParticipantState => ({
      channel: this.opts.channel,
      epoch: this.opts.epoch,
      cursor: 0,
      seen: [],
      own: [],
      transcript: [],
      firstSpeaker: null,
      roster: null,
      expected: null,
      lastAcceptedSeq: null,
      pendingPeerSeq: null,
      outbox: [],
      awaiting: null,
      ended: null,
    });
    try {
      const j = JSON.parse(readFileSync(this.statePath, "utf8")) as ParticipantState;
      // the state file is bound to {channel, epoch}: a re-provisioned chat
      // must not inherit the old cursor/ended state
      if (j.channel !== this.opts.channel || j.epoch !== this.opts.epoch) {
        process.stderr.write(
          `bus-participant: state file belongs to channel=${j.channel} epoch=${j.epoch} ` +
            `(this run: ${this.opts.channel}/${this.opts.epoch}) — starting fresh\n`
        );
        return fresh();
      }
      return {
        channel: j.channel,
        epoch: j.epoch,
        cursor: j.cursor ?? 0,
        seen: j.seen ?? [],
        own: j.own ?? [],
        transcript: j.transcript ?? [],
        firstSpeaker: j.firstSpeaker ?? null,
        roster: j.roster ?? null,
        expected: j.expected ?? null,
        lastAcceptedSeq: j.lastAcceptedSeq ?? null,
        pendingPeerSeq: j.pendingPeerSeq ?? null,
        outbox: j.outbox ?? [],
        awaiting: j.awaiting ?? null,
        ended: j.ended ?? null,
      };
    } catch {
      return fresh();
    }
  }

  /** Rebuild the deterministic validation state from persisted fields. */
  private restoreValidator(): void {
    this.validator.restore({
      firstSpeaker: this.state.firstSpeaker,
      expected: this.state.expected,
      lastAcceptedSeq: this.state.lastAcceptedSeq,
      lastAcceptedAuthor:
        this.state.transcript[this.state.transcript.length - 1]?.author ?? null,
      seenReplies: this.state.transcript.map(
        (t) => `${t.author}:${t.in_reply_to ?? "null"}`
      ),
      ended: this.state.ended
        ? { reason: this.state.ended.reason, terminalSeq: this.state.ended.seq }
        : null,
    });
  }

  /** Atomic persist: one file, tmp + rename. */
  private persist(): void {
    mkdirSync(this.opts.stateDir, { recursive: true });
    const tmp = this.statePath + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.state, null, 2) + "\n");
    renameSync(tmp, this.statePath);
  }

  get ended(): boolean {
    return this.state.ended !== null;
  }

  get cursor(): number {
    return this.state.cursor;
  }

  /** test introspection */
  get transcript(): TranscriptTurn[] {
    return this.state.transcript;
  }

  get outboxSize(): number {
    return this.state.outbox.length;
  }

  /**
   * Process one relayed message: validate, record, persist — durable state
   * (seen set, pending-reply intent, cursor) commits atomically per message,
   * so a crash replays at most the in-flight message.
   */
  private async processMessage(m: RelayMessage): Promise<void> {
    const s = this.state;
    if (!s.seen.includes(m.msg_id)) {
      s.seen.push(m.msg_id);
      if (s.seen.length > SEEN_CAP) s.seen.splice(0, s.seen.length - SEEN_CAP);

      let payload: BusPayload | null = null;
      try {
        payload = decodePayload(this.client.decrypt(m));
      } catch {
        payload = null; // tampered or wrong key — never accepted
      }

      const own = m.author === this.opts.agentId;

      // Provisioning attestation, checked on the raw wire author BEFORE the
      // turn validator: a turn authored by anyone but us or the provisioned
      // peer is not merely protocol-invalid (the validator would ignore it
      // as not_participant and we'd hang) — it is positive evidence the
      // channel is not what we were provisioned into. Abort loudly; the
      // message is deliberately left unprocessed/unpersisted so a restart
      // re-encounters it and aborts again rather than silently advancing
      // past the disagreement.
      if (payload?.type === "turn" && !own && m.author !== this.opts.peerId) {
        const err = new PeerMismatchError(this.opts.channel, this.opts.peerId, m.author, m.seq);
        process.stderr.write(`bus-participant: ${err.message}\n`);
        throw err;
      }

      const v = this.validator.ingest({ seq: m.seq, author: m.author }, payload);

      if (payload?.type === "control") {
        if (v.kind === "started") {
          s.firstSpeaker = v.firstSpeaker;
          this.topic = payload.topic ?? null;
          // Presentation-only; absent on pre-roster controls and tolerated.
          if (payload.roster && payload.roster.length > 0) {
            this.roster = payload.roster;
            s.roster = payload.roster;
          }
        } else if (v.kind === "ended") {
          s.ended = { reason: v.reason, seq: m.seq };
          s.pendingPeerSeq = null;
          this.opts.hooks?.onEnd?.(v.reason);
        }
      } else if (v.kind === "turn" && payload?.type === "turn") {
        const t: TranscriptTurn = {
          seq: m.seq,
          author: m.author,
          in_reply_to: payload.in_reply_to,
          body: payload.body,
          signal: payload.signal ?? "continue",
        };
        s.transcript.push(t);
        if (s.transcript.length > TRANSCRIPT_CAP) {
          s.transcript.splice(0, s.transcript.length - TRANSCRIPT_CAP);
        }
        if (own) {
          if (!s.own.includes(m.msg_id)) {
            s.own.push(m.msg_id);
            if (s.own.length > OWN_CAP) s.own.splice(0, s.own.length - OWN_CAP);
          }
        } else {
          // the peer's accepted turn satisfies our reply deadline, and it is
          // the (single, coalesced) unanswered peer turn to answer
          if (s.awaiting && m.seq > s.awaiting.seq) s.awaiting = null;
          s.pendingPeerSeq = m.seq;
          this.opts.hooks?.onAcceptedTurn?.(t);
        }
      }
      s.expected = this.validator.expected;
      s.lastAcceptedSeq = this.validator.lastAcceptedSeq;
      s.firstSpeaker = this.validator.firstSpeaker;
    }
    if (m.seq > s.cursor) s.cursor = m.seq;
    this.persist();
  }

  /** Pull one batch (long-poll), processing each message in order. */
  private async fetchOnce(waitMs: number): Promise<number> {
    const res = await this.client.poll(this.state.cursor, waitMs);
    for (const m of res.messages) {
      await this.processMessage(m);
      if (this.state.ended) break; // control jumped the queue: stop turn work
    }
    return res.messages.length;
  }

  /** Publish every due outbox entry; exponential backoff on failure. */
  private async flushOutbox(): Promise<void> {
    const now = Date.now();
    for (const e of [...this.state.outbox]) {
      if (this.state.ended) return;
      if (e.next_at > now) continue;
      try {
        const ack = await this.client.publish(e.msg_id, e.plaintext);
        this.state.outbox = this.state.outbox.filter((x) => x !== e);
        if (!this.state.own.includes(e.msg_id)) {
          this.state.own.push(e.msg_id);
          if (this.state.own.length > OWN_CAP) {
            this.state.own.splice(0, this.state.own.length - OWN_CAP);
          }
        }
        // the sender owns retries; the waiter owns the reply deadline
        const replyMs = this.opts.replyTimeoutMs ?? 60_000;
        const prev = this.state.awaiting;
        if (prev && prev.msg_id === e.msg_id) {
          // this was a re-publish of an already-awaited turn: keep backoff,
          // refresh the seq in case the relay lost the original append
          prev.next_at = Date.now() + prev.backoff_ms;
          prev.seq = ack.seq;
        } else {
          this.state.awaiting = {
            msg_id: e.msg_id,
            plaintext: e.plaintext,
            seq: ack.seq,
            next_at: Date.now() + replyMs,
            backoff_ms: replyMs,
          };
        }
        this.opts.hooks?.onPublish?.(e.msg_id, ack.seq);
        this.persist();
      } catch {
        e.attempts += 1;
        e.next_at = Date.now() + Math.min(100 * 2 ** e.attempts, 5_000);
        this.persist();
      }
    }
  }

  /**
   * Whose turn is it — derived from the accepted-turn transcript through the
   * shared rule (chatcore.expectedActor); the same fold the validator applies
   * incrementally. Null until the opening control names a first speaker.
   */
  private expectedSpeaker(): string | null {
    const s = this.state;
    if (s.firstSpeaker === null) return null;
    const turns: AcceptedTurn[] = s.transcript.map((t) => ({
      seq: t.seq,
      actor: t.author,
      in_reply_to: t.in_reply_to,
      body: t.body,
      signal: t.signal ?? "continue",
    }));
    return expectedActor(turns, this.validator.participants, s.firstSpeaker);
  }

  /**
   * Wakeup: if the deterministic rule says it is our turn, produce a reply.
   * Pre-publish staleness check: re-read the relay first and drop the turn
   * if a newer message (peer turn or control) made it stale.
   */
  private async wakeup(): Promise<void> {
    const s = this.state;
    if (s.ended) return;
    const myTurn =
      this.expectedSpeaker() === this.opts.agentId &&
      (s.pendingPeerSeq !== null || this.validator.lastAcceptedSeq === null);
    if (!myTurn) return;

    // staleness check — catch up on anything newer before composing
    await this.fetchOnce(0);
    if (s.ended || this.expectedSpeaker() !== this.opts.agentId) return;

    const peerTurn =
      s.pendingPeerSeq !== null
        ? s.transcript.find((t) => t.seq === s.pendingPeerSeq) ?? null
        : null;
    const inReplyTo = peerTurn ? peerTurn.seq : null;
    const out = await this.opts.onTurn({
      agentId: this.opts.agentId,
      peerId: this.opts.peerId,
      roster: this.roster ?? undefined,
      peerDisplayName: this.roster?.find((r) => r.id === this.opts.peerId)?.display_name,
      channel: this.opts.channel,
      topic: this.topic,
      transcript: s.transcript.slice(),
      peerTurn,
    });
    const body = out?.body ?? "(no response)";
    const signal = out?.signal ?? (out ? "continue" : "pass");

    // second staleness check — the handler may have taken a while; drop a
    // reply made stale by a message that arrived while we composed it
    await this.fetchOnce(0);
    if (s.ended || this.expectedSpeaker() !== this.opts.agentId) return;
    if (inReplyTo !== null && s.pendingPeerSeq !== inReplyTo) return;

    const msgId = turnMsgId(this.opts.agentId, this.opts.epoch, inReplyTo);
    if (!s.outbox.some((e) => e.msg_id === msgId)) {
      s.outbox.push({
        msg_id: msgId,
        plaintext: encodeTurn(inReplyTo, body, signal),
        attempts: 0,
        next_at: 0,
      });
    }
    s.pendingPeerSeq = null;
    this.persist();
  }

  /**
   * Re-publish a published-but-unanswered turn whose reply deadline passed:
   * same msg_id — dedupe collapses it if the relay has it, appends if the
   * relay lost it. Either way the conversation moves.
   */
  private republishUnanswered(): void {
    const a = this.state.awaiting;
    if (!a || this.state.ended || Date.now() < a.next_at) return;
    if (!this.state.outbox.some((e) => e.msg_id === a.msg_id)) {
      this.state.outbox.push({
        msg_id: a.msg_id,
        plaintext: a.plaintext,
        attempts: 0,
        next_at: 0,
      });
    }
    a.backoff_ms = Math.min(a.backoff_ms * 2, 30_000);
    a.next_at = Date.now() + a.backoff_ms;
    this.persist();
  }

  /** ms until the next due item (outbox retry or reply deadline). */
  private nextWait(pollWaitMs: number): number {
    let wait = pollWaitMs;
    const now = Date.now();
    for (const e of this.state.outbox) wait = Math.min(wait, Math.max(1, e.next_at - now));
    if (this.state.awaiting) {
      wait = Math.min(wait, Math.max(1, this.state.awaiting.next_at - now));
    }
    return wait;
  }

  /**
   * Main loop: fetch → wakeup (effects) → flush outbox → reply deadline.
   * Serialized: one wakeup at a time; control messages end it promptly.
   */
  async run(signal?: AbortSignal): Promise<{ ended: string | null; turns: number }> {
    const pollWaitMs = this.opts.pollWaitMs ?? 1_000;
    while (!this.state.ended && !signal?.aborted) {
      try {
        await this.fetchOnce(this.nextWait(pollWaitMs));
      } catch (e) {
        // a provisioning violation is fatal, not retriable — let it abort
        if (e instanceof PeerMismatchError) throw e;
        const status = (e as BusError).status;
        if (status === 401 || status === 404) throw e;
        await sleep(Math.min(250, pollWaitMs));
      }
      await this.wakeup();
      await this.flushOutbox();
      this.republishUnanswered();
    }
    return { ended: this.state.ended?.reason ?? null, turns: this.state.transcript.length };
  }
}
