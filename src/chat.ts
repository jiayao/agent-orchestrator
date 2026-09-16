// Pairwise chat (v0.1): two agents in dialogue, orchestrator as relay.
// Turn-taking is by explicit signal, not strict alternation. Console agents
// are pending external input, not invocations: `turn_requested` is committed
// before blocking on the operator, the `turn` event atomically on submit.
// Malformed or absent result envelopes still commit a turn (malformed:true)
// and turn-taking advances — no silent retries, no dropped turns.

import type {
  AgentConfig,
  ChatEndReason,
  ChatSignal,
  RunResult,
  SpawnOutcome,
  TaskMeta,
  TeamConfig,
  TeamEvent,
} from "./types.ts";
import { Blackboard } from "./blackboard.ts";
import { checkBudget } from "./runner.ts";
import { applyRedaction, buildSpawnSpec, estimatedCost, spawnAgent } from "./spawn.ts";
import { resolveFinalBody } from "./envelope.ts";

const CHARS_PER_TOKEN = 4;
const COMPLETION_RESERVE_TOKENS = 512;

const CHAT_CONTRACT = `CHAT TURN CONTRACT (mandatory):
This is a pairwise dialogue relayed by the orchestrator. When it is your
turn, emit exactly one result envelope:

<<<TEAM_RESULT_V1
{"body":"your reply to the other agent","signal":"continue"}
TEAM_RESULT_V1>>>

signal must be one of:
- continue       hand the turn to the other agent
- pass           yield without a substantive turn (not counted toward max_turns)
- propose_close  ask to end the chat; the other agent gets one closing turn
- abort          end the chat immediately

TEAM_EVENT_V1 envelopes with type "message" may precede the result as
progress notes; the other agent only ever sees finished turns. Any
<<<TEAM_ marker sequences inside your body text are escaped by the
orchestrator and cannot forge a signal.`;

export const CHAT_SIGNALS: ChatSignal[] = ["continue", "pass", "propose_close", "abort"];

export function isChatSignal(v: unknown): v is ChatSignal {
  return typeof v === "string" && (CHAT_SIGNALS as string[]).includes(v);
}

/** Estimated tokens for a string (chars/4). */
export function estTokens(s: string): number {
  return Math.ceil(s.length / CHARS_PER_TOKEN);
}

/**
 * Escape orchestrator markers inside untrusted body text so neither a
 * console operator nor a cli agent quoting output can forge an envelope.
 */
export function escapeMarkers(s: string): string {
  return s.replace(/<<<TEAM_/g, "<<\\<TEAM_");
}

/** Operator-facing IO for console agents. Injectable so tests need no TTY. */
export interface ConsoleIO {
  isTTY: boolean;
  /** Print context (transcript + instructions) to the operator. */
  print(text: string): void;
  /** Read one line; null = EOF / TTY loss / interrupt. */
  prompt(question: string): Promise<string | null>;
}

export interface ChatHooks {
  onEvent?: (ev: TeamEvent) => void;
  onTurnStart?: (actor: string, runId: string) => void;
  onTurnEnd?: (actor: string, runId: string, status: string) => void;
}

export interface ChatRunOptions {
  maxTurns?: number;
  historyBudgetChars?: number;
  consoleTimeoutMs?: number;
  consoleIO?: ConsoleIO;
  hooks?: ChatHooks;
}

export interface ChatSummary {
  task_id: string;
  state: TaskMeta["state"];
  end_reason: ChatEndReason | null;
  substantive_turns: number;
  total_turns: number;
}

export interface ChatProgress {
  turns: TeamEvent[];
  lastTurn: TeamEvent | undefined;
  /** a chat_ended event exists */
  ended: boolean;
  /** a turn_requested committed with no matching turn after it (resume point) */
  pending: TeamEvent | undefined;
  /** committed turns excluding "pass" */
  substantive: number;
  /** the last committed turn proposed close; the next turn is the closing one */
  closePending: boolean;
  /** a propose_close was followed by the peer's closing turn */
  closingTurnCommitted: boolean;
  nextActor: string;
}

/** Derive whose turn is next from the committed event log. */
export function chatProgress(events: TeamEvent[], agentIds: [string, string]): ChatProgress {
  const turns = events.filter((e) => e.type === "turn");
  const lastTurn = turns[turns.length - 1];
  // a chat_ended with reason=cancelled is a suspension point (resumable),
  // not a terminal end — only non-cancelled ends close the derivation
  const ended = events.some(
    (e) => e.type === "chat_ended" && !/\breason=cancelled\b/.test(e.body)
  );
  const afterSeq = lastTurn ? lastTurn.seq : -1;
  let pending: TeamEvent | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "turn_requested" && events[i].seq > afterSeq) {
      pending = events[i];
      break;
    }
  }
  const substantive = turns.filter((t) => t.signal !== "pass").length;
  const closePending = lastTurn?.signal === "propose_close";
  const closingTurnCommitted =
    turns.length >= 2 && turns[turns.length - 2].signal === "propose_close";
  let nextActor: string;
  if (pending) nextActor = pending.actor;
  else if (!lastTurn) nextActor = agentIds[0];
  else nextActor = lastTurn.actor === agentIds[0] ? agentIds[1] : agentIds[0];
  return { turns, lastTurn, ended, pending, substantive, closePending, closingTurnCommitted, nextActor };
}

export interface PackedChatPrompt {
  prompt: string;
  /** contiguous oldest turn-event range dropped from the transcript */
  omitted: { first: string; last: string; count: number } | null;
}

/**
 * Per-turn prompt: pinned seed (topic + identity + role + format contract —
 * never truncated) + transcript of whole turns, bounded by
 * history_budget_chars enforced in estimated tokens (prompt + completion).
 * Oldest whole turns are dropped first.
 */
export function packChatPrompt(input: {
  config: TeamConfig;
  agent: AgentConfig;
  peerId: string;
  topic: string;
  turns: TeamEvent[];
  historyBudgetChars: number;
}): PackedChatPrompt {
  const { config, agent } = input;
  const role = config.roles.find((r) => r.name === agent.role);
  const seed = [
    `You are agent "${agent.id}" on team "${config.team}"${agent.model ? ` (model: ${agent.model})` : ""}.`,
    `You are in a pairwise chat with agent "${input.peerId}".`,
    "",
    "ROLE INSTRUCTIONS:",
    role?.instructions.trim() || "(no role instructions configured)",
    "",
    CHAT_CONTRACT,
    "",
    `TOPIC: ${escapeMarkers(input.topic)}`,
  ].join("\n");
  const tail =
    `IT IS YOUR TURN, ${agent.id}. Reply to ${input.peerId}. Emit exactly ` +
    `one TEAM_RESULT_V1 envelope carrying your body and signal.`;

  const budgetTokens = Math.max(0, Math.floor(input.historyBudgetChars / CHARS_PER_TOKEN));
  let avail = budgetTokens - estTokens(seed) - estTokens(tail) - COMPLETION_RESERVE_TOKENS;

  const rendered = input.turns.map(
    (t) =>
      `[${t.event_id}] ${t.actor} (signal=${t.signal ?? "continue"}${t.malformed ? " malformed" : ""})\n${t.body}`
  );
  const keep: string[] = [];
  let drop = 0;
  for (let i = rendered.length - 1; i >= 0; i--) {
    const cost = estTokens(rendered[i]);
    if (cost > avail) {
      drop = i + 1;
      break;
    }
    avail -= cost;
    keep.unshift(rendered[i]);
  }

  const omitted =
    drop > 0
      ? { first: input.turns[0].event_id, last: input.turns[drop - 1].event_id, count: drop }
      : null;

  const parts = [seed, "", "TRANSCRIPT SO FAR (whole turns only; ids are stable):", ""];
  if (omitted) {
    parts.push(`[orchestrator: ${omitted.count} oldest turn(s) omitted, events ${omitted.first}..${omitted.last}]`, "");
  }
  if (keep.length) parts.push(keep.join("\n\n"));
  else if (!omitted) parts.push("(no prior turns)");
  parts.push("", tail);
  return { prompt: parts.join("\n"), omitted };
}

interface ParsedTurn {
  body: string;
  signal: ChatSignal;
  malformed: boolean;
}

/** Body + signal for a finished cli turn. Missing/broken envelope -> malformed. */
export function parseChatResult(outcome: SpawnOutcome): ParsedTurn {
  const p = outcome.resultPayload;
  if (p !== null && typeof p === "object" && !Array.isArray(p)) {
    const j = p as Record<string, unknown>;
    const sig = isChatSignal(j.signal) ? j.signal : null;
    const bodyText =
      typeof j.body === "string" ? j.body : typeof j.summary === "string" ? j.summary : null;
    const malformed = sig === null || (bodyText === null && sig !== "pass");
    return {
      body: bodyText ?? JSON.stringify(j),
      signal: sig ?? "continue",
      malformed,
    };
  }
  const fb = resolveFinalBody(outcome.stdout);
  return {
    body: fb.body.trim().length ? fb.body : `(no usable output; run status ${outcome.status})`,
    signal: "continue",
    malformed: true,
  };
}

const CONSOLE_TIMEOUT = Symbol("console-timeout");

type ConsoleAnswer = { ok: true; body: string; signal: ChatSignal } | { ok: false; reason: string };

/**
 * Block on the operator. The turn commits atomically on submit; on timeout,
 * EOF, TTY loss, or interrupt the uncommitted input is discarded and the
 * caller ends the chat cancelled.
 */
async function consoleTurn(
  io: ConsoleIO,
  actorId: string,
  promptText: string,
  timeoutMs: number
): Promise<ConsoleAnswer> {
  io.print(
    `\n=== your turn (${actorId}) ===\n\n${promptText}\n\n` +
      `--- operator input ---\n` +
      `Type your reply; a line containing only "." submits, then choose a signal.\n` +
      `Ctrl-C / Ctrl-D / timeout (${Math.round(timeoutMs / 1000)}s) cancels the chat (resumable).\n`
  );
  const deadline = Date.now() + timeoutMs;
  const ask = async (q: string): Promise<string | null | typeof CONSOLE_TIMEOUT> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return CONSOLE_TIMEOUT;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof CONSOLE_TIMEOUT>((res) => {
      timer = setTimeout(() => res(CONSOLE_TIMEOUT), remaining);
    });
    try {
      return await Promise.race([io.prompt(q), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const lines: string[] = [];
  for (;;) {
    const line = await ask(`chat:${actorId}> `);
    if (line === CONSOLE_TIMEOUT) {
      return { ok: false, reason: `console turn timed out after ${timeoutMs}ms` };
    }
    if (line === null) {
      return { ok: false, reason: "operator input ended (EOF, TTY loss, or interrupt)" };
    }
    if (line === ".") break;
    lines.push(line);
  }
  const sigLine = await ask(`signal [continue|pass|close|abort] (empty=continue)> `);
  if (sigLine === CONSOLE_TIMEOUT) {
    return { ok: false, reason: `console turn timed out after ${timeoutMs}ms` };
  }
  if (sigLine === null) {
    return { ok: false, reason: "operator input ended (EOF, TTY loss, or interrupt)" };
  }
  const s = sigLine.trim().toLowerCase();
  const signal: ChatSignal =
    s === "pass" ? "pass"
    : s === "close" || s === "propose_close" ? "propose_close"
    : s === "abort" ? "abort"
    : "continue";
  return { ok: true, body: lines.join("\n"), signal };
}

/**
 * Run (or resume) a pairwise chat. The event log is the source of truth:
 * resume re-prompts the actor of a dangling turn_requested and never
 * re-invokes a completed turn.
 */
export async function runChat(
  bb: Blackboard,
  config: TeamConfig,
  meta: TaskMeta,
  agents: AgentConfig[],
  opts: ChatRunOptions = {}
): Promise<ChatSummary> {
  if (meta.kind !== "chat") throw new Error(`task ${meta.id} is kind ${meta.kind}, not chat`);
  if (agents.length !== 2) throw new Error("chat requires exactly two agents");
  const io = opts.consoleIO;
  if (agents.some((a) => a.kind === "console") && (!io || !io.isTTY)) {
    throw new Error(
      "an agent in this chat is kind=console but stdin is not a TTY; " +
        "console turns need a live operator — run interactively"
    );
  }
  const ids: [string, string] = [agents[0].id, agents[1].id];
  const maxTurns = opts.maxTurns ?? meta.chat?.max_turns ?? config.chat.max_turns;
  const historyBudgetChars =
    opts.historyBudgetChars ?? meta.chat?.history_budget_chars ?? config.chat.history_budget_chars;
  const consoleTimeoutMs =
    opts.consoleTimeoutMs ?? meta.chat?.console_timeout_ms ?? config.chat.console_timeout_ms;

  meta.chat ??= {
    topic: bb.readArtifact(meta.id),
    max_turns: maxTurns,
    history_budget_chars: historyBudgetChars,
    console_timeout_ms: consoleTimeoutMs,
    substantive_turns: 0,
    total_turns: 0,
  };

  const emit = async (ev: Parameters<Blackboard["appendEvent"]>[1]) => {
    const full = await bb.appendEvent(meta.id, ev);
    opts.hooks?.onEvent?.(full);
    return full;
  };

  if (!bb.readEvents(meta.id).some((e) => e.type === "chat_started")) {
    await emit({
      actor: "orchestrator",
      type: "chat_started",
      round: 0,
      reply_to: null,
      body:
        `chat started: agents=${ids.join(",")} max_turns=${maxTurns} ` +
        `history_budget_chars=${historyBudgetChars} topic=${JSON.stringify(meta.chat.topic).slice(0, 300)}`,
    });
  }
  meta.state = "running";
  meta.rounds_planned = maxTurns;
  bb.writeMeta(meta);
  bb.renderView(meta.id);

  const finish = async (reason: ChatEndReason, detail: string): Promise<ChatSummary> => {
    const turns = bb.readEvents(meta.id).filter((e) => e.type === "turn");
    meta.chat!.substantive_turns = turns.filter((t) => t.signal !== "pass").length;
    meta.chat!.total_turns = turns.length;
    meta.chat!.end_reason = reason;
    meta.completed_rounds = meta.chat!.substantive_turns;
    // honest taxonomy: only a peer-confirmed close is "completed"; expired and
    // budget are not successes, cancelled stays resumable
    meta.state =
      reason === "agreed" ? "completed" : reason === "cancelled" ? "cancelled" : "failed";
    meta.ended_at = new Date().toISOString();
    bb.writeMeta(meta);
    await emit({
      actor: "orchestrator",
      type: "chat_ended",
      round: 0,
      reply_to: null,
      body: `reason=${reason} — ${detail}`,
    });
    bb.renderView(meta.id);
    return {
      task_id: meta.id,
      state: meta.state,
      end_reason: reason,
      substantive_turns: meta.chat!.substantive_turns,
      total_turns: meta.chat!.total_turns,
    };
  };

  for (;;) {
    const events = bb.readEvents(meta.id);
    const prog = chatProgress(events, ids);
    if (prog.ended) {
      return {
        task_id: meta.id,
        state: meta.state,
        end_reason: meta.chat?.end_reason ?? null,
        substantive_turns: meta.chat?.substantive_turns ?? prog.substantive,
        total_turns: meta.chat?.total_turns ?? prog.turns.length,
      };
    }
    if (prog.lastTurn?.signal === "abort") {
      return finish("aborted", `abort signaled by ${prog.lastTurn.actor}`);
    }
    if (prog.closingTurnCommitted) {
      return finish(
        "agreed",
        `close proposed by ${prog.turns[prog.turns.length - 2].actor}; ` +
          `closing turn by ${prog.lastTurn!.actor}`
      );
    }
    if (!prog.closePending && prog.substantive >= maxTurns) {
      return finish("expired", `max_turns=${maxTurns} reached`);
    }

    const actorId = prog.nextActor;
    const agent = agents.find((a) => a.id === actorId);
    if (!agent) {
      throw new Error(`task ${meta.id} references agent ${JSON.stringify(actorId)} not in this chat`);
    }
    const peerId = actorId === ids[0] ? ids[1] : ids[0];

    const budgetHit = checkBudget(meta, config, { agents: agent.kind === "cli" ? [agent] : [] });
    if (budgetHit) return finish("budget", budgetHit);

    if (!prog.pending) {
      await emit({
        actor: actorId,
        type: "turn_requested",
        round: 0,
        reply_to: null,
        body: `turn requested from ${actorId}${prog.closePending ? " (closing turn)" : ""}`,
      });
    }

    const pack = packChatPrompt({
      config,
      agent,
      peerId,
      topic: meta.chat!.topic,
      turns: prog.turns,
      historyBudgetChars,
    });
    if (pack.omitted) {
      await emit({
        actor: "orchestrator",
        type: "history_truncated",
        round: 0,
        reply_to: null,
        body:
          `omitted events ${pack.omitted.first}..${pack.omitted.last} ` +
          `(${pack.omitted.count} turn(s)) from ${actorId}'s prompt: history_budget_chars=${historyBudgetChars}`,
        claims: [pack.omitted.first, pack.omitted.last],
      });
    }

    if (agent.kind === "console") {
      const res = await consoleTurn(io!, actorId, pack.prompt, consoleTimeoutMs);
      if (!res.ok) return finish("cancelled", res.reason);
      await commitTurn(bb, config, meta, actorId, res.body, res.signal, false, undefined, opts.hooks);
      continue;
    }

    // cli turn: one invocation through the spawn engine
    const rid = `turn-${prog.turns.length + 1}-${actorId}`;
    bb.initRunDir(meta.id, rid);
    const spec = buildSpawnSpec(agent, config, pack.prompt);
    bb.writeRunFile(meta.id, rid, "request.json", {
      agent_id: actorId,
      task_id: meta.id,
      kind: "chat_turn",
      closing: prog.closePending,
      spec,
    });
    bb.writeRunFile(meta.id, rid, "prompt.txt", pack.prompt);
    opts.hooks?.onTurnStart?.(actorId, rid);
    const startedAt = new Date();
    const outcome = await spawnAgent(spec, pack.prompt, config, {
      onEnvelope: (env) => {
        // TEAM_EVENT_V1 partials (type "message") go to the log/view only;
        // the peer sees finished turns.
        if (env.kind !== "TEAM_EVENT_V1") return;
        void (async () => {
          const j = env.json;
          const obj = j !== null && typeof j === "object" && !Array.isArray(j)
            ? (j as Record<string, unknown>)
            : null;
          await emit({
            actor: actorId,
            type: obj && typeof obj.type === "string" ? obj.type : "message",
            round: 0,
            reply_to: obj && typeof obj.reply_to === "string" ? obj.reply_to : null,
            body: applyRedaction(
              obj && typeof obj.body === "string" ? obj.body : env.raw,
              config
            ),
            unstructured: obj === null,
            run_id: rid,
          });
        })();
      },
    });
    bb.writeRunFile(meta.id, rid, "stdout.txt", outcome.stdout);
    bb.writeRunFile(meta.id, rid, "stderr.txt", outcome.stderr);
    const { cost, source } = estimatedCost(agent);
    const result: RunResult = {
      run_id: rid,
      task_id: meta.id,
      agent_id: actorId,
      round: 0,
      status: outcome.status,
      exit_code: outcome.exit_code,
      signal: outcome.signal,
      started_at: startedAt.toISOString(),
      ended_at: new Date().toISOString(),
      latency_ms: outcome.latency_ms,
      timed_out: outcome.timed_out,
      output_limited: outcome.output_limited,
      cost_usd: cost,
      cost_source: source === "estimated" ? "estimated" : "unknown",
    };
    bb.writeRunFile(meta.id, rid, "result.json", result);
    meta.runs_completed += 1;
    if (cost !== null) meta.estimated_cost_usd += cost;
    bb.writeMeta(meta);
    opts.hooks?.onTurnEnd?.(actorId, rid, outcome.status);

    const parsed = parseChatResult(outcome);
    await commitTurn(
      bb, config, meta, actorId, parsed.body, parsed.signal, parsed.malformed, rid, opts.hooks
    );
  }
}

async function commitTurn(
  bb: Blackboard,
  config: TeamConfig,
  meta: TaskMeta,
  actorId: string,
  body: string,
  signal: ChatSignal,
  malformed: boolean,
  runId?: string,
  hooks?: ChatHooks
): Promise<TeamEvent> {
  const ev = await bb.appendEvent(meta.id, {
    actor: actorId,
    type: "turn",
    round: 0,
    reply_to: null,
    body: escapeMarkers(applyRedaction(body, config)),
    signal,
    malformed: malformed || undefined,
    run_id: runId,
  });
  hooks?.onEvent?.(ev);
  const turns = bb.readEvents(meta.id).filter((e) => e.type === "turn");
  meta.chat!.substantive_turns = turns.filter((t) => t.signal !== "pass").length;
  meta.chat!.total_turns = turns.length;
  meta.completed_rounds = meta.chat!.substantive_turns;
  bb.writeMeta(meta);
  bb.renderView(meta.id);
  return ev;
}
