// Bus auditor (v0.2): subscribes to the channel, validates, commits.
// Exactly ONE record per relay message: a bus_record carrying the full wire
// envelope (nonce + ct persisted — the record stays re-decryptable and
// re-validatable forever) plus the validation verdict
// ("turn" | "ignored" | "control_started" | "control_ended") and, for
// accepted turns, the materialized fields (body, signal, in_reply_to).
// Cursor advance and validation outcome commit atomically in a single
// append — there is no raw-then-turn window to crash inside. The turn /
// chat_* view is derivable: filter verdict === "turn".
//
// Crash discipline: the cursor is derived as max committed relay seq in
// events.jsonl — one file, no separate cursor state. On restart, committed
// bus_records are re-decrypted and re-run through TurnValidator, so the
// rebuilt expected/lastAcceptedSeq state matches the wire exactly. Control
// messages carry deterministic msg_ids derived from {channel_epoch,
// terminal_seq, reason}; on startup the auditor re-publishes any committed
// terminal control, and relay + participant dedupe make the replay harmless.

import type { Blackboard } from "../blackboard.ts";
import type { TaskMeta, TeamConfig, TeamEvent, ChatEndReason, RosterEntry } from "../types.ts";
import type { BusClient } from "./client.ts";
import { BusError } from "./client.ts";
import { hashPayload } from "./crypto.ts";
import {
  decodePayload,
  deriveCursor,
  endedMsgId,
  encodeEnded,
  encodeStarted,
  openingMsgId,
  TurnValidator,
  type BusPayload,
  type RelayMessage,
  type Validation,
} from "./protocol.ts";
import { applyRedaction } from "../spawn.ts";
import { escapeMarkers, type ChatSummary } from "../chat.ts";
import {
  endCondition,
  findCompletedHandshake,
  substantiveCount,
  type AcceptedTurn,
} from "../chatcore.ts";

export interface BusChatContext {
  busUrl: string;
  channel: string;
  epoch: string;
  agents: [string, string];
  firstSpeaker: string;
  topic: string;
  /** presentation-only labels published on the opening control. Entry ids are
   *  restricted to the channel participants; this never affects validation. */
  roster?: RosterEntry[];
}

export interface BusAuditorOptions {
  /** post-first-turn idle deadline -> chat_ended{idle_timeout}; default 120s */
  idleTimeoutMs?: number;
  /** pre-first-turn idle deadline -> chat_ended{idle_before_first_turn};
   *  defaults to idleTimeoutMs. The regime is derived from committed
   *  accepted turns, never from wall-clock boot, so restarts can't flip it. */
  preFirstTurnTimeoutMs?: number;
  maxTurns?: number; // substantive cap -> chat_ended{expired}
  pollWaitMs?: number; // per-request long-poll wait, default 1s
  signal?: AbortSignal;
  onEvent?: (ev: TeamEvent) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A committed record carrying an accepted turn (bus_record or legacy turn). */
const isAcceptedTurnRecord = (e: TeamEvent): boolean =>
  (e.type === "bus_record" && e.verdict === "turn") ||
  (e.type === "turn" && e.bus !== undefined);

/** A committed opening control (bus_record verdict or legacy chat_started). */
const isCommittedStart = (e: TeamEvent): boolean =>
  (e.type === "bus_record" && e.verdict === "control_started") ||
  (e.type === "chat_started" && e.bus?.control === "chat_started");

/** A committed end decision (bus_record verdict or a local chat_ended). */
const isCommittedEnd = (e: TeamEvent): boolean =>
  (e.type === "bus_record" && e.verdict === "control_ended") ||
  e.type === "chat_ended";

/** Normalize a committed accepted-turn record into the shared stream shape. */
const recordToAccepted = (e: TeamEvent): AcceptedTurn => ({
  seq: e.bus!.seq,
  actor: e.bus!.author ?? e.actor,
  in_reply_to: e.bus!.in_reply_to ?? null,
  body: e.body,
  signal: e.signal ?? "continue",
  id: e.event_id,
});

export async function runBusAuditor(
  bb: Blackboard,
  config: TeamConfig,
  meta: TaskMeta,
  client: BusClient,
  ctx: BusChatContext,
  opts: BusAuditorOptions = {}
): Promise<ChatSummary> {
  const idleTimeoutMs = opts.idleTimeoutMs ?? 120_000;
  const preFirstTurnTimeoutMs = opts.preFirstTurnTimeoutMs ?? idleTimeoutMs;
  const maxTurns = opts.maxTurns ?? meta.chat?.max_turns ?? config.chat.max_turns;
  const pollWaitMs = opts.pollWaitMs ?? 1_000;

  const emit = async (ev: Parameters<Blackboard["appendEvent"]>[1]) => {
    const full = await bb.appendEvent(meta.id, ev);
    opts.onEvent?.(full);
    return full;
  };

  // The auditor lease is owned at the relay: one per channel, a second author
  // is rejected. Re-requesting as the same author is idempotent (restart).
  const lease = await client.requestAuditorLease();

  // Cursor: max committed relay seq. Rebuild the deterministic validation
  // state by re-decrypting and re-ingesting every committed bus_record —
  // the nonce is persisted on the record, so the replay is exact.
  const committed = bb.readEvents(meta.id);
  let cursor = deriveCursor(committed);
  const validator = new TurnValidator(ctx.agents);
  validator.replayCommitted(committed, (w) => {
    try {
      return client.decryptFields(w.msg_id, w.nonce, w.ct);
    } catch {
      return null;
    }
  });

  const committedStart = committed.find(isCommittedStart);
  const committedEnd = committed.find(isCommittedEnd);
  const acceptedRecords = committed.filter(isAcceptedTurnRecord);

  meta.chat ??= {
    topic: ctx.topic,
    max_turns: maxTurns,
    history_budget_chars: config.chat.history_budget_chars,
    console_timeout_ms: config.chat.console_timeout_ms,
    substantive_turns: 0,
    total_turns: 0,
  };

  // The normalized accepted-turn stream — end conditions and counts derive
  // from this and nothing else (shared with runChat via chatcore).
  const accepted: AcceptedTurn[] = acceptedRecords.map(recordToAccepted);
  // Idle clock: post-first-turn it anchors on the last accepted turn;
  // pre-first-turn it anchors on the committed opening (a restart does not
  // restart the window participants were given).
  let lastAcceptedAt = acceptedRecords.length
    ? Date.parse(acceptedRecords[acceptedRecords.length - 1].ts)
    : committedStart
      ? Date.parse(committedStart.ts)
      : Date.now();

  meta.state = "running";
  bb.writeMeta(meta);

  /** Publish with bounded retries; null when the relay stayed unreachable. */
  async function publishWithRetry(
    msgId: string,
    plaintext: string
  ): Promise<{ seq: number; deduped: boolean } | null> {
    let delay = 50;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const ack = await client.publish(msgId, plaintext);
        return { seq: ack.seq, deduped: ack.deduped };
      } catch {
        await sleep(delay);
        delay = Math.min(delay * 2, 1_000);
      }
    }
    return null;
  }

  // --- opening control (author "orchestrator") names the first speaker ---
  // Publish it, then let it arrive back through the subscription like every
  // other message: validation runs over the relay log in seq order, so a
  // turn posted before the opening stays protocol-invalid forever and every
  // party computes the same result from the same log.
  const openMsgId = committedStart?.bus?.msg_id ?? openingMsgId(ctx.epoch);
  const publishOpening = async () => {
    await client
      .publish(openMsgId, encodeStarted(ctx.firstSpeaker, ctx.topic, ctx.roster))
      .catch(() => {});
  };
  let lastOpenPublish = 0;
  if (!committedStart) {
    await publishWithRetry(openMsgId, encodeStarted(ctx.firstSpeaker, ctx.topic, ctx.roster));
    lastOpenPublish = Date.now();
  } else {
    // Committed opening: re-publish its deterministic msg_id — relay dedupe
    // makes the replay harmless, and restores it if the relay lost it.
    await publishOpening();
  }

  // --- startup re-publish of a committed terminal control ---
  if (committedEnd) {
    const reason = committedEnd.bus?.reason ?? validator.ended?.reason ?? "idle_timeout";
    const terminalSeq =
      committedEnd.bus?.terminal_seq ?? validator.ended?.terminalSeq ?? 0;
    await client
      .publish(committedEnd.bus!.msg_id, encodeEnded(reason, terminalSeq))
      .catch(() => {});
  }

  const finish = (reason: ChatEndReason | null, detail?: string): ChatSummary => {
    const substantive = substantiveCount(accepted);
    meta.chat!.substantive_turns = substantive;
    meta.chat!.total_turns = accepted.length;
    meta.completed_rounds = substantive;
    if (reason) {
      meta.chat!.end_reason = reason;
      meta.state =
        reason === "agreed" ? "completed" : reason === "cancelled" ? "cancelled" : "failed";
      meta.ended_at = new Date().toISOString();
    }
    bb.writeMeta(meta);
    bb.renderView(meta.id);
    return {
      task_id: meta.id,
      state: meta.state,
      end_reason: meta.chat!.end_reason ?? reason,
      substantive_turns: substantive,
      total_turns: accepted.length,
    };
  };

  let ending = false;

  /**
   * Commit an end decision that was never observed on the wire (publish lost
   * or drain cut short). seq stays 0 — a locally decided record must not
   * advance the derived cursor past messages nobody committed. Startup
   * re-publish repairs the wire copy.
   */
  const commitEnded = async (reason: string, terminalSeq: number, msgId: string) => {
    const existing = bb
      .readEvents(meta.id)
      .find((e) => isCommittedEnd(e) && e.bus?.msg_id === msgId);
    if (existing) return;
    await emit({
      actor: "orchestrator",
      type: "chat_ended",
      round: 0,
      reply_to: null,
      body: `reason=${reason} — channel=${ctx.channel} terminal_seq=${terminalSeq} (auditor-imposed, not wire-observed)`,
      bus: {
        channel: ctx.channel,
        seq: 0,
        msg_id: msgId,
        author: "orchestrator",
        control: "chat_ended",
        reason,
        terminal_seq: terminalSeq,
      },
    });
  };

  /**
   * Process one relayed message: decrypt, validate, commit — a single
   * bus_record per wire message holding the envelope as relayed plus the
   * verdict, atomically. Returns the validation verdict.
   */
  const processMessage = async (m: RelayMessage): Promise<Validation> => {
    let plaintext: string | null = null;
    try {
      plaintext = client.decrypt(m);
    } catch {
      plaintext = null; // tampered or wrong key — committed as ignored
    }
    const payload = plaintext !== null ? decodePayload(plaintext) : null;
    const v = validator.ingest({ seq: m.seq, author: m.author }, payload);

    // the wire envelope as observed — nonce + ct make the record re-validatable
    const bus: NonNullable<TeamEvent["bus"]> = {
      channel: ctx.channel,
      seq: m.seq,
      msg_id: m.msg_id,
      author: m.author,
      nonce: m.nonce,
      ct: m.ct,
      // hash of the decrypted payload; of the ciphertext when undecryptable
      payload_hash: hashPayload(plaintext ?? m.ct),
    };
    if (payload?.type === "turn") bus.in_reply_to = payload.in_reply_to;

    if (v.kind === "turn" && payload?.type === "turn") {
      const sig = payload.signal ?? "continue";
      const ev = await emit({
        actor: m.author,
        type: "bus_record",
        round: 0,
        reply_to: null,
        body: escapeMarkers(applyRedaction(payload.body, config)),
        signal: sig,
        verdict: "turn",
        bus,
      });
      accepted.push({
        seq: m.seq,
        actor: m.author,
        in_reply_to: payload.in_reply_to,
        body: payload.body,
        signal: sig,
        id: ev.event_id,
      });
      lastAcceptedAt = Date.now();
      if (accepted.length === 1) {
        // first accepted turn flips the idle regime — observability only,
        // the regime itself is derived from committed turns
        await emit({
          actor: "orchestrator",
          type: "note",
          round: 0,
          reply_to: null,
          body: `post-first-turn idle timer armed (idle_timeout_ms=${idleTimeoutMs})`,
        });
      }
      meta.chat!.substantive_turns = substantiveCount(accepted);
      meta.chat!.total_turns = accepted.length;
      bb.writeMeta(meta);
    } else if (v.kind === "started" && payload?.type === "control") {
      // the opening control arriving back through the subscription
      bus.control = "chat_started";
      bus.first_speaker = v.firstSpeaker;
      // record what the wire actually carried, not what we would have sent
      if (payload.roster) bus.roster = payload.roster;
      await emit({
        actor: m.author,
        type: "bus_record",
        round: 0,
        reply_to: null,
        body:
          `bus chat started: channel=${ctx.channel} ` +
          `first_speaker=${v.firstSpeaker}` +
          (payload.topic ? ` topic=${JSON.stringify(payload.topic).slice(0, 300)}` : ""),
        verdict: "control_started",
        bus,
      });
    } else if (v.kind === "ended" && payload?.type === "control") {
      // a relayed terminal control — ours or a prior crashed auditor's
      bus.control = "chat_ended";
      bus.reason = v.reason;
      bus.terminal_seq = v.terminalSeq;
      await emit({
        actor: m.author,
        type: "bus_record",
        round: 0,
        reply_to: null,
        body: `reason=${v.reason} — channel=${ctx.channel} terminal_seq=${v.terminalSeq} (auditor-imposed)`,
        verdict: "control_ended",
        bus,
      });
    } else {
      // not protocol-valid — still one record per wire message, with the why
      await emit({
        actor: m.author,
        type: "bus_record",
        round: 0,
        reply_to: null,
        body:
          payload?.type === "turn"
            ? escapeMarkers(applyRedaction(payload.body, config))
            : plaintext !== null
              ? escapeMarkers(applyRedaction(plaintext, config))
              : m.ct, // undecryptable: the ciphertext, verbatim
        verdict: "ignored",
        ignore_why: v.kind === "ignore" ? v.why : "bad_shape",
        unstructured: plaintext === null || undefined,
        bus,
      });
    }
    return v;
  };

  /** Fetch and process messages beyond the cursor, up to and including maxSeq. */
  const drain = async (maxSeq: number): Promise<void> => {
    while (cursor < maxSeq) {
      const res = await client.poll(cursor, 0);
      const batch = res.messages.filter((m) => m.seq <= maxSeq);
      for (const m of batch) {
        await processMessage(m);
        cursor = Math.max(cursor, m.seq);
      }
      if (!batch.length) return; // cannot make progress
    }
  };

  /** Process everything currently beyond the cursor (single pass). */
  const drainAvailable = async (): Promise<void> => {
    const res = await client.poll(cursor, 0);
    for (const m of res.messages) {
      await processMessage(m);
      cursor = Math.max(cursor, m.seq);
    }
  };

  /** Auditor-imposed termination: publish chat_ended, then drain through it. */
  const endChat = async (
    reason: ChatEndReason,
    detail: string,
    terminalSeqOverride?: number
  ): Promise<ChatSummary> => {
    if (ending) return finish(reason, detail);
    ending = true;
    // terminal_seq = last accepted turn at decision time (0 when none). The
    // msg_id is deterministic from {channel_epoch, terminal_seq, reason}.
    const terminalSeq = terminalSeqOverride ?? validator.lastAcceptedSeq ?? 0;
    const msgId = endedMsgId(ctx.epoch, terminalSeq, reason);
    // Claim the end locally BEFORE draining: the drain may observe a stale
    // or erroneous chat_ended on the wire (e.g. from a crashed auditor),
    // which must not override the reason decided here. With validator.ended
    // set, relayed chat_ended controls are ignored by the validator.
    validator.ended = { reason, terminalSeq };
    const ack = await publishWithRetry(msgId, encodeEnded(reason, terminalSeq));
    if (ack) {
      // Commit every wire message through the terminal control — the relayed
      // chat_ended itself lands as a bus_record, and a protocol-valid turn
      // racing the close is still evaluated over the log.
      try {
        await drain(ack.seq);
      } catch {
        // best effort: a resume drains the rest
      }
    }
    // Commit the end decision locally unless the drain already observed our
    // control on the wire (commitEnded is idempotent by msg_id).
    await commitEnded(reason, terminalSeq, msgId);
    // The auditor's own decision stands — report it, not a stale wire control's.
    return finish(reason, detail);
  };

  // Restarting into an already-ended chat: re-publish (above), commit any
  // post-close messages as ignored records (validator.ended is set), report.
  if (committedEnd || validator.ended) {
    try {
      await drainAvailable();
    } catch {
      // relay may be gone; the committed end stands
    }
    return finish(
      ((committedEnd?.bus?.reason ?? validator.ended?.reason) as ChatEndReason) ??
        "idle_timeout"
    );
  }

  // The turn stream may already contain a completed close handshake that the
  // live loop never saw (e.g. this auditor was down when it happened). A
  // later turn must not erase the agreement — reconstruct it from the log.
  const handshake = findCompletedHandshake(accepted);
  if (handshake) {
    return await endChat(
      "agreed",
      `close proposed by ${handshake.proposer}; closing turn by ${handshake.closer} at seq ${handshake.seq} (reconstructed from log)`,
      handshake.seq
    );
  }

  // --- main subscribe loop ---
  try {
    for (;;) {
      if (opts.signal?.aborted) break;

      // two-regime idle: before the first accepted turn the pre-first-turn
      // deadline owns the clock (participants may still be connecting);
      // after it, the post-first-turn deadline applies
      const postFirst = accepted.length > 0;
      const deadlineMs = postFirst ? idleTimeoutMs : preFirstTurnTimeoutMs;
      const idleLeft = deadlineMs - (Date.now() - lastAcceptedAt);
      if (idleLeft <= 0) {
        return await endChat(
          postFirst ? "idle_timeout" : "idle_before_first_turn",
          postFirst
            ? `no accepted turn within ${idleTimeoutMs}ms`
            : `no accepted turn within ${preFirstTurnTimeoutMs}ms of chat start`
        );
      }

      // If the opening control hasn't been observed yet (e.g. the relay lost
      // it between publish and commit), re-publish — msg_id dedupe keeps the
      // retry a no-op when it did land.
      if (validator.firstSpeaker === null && Date.now() - lastOpenPublish > 2_000) {
        await publishOpening();
        lastOpenPublish = Date.now();
      }

      let batch: RelayMessage[];
      try {
        const res = await client.poll(cursor, Math.max(1, Math.min(pollWaitMs, idleLeft)));
        batch = res.messages;
      } catch (e) {
        const status = (e as BusError).status;
        if (status === 401 || status === 404) throw e; // token revoked / channel gone
        await sleep(Math.min(250, pollWaitMs));
        continue;
      }

      for (const m of batch) {
        // abort is honored between messages — a fetched-but-unprocessed
        // message is simply re-polled after restart (cursor not advanced)
        if (opts.signal?.aborted) break;
        await processMessage(m);
        cursor = Math.max(cursor, m.seq);

        if (ending || validator.ended) continue;
        // End conditions on the accepted-turn stream only — spam and
        // duplicates are ignored records, never budget or history.
        const end = endCondition(accepted, maxTurns);
        if (end) return await endChat(end.reason, end.detail);
      }
      // validator.ended is assigned inside closures (processMessage/endChat)
      // that CFA can't see — the earlier early-return narrowed it to null, so
      // re-widen it here or the check below reads as `never`.
      const endedState = validator.ended as TurnValidator["ended"];
      if (endedState) {
        return finish(
          (endedState.reason as ChatEndReason) ?? "idle_timeout",
          "chat_ended adopted from relayed control"
        );
      }
    }
  } finally {
    bb.renderView(meta.id);
  }

  return finish(null);
}
