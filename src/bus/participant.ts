// Participant runtime (v0.2): one implementation, used by Juno's hook side
// and documented for grok's loop. Each participant is a symmetric bus peer:
// it publishes its own turns and subscribes to the peer's.
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
import type { ChatSignal } from "../types.ts";
import { BusClient, BusError, type FetchFn } from "./client.ts";
import {
  decodePayload,
  encodeTurn,
  turnMsgId,
  TurnValidator,
  type BusPayload,
  type RelayMessage,
} from "./protocol.ts";

export interface TranscriptTurn {
  seq: number;
  author: string;
  in_reply_to: number | null;
  body: string;
}

export interface TurnContext {
  agentId: string;
  peerId: string;
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
  cursor: number;
  /** durable seen-msg_id set — idempotent at-least-once processing */
  seen: string[];
  /** msg_ids this participant has published (self-wake filter) */
  own: string[];
  transcript: TranscriptTurn[];
  firstSpeaker: string | null;
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
    this.restoreValidator();
  }

  private load(): ParticipantState {
    try {
      const j = JSON.parse(readFileSync(this.statePath, "utf8")) as ParticipantState;
      return {
        cursor: j.cursor ?? 0,
        seen: j.seen ?? [],
        own: j.own ?? [],
        transcript: j.transcript ?? [],
        firstSpeaker: j.firstSpeaker ?? null,
        expected: j.expected ?? null,
        lastAcceptedSeq: j.lastAcceptedSeq ?? null,
        pendingPeerSeq: j.pendingPeerSeq ?? null,
        outbox: j.outbox ?? [],
        awaiting: j.awaiting ?? null,
        ended: j.ended ?? null,
      };
    } catch {
      return {
        cursor: 0,
        seen: [],
        own: [],
        transcript: [],
        firstSpeaker: null,
        expected: null,
        lastAcceptedSeq: null,
        pendingPeerSeq: null,
        outbox: [],
        awaiting: null,
        ended: null,
      };
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
      const v = this.validator.ingest({ seq: m.seq, author: m.author }, payload);

      if (payload?.type === "control") {
        if (v.kind === "started") {
          s.firstSpeaker = v.firstSpeaker;
          this.topic = payload.topic ?? null;
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
   * Wakeup: if the deterministic rule says it is our turn, produce a reply.
   * Pre-publish staleness check: re-read the relay first and drop the turn
   * if a newer message (peer turn or control) made it stale.
   */
  private async wakeup(): Promise<void> {
    const s = this.state;
    if (s.ended) return;
    const myTurn =
      this.validator.expected === this.opts.agentId &&
      (s.pendingPeerSeq !== null || this.validator.lastAcceptedSeq === null);
    if (!myTurn) return;

    // staleness check — catch up on anything newer before composing
    await this.fetchOnce(0);
    if (s.ended || this.validator.expected !== this.opts.agentId) return;

    const peerTurn =
      s.pendingPeerSeq !== null
        ? s.transcript.find((t) => t.seq === s.pendingPeerSeq) ?? null
        : null;
    const inReplyTo = peerTurn ? peerTurn.seq : null;
    const out = await this.opts.onTurn({
      agentId: this.opts.agentId,
      peerId: this.opts.peerId,
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
    if (s.ended || this.validator.expected !== this.opts.agentId) return;
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
