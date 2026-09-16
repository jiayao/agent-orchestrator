// Runner: executes rounds. Budgets are enforced BEFORE each round's fan-out.
// A dead agent never kills a workshop — the round continues with survivors.
// Never auto-retries. Persistence survives a crash mid-round: on resume,
// agents whose result.json already exists are not respawned.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentConfig,
  ResultPayload,
  RunResult,
  TaskMeta,
  TeamConfig,
  TeamEvent,
} from "./types.ts";
import { Blackboard } from "./blackboard.ts";
import { composePrompt } from "./prompt.ts";
import { applyRedaction, buildSpawnSpec, estimatedCost, spawnAgent } from "./spawn.ts";
import { resolveFinalBody } from "./envelope.ts";

export function runId(round: number, agentId: string): string {
  return `r${round}-${agentId}`;
}

/**
 * Returns a reason string if the budget would be exceeded by a planned
 * fan-out of `planned` runs, else null. Enforced before each round.
 */
export function checkBudget(
  meta: TaskMeta,
  config: TeamConfig,
  planned: { agents: AgentConfig[] }
): string | null {
  const b = config.budgets;
  if (meta.runs_completed + planned.agents.length > b.max_runs) {
    return `max_runs: ${meta.runs_completed} used + ${planned.agents.length} planned > ${b.max_runs}`;
  }
  const elapsed = Date.now() - Date.parse(meta.started_at);
  if (elapsed > b.max_wall_time_ms) {
    return `max_wall_time_ms: ${elapsed}ms elapsed > ${b.max_wall_time_ms}ms`;
  }
  const plannedCost = planned.agents.reduce((s, a) => s + (a.cost_per_run_usd ?? 0), 0);
  if (meta.estimated_cost_usd + plannedCost > b.max_estimated_cost_usd) {
    return (
      `max_estimated_cost_usd: $${meta.estimated_cost_usd.toFixed(4)} spent + ` +
      `$${plannedCost.toFixed(4)} planned > $${b.max_estimated_cost_usd}`
    );
  }
  return null;
}

export interface RunHooks {
  onRunStart?: (runId: string, agentId: string) => void;
  onRunEnd?: (result: RunResult) => void;
  onEvent?: (ev: TeamEvent) => void;
}

function bodyFromJson(json: Record<string, unknown>): string {
  const b = json.body ?? json.summary;
  if (typeof b === "string") return b;
  return JSON.stringify(json);
}

function claimsFromJson(json: Record<string, unknown>): string[] | undefined {
  return Array.isArray(json.claims)
    ? json.claims.filter((c): c is string => typeof c === "string")
    : undefined;
}

async function emitResultEvents(
  bb: Blackboard,
  config: TeamConfig,
  meta: TaskMeta,
  agentId: string,
  round: number,
  run: string,
  payload: ResultPayload,
  hooks: RunHooks
): Promise<void> {
  const claims = Array.isArray(payload.claims)
    ? payload.claims.filter((c): c is string => typeof c === "string")
    : undefined;
  const body = payload.summary ?? payload.body ?? JSON.stringify(payload);
  const ev = await bb.appendEvent(meta.id, {
    actor: agentId,
    type: payload.type ?? "position",
    round,
    reply_to: null,
    body: applyRedaction(body, config),
    claims,
    run_id: run,
  });
  hooks.onEvent?.(ev);
  if (Array.isArray(payload.replies)) {
    for (const r of payload.replies) {
      if (!r || typeof r !== "object") continue;
      const rev = await bb.appendEvent(meta.id, {
        actor: agentId,
        type: "reply",
        round,
        reply_to: typeof r.reply_to === "string" ? r.reply_to : null,
        body: applyRedaction(r.body ?? "", config),
        claims: Array.isArray(r.claims)
          ? r.claims.filter((c): c is string => typeof c === "string")
          : undefined,
        run_id: run,
      });
      hooks.onEvent?.(rev);
    }
  }
}

export interface RoundResult {
  results: RunResult[];
  budgetExceeded?: string;
}

/**
 * Execute one round: fan out to all agents concurrently (bounded by
 * config.defaults.concurrency) against an immutable snapshot of prior events.
 */
export async function runRound(
  bb: Blackboard,
  config: TeamConfig,
  meta: TaskMeta,
  round: number,
  agents: AgentConfig[],
  hooks: RunHooks = {}
): Promise<RoundResult> {
  const priorEvents = bb.readEvents(meta.id); // snapshot; includes all completed rounds

  await bb.appendEvent(meta.id, {
    actor: "orchestrator",
    type: "round_start",
    round,
    reply_to: null,
    body: `round ${round} started with agents: ${agents.map((a) => a.id).join(", ")}`,
  });

  const artifactText = bb.readArtifact(meta.id);
  const results: RunResult[] = [];

  // Concurrency pool
  let idx = 0;
  const worker = async () => {
    while (idx < agents.length) {
      const agent = agents[idx++];
      const rid = runId(round, agent.id);
      const rdir = bb.initRunDir(meta.id, rid);

      // Resume support: a finished run is never respawned.
      const resultPath = join(rdir, "result.json");
      if (existsSync(resultPath)) {
        try {
          const prev = JSON.parse(readFileSync(resultPath, "utf8")) as RunResult;
          results.push(prev);
          continue;
        } catch {
          // corrupt result.json — fall through and respawn
        }
      }

      const prompt = composePrompt({
        config,
        agent,
        kind: meta.kind as "workshop" | "ask", // chat tasks never reach the runner
        round,
        artifactText,
        artifactLabel: meta.artifact_label,
        priorEvents,
      });
      const spec = buildSpawnSpec(agent, config, prompt);
      bb.writeRunFile(meta.id, rid, "request.json", { spec, agent_id: agent.id, round, task_id: meta.id });
      bb.writeRunFile(meta.id, rid, "prompt.txt", prompt);

      hooks.onRunStart?.(rid, agent.id);
      const startedAt = new Date();
      const outcome = await spawnAgent(spec, prompt, config, {
        onEnvelope: (env) => {
          // Stream TEAM_EVENT_V1 envelopes to the blackboard as they arrive.
          if (env.kind !== "TEAM_EVENT_V1") return;
          void (async () => {
            if (env.json !== null && typeof env.json === "object") {
              const j = env.json as Record<string, unknown>;
              const ev = await bb.appendEvent(meta.id, {
                actor: agent.id,
                type: typeof j.type === "string" ? j.type : "note",
                round,
                reply_to: typeof j.reply_to === "string" ? j.reply_to : null,
                body: applyRedaction(bodyFromJson(j), config),
                claims: claimsFromJson(j),
                run_id: rid,
              });
              hooks.onEvent?.(ev);
              bb.renderView(meta.id); // live tail for the human
            } else {
              const ev = await bb.appendEvent(meta.id, {
                actor: agent.id,
                type: "malformed",
                round,
                reply_to: null,
                body: applyRedaction(env.raw, config),
                unstructured: true,
                run_id: rid,
              });
              hooks.onEvent?.(ev);
            }
          })();
        },
      });

      bb.writeRunFile(meta.id, rid, "stdout.txt", outcome.stdout);
      bb.writeRunFile(meta.id, rid, "stderr.txt", outcome.stderr);

      // Final result: envelope -> events; else fallback chain (never dropped).
      if (outcome.resultPayload !== null && typeof outcome.resultPayload === "object") {
        await emitResultEvents(
          bb, config, meta, agent.id, round, rid, outcome.resultPayload as ResultPayload, hooks
        );
      } else {
        if (outcome.resultParseError) {
          const ev = await bb.appendEvent(meta.id, {
            actor: agent.id,
            type: "malformed",
            round,
            reply_to: null,
            body: `malformed TEAM_RESULT_V1 envelope: ${outcome.resultParseError}`,
            unstructured: true,
            run_id: rid,
          });
          hooks.onEvent?.(ev);
        }
        const fb = resolveFinalBody(outcome.stdout);
        if (fb.body.trim().length) {
          const ev = await bb.appendEvent(meta.id, {
            actor: agent.id,
            type: "position",
            round,
            reply_to: null,
            body: applyRedaction(fb.body, config),
            unstructured: fb.extraction === "unstructured",
            run_id: rid,
          });
          hooks.onEvent?.(ev);
        }
      }

      // Honest telemetry
      const { cost, source } = estimatedCost(agent);
      const result: RunResult = {
        run_id: rid,
        task_id: meta.id,
        agent_id: agent.id,
        round,
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
      results.push(result);

      meta.runs_completed += 1;
      if (cost !== null) meta.estimated_cost_usd += cost;
      bb.writeMeta(meta);

      if (outcome.status !== "succeeded") {
        const ev = await bb.appendEvent(meta.id, {
          actor: "orchestrator",
          type: "run_failed",
          round,
          reply_to: null,
          body: `run ${rid} (${agent.id}) finished with status ${outcome.status}` +
            (outcome.stderr ? `: ${outcome.stderr.trim().split("\n").pop()?.slice(0, 300)}` : ""),
          run_id: rid,
        });
        hooks.onEvent?.(ev);
      }
      hooks.onRunEnd?.(result);
    }
  };

  const n = Math.min(config.defaults.concurrency, agents.length);
  await Promise.all(Array.from({ length: n }, () => worker()));

  meta.completed_rounds = Math.max(meta.completed_rounds, round);
  bb.writeMeta(meta);
  await bb.appendEvent(meta.id, {
    actor: "orchestrator",
    type: "round_end",
    round,
    reply_to: null,
    body: `round ${round} completed: ${results.filter((r) => r.status === "succeeded").length}/${results.length} succeeded`,
  });
  bb.renderView(meta.id);
  return { results };
}

export interface TaskRunSummary {
  results: RunResult[];
  budgetExceeded?: string;
  state: TaskMeta["state"];
}

/**
 * Run all remaining rounds of a task. Budgets are checked before each
 * round's fan-out. On budget exhaustion the task keeps its partial
 * results arbitrable: awaiting_decision if any round completed, else failed.
 */
export async function runTaskRounds(
  bb: Blackboard,
  config: TeamConfig,
  meta: TaskMeta,
  agents: AgentConfig[],
  hooks: RunHooks = {}
): Promise<TaskRunSummary> {
  const all: RunResult[] = [];
  for (let round = meta.completed_rounds + 1; round <= meta.rounds_planned; round++) {
    const reason = checkBudget(meta, config, { agents });
    if (reason) {
      await bb.appendEvent(meta.id, {
        actor: "orchestrator",
        type: "budget_exceeded",
        round,
        reply_to: null,
        body: `budget exhausted before round ${round} fan-out: ${reason}`,
      });
      meta.error = `budget_exceeded: ${reason}`;
      meta.state = meta.completed_rounds > 0 ? "awaiting_decision" : "failed";
      bb.writeMeta(meta);
      bb.renderView(meta.id);
      return { results: all, budgetExceeded: reason, state: meta.state };
    }
    meta.state = "running";
    bb.writeMeta(meta);
    const rr = await runRound(bb, config, meta, round, agents, hooks);
    all.push(...rr.results);
  }
  meta.state = meta.kind === "ask" ? "completed" : "awaiting_decision";
  bb.writeMeta(meta);
  bb.renderView(meta.id);
  return { results: all, state: meta.state };
}
