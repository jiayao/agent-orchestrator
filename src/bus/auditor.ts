// Bus auditor (v0.2): subscribes to the channel, validates, commits.
// Commits two record kinds to the blackboard: bus_raw (everything the relay
// served) and turn (passing the deterministic validation rule). Only accepted
// turns drive budgets, history, and end reasons. The auditor owns the idle
// deadline and imposes termination. Two regimes: before the first accepted
// turn lands, a long pre-first-turn deadline applies (default 1h) and firing
// it ends the chat as idle_before_first_turn — the idle clock must not start
// on a chat that never began. After the first accepted turn, the regular
// idle_timeout (default 120s) applies, anchored on the last accepted turn.
// On restart the regime is re-derived from already-committed turns, so a
// restarted auditor never re-enters the pre-first-turn regime on a live chat.
// auditor-imposed — the log says so.
//
// Crash discipline: the cursor is derived as max committed relay seq in
// events.jsonl — one file, no separate cursor state. Control messages carry
// deterministic msg_ids derived from {channel_epoch, terminal_seq, reason};
// on startup the auditor re-publishes any committed terminal control, and
// relay + participant dedupe make the replay harmless.

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
  type RelayMessage,
  type Validation,
} from "./protocol.ts";
import { applyRedaction } from "../spawn.ts";
import { escapeMarkers, type ChatSummary } from "../chat.ts";

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
  idleTimeoutMs?: number; // default 120s; applies after the first accepted turn
  preFirstTurnTimeoutMs?: number; // default 1h; applies before the first accepted turn
  maxTurns?: number; // substantive cap -> chat_ended{expired}
  pollWaitMs?: number; // per-request long-poll wait, default 1s
  signal?: AbortSignal;
  onEvent?: (ev: TeamEvent) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runBusAuditor(
  bb: Blackboard,
  config: TeamConfig,
  meta: TaskMeta,
  client: BusClient,
  ctx: BusChatContext,
  opts: BusAuditorOptions = {}
): Promise<ChatSummary> {
  const idleTimeoutMs = opts.idleTimeoutMs ?? 120_000;
  const preFirstTurnTimeoutMs = opts.preFirstTurnTimeoutMs ?? 3_600_000;
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

  // Cursor: max committed relay seq. Rebuild deterministic validation state
  // by replaying committed bus events through the same rule.
  let cursor = deriveCursor(bb.readEvents(meta.id));
  const validator = new TurnValidator(ctx.agents);
  validator.replayCommitted(bb.readEvents(meta.id));

  const committed = bb.readEvents(meta.id);
  const committedStart = committed.find(
    (e) => e.type === "chat_started" && e.bus?.control === "chat_started"
  );
  const committedEnd = committed.find(
    (e) => e.type === "chat_ended" && e.bus?.control === "chat_ended"
  );
  const committedTurns = committed.filter((e) => e.type === "turn" && e.bus);

  meta.chat ??= {
    topic: ctx.topic,
    max_turns: maxTurns,
    history_budget_chars: config.chat.history_budget_chars,
    console_timeout_ms: config.chat.console_timeout_ms,
    substantive_turns: 0,
    total_turns: 0,
  };

  // Live counters — only accepted turns move them.
  let totalTurns = committedTurns.length;
  let substantive = committedTurns.filter((t) => t.signal !== "pass").length;
  const acceptedSignals = committedTurns.map((t) => t.signal ?? "continue");
  // Idle clock: two regimes. The post-first-turn clock anchors on the last
  // committed accepted turn; the pre-first-turn clock anchors on auditor
  // start. hasAcceptedTurn is re-derived from already-committed turns so a
  // restarted auditor (resume / adopt) never re-enters the pre-first-turn
  // regime on a live chat.
  const bootAt = Date.now();
  let hasAcceptedTurn = committedTurns.length > 0;
  let lastAcceptedAt = committedTurns.length
    ? Date.parse(committedTurns[committedTurns.length - 1].ts)
    : bootAt;

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
    const reason = committedEnd.bus!.reason ?? "idle_timeout";
    const terminalSeq = committedEnd.bus!.terminal_seq ?? 0;
    await client
      .publish(committedEnd.bus!.msg_id, encodeEnded(reason, terminalSeq))
      .catch(() => {});
  }

  const finish = (reason: ChatEndReason | null, detail?: string): ChatSummary => {
    meta.chat!.substantive_turns = substantive;
    meta.chat!.total_turns = totalTurns;
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
      total_turns: totalTurns,
    };
  };

  let ending = false;

  const commitRaw = async (m: RelayMessage, undecryptable: boolean) =>
    emit({
      actor: m.author,
      type: "bus_raw",
      round: 0,
      reply_to: null,
      body: m.ct, // the relayed ciphertext, preserved verbatim
      unstructured: undecryptable || undefined,
      bus: {
        channel: ctx.channel,
        seq: m.seq,
        msg_id: m.msg_id,
        author: m.author,
        payload_hash: hashPayload(m.ct), // hash of the payload as relayed
      },
    });

  const commitEnded = async (reason: string, terminalSeq: number, seq: number, msgId: string) => {
    const existing = bb
      .readEvents(meta.id)
      .find((e) => e.type === "chat_ended" && e.bus?.msg_id === msgId);
    if (existing) return;
    await emit({
      actor: "orchestrator",
      type: "chat_ended",
      round: 0,
      reply_to: null,
      body: `reason=${reason} — channel=${ctx.channel} terminal_seq=${terminalSeq} (auditor-imposed)`,
      bus: {
        channel: ctx.channel,
        seq,
        msg_id: msgId,
        author: "orchestrator",
        control: "chat_ended",
        reason,
        terminal_seq: terminalSeq,
      },
    });
  };

  /**
   * Process one relayed message: raw record always; an accepted turn or an
   * adopted chat_ended on top. Returns the validation verdict.
   */
  const processMessage = async (m: RelayMessage): Promise<Validation> => {
    let plaintext: string | null = null;
    try {
      plaintext = client.decrypt(m);
    } catch {
      plaintext = null; // tampered or wrong key — raw only
    }
    const payload = plaintext !== null ? decodePayload(plaintext) : null;
    await commitRaw(m, plaintext === null);

    const v = validator.ingest({ seq: m.seq, author: m.author }, payload);

    if (v.kind === "turn" && payload?.type === "turn") {
      const sig = payload.signal ?? "continue";
      await emit({
        actor: m.author,
        type: "turn",
        round: 0,
        reply_to: null,
        body: escapeMarkers(applyRedaction(payload.body, config)),
        signal: sig,
        bus: {
          channel: ctx.channel,
          seq: m.seq,
          msg_id: m.msg_id,
          author: m.author,
          in_reply_to: payload.in_reply_to,
          payload_hash: hashPayload(plaintext!),
        },
      });
      acceptedSignals.push(sig);
      totalTurns += 1;
      if (sig !== "pass") substantive += 1;
      lastAcceptedAt = Date.now();
      if (!hasAcceptedTurn) {
        // First accepted turn: the pre-first-turn regime ends and the
        // regular idle clock arms. Emit the flip so operators watching the
        // event log can see which deadline is in force.
        hasAcceptedTurn = true;
        await emit({
          actor: "orchestrator",
          type: "note",
          round: 0,
          reply_to: null,
          body: `first accepted turn committed; post-first-turn idle timer armed (${idleTimeoutMs}ms)`,
        });
      }
      meta.chat!.substantive_turns = substantive;
      meta.chat!.total_turns = totalTurns;
      bb.writeMeta(meta);
    } else if (v.kind === "ended" && payload?.type === "control") {
      // An orchestrator-authored chat_ended we didn't just publish (e.g. a
      // prior crashed auditor's) is adopted: termination is auditor-imposed.
      await commitEnded(v.reason, v.terminalSeq, m.seq, m.msg_id);
    } else if (v.kind === "started" && payload?.type === "control") {
      // Relayed opening control we haven't committed (crash between publish
      // and commit): adopt it.
      const existing = bb
        .readEvents(meta.id)
        .find((e) => e.type === "chat_started" && e.bus?.msg_id === m.msg_id);
      if (!existing) {
        await emit({
          actor: "orchestrator",
          type: "chat_started",
          round: 0,
          reply_to: null,
          body:
            `bus chat started (adopted): channel=${ctx.channel} ` +
            `first_speaker=${v.firstSpeaker}`,
          bus: {
            channel: ctx.channel,
            seq: m.seq,
            msg_id: m.msg_id,
            author: "orchestrator",
            control: "chat_started",
            first_speaker: v.firstSpeaker,
            // record what the wire actually carried, not what we would have sent
            ...(payload.roster ? { roster: payload.roster } : {}),
          },
        });
      }
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

  /** Auditor-imposed termination: publish chat_ended, then commit it. */
  const endChat = async (reason: ChatEndReason, detail: string): Promise<ChatSummary> => {
    if (ending) return finish(reason, detail);
    ending = true;
    // terminal_seq = last accepted turn at decision time (0 when none). The
    // msg_id is deterministic from {channel_epoch, terminal_seq, reason}.
    const terminalSeq = validator.lastAcceptedSeq ?? 0;
    const msgId = endedMsgId(ctx.epoch, terminalSeq, reason);
    const ack = await publishWithRetry(msgId, encodeEnded(reason, terminalSeq));
    if (ack) {
      // Commit raws for everything that landed before the terminal control —
      // a protocol-valid turn racing the close is still evaluated by the
      // deterministic rule over the log — then the control msg itself.
      try {
        await drain(ack.seq);
      } catch {
        // best effort: the committed record stands; a resume drains the rest
      }
      validator.ended ??= { reason, terminalSeq };
      await commitEnded(reason, terminalSeq, ack.seq, msgId);
    } else {
      // Relay unreachable: commit anyway — startup re-publish repairs it.
      await commitEnded(reason, terminalSeq, 0, msgId);
    }
    return finish(reason, detail);
  };

  // Restarting into an already-ended chat: re-publish (above), commit any
  // post-close messages as raw-only (validator.ended is set), report.
  if (committedEnd || validator.ended) {
    try {
      await drainAvailable();
    } catch {
      // relay may be gone; the committed end stands
    }
    return finish((committedEnd?.bus?.reason as ChatEndReason) ?? validator.ended?.reason as ChatEndReason ?? "idle_timeout");
  }

  // --- main subscribe loop ---
  try {
    for (;;) {
      if (opts.signal?.aborted) break;

      // Two-regime idle check: before the first accepted turn the long
      // pre-first-turn deadline applies (a chat that never began must not
      // be killed on the 120s clock); after it, the regular idle clock.
      const deadlineLeft = hasAcceptedTurn
        ? idleTimeoutMs - (Date.now() - lastAcceptedAt)
        : preFirstTurnTimeoutMs - (Date.now() - bootAt);
      if (deadlineLeft <= 0) {
        return hasAcceptedTurn
          ? await endChat("idle_timeout", `no accepted turn within ${idleTimeoutMs}ms`)
          : await endChat(
              "idle_before_first_turn",
              `no accepted turn within ${preFirstTurnTimeoutMs}ms of auditor start`
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
        const res = await client.poll(cursor, Math.max(1, Math.min(pollWaitMs, deadlineLeft)));
        batch = res.messages;
      } catch (e) {
        const status = (e as BusError).status;
        if (status === 401 || status === 404) throw e; // token revoked / channel gone
        await sleep(Math.min(250, pollWaitMs));
        continue;
      }

      for (const m of batch) {
        await processMessage(m);
        cursor = Math.max(cursor, m.seq);

        if (ending || validator.ended) continue;
        // End conditions on accepted turns only — spam and duplicates are
        // raw records, never budget or history.
        const lastSig = acceptedSignals[acceptedSignals.length - 1];
        const prevSig = acceptedSignals[acceptedSignals.length - 2];
        if (lastSig === "abort") {
          return await endChat("aborted", `abort signaled by ${m.author}`);
        }
        if (prevSig === "propose_close" && acceptedSignals.length >= 2) {
          return await endChat("agreed", `close proposed; closing turn by ${m.author}`);
        }
        // a pending propose_close earns the peer an answer before expiry
        if (substantive >= maxTurns && lastSig !== "propose_close") {
          return await endChat("expired", `max_turns=${maxTurns} reached`);
        }
      }
      const endedState = validator.ended as { reason: string; terminalSeq: number } | null;
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
