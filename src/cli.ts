// CLI surface. Agent-first: --json on every command; human-readable is the
// secondary rendering. No daemon, no server.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import * as readline from "node:readline";
import { loadConfig, sha256 } from "./config.ts";
import { Blackboard, newTaskId } from "./blackboard.ts";
import { composePrompt } from "./prompt.ts";
import { buildSpawnSpec, spawnAgent } from "./spawn.ts";
import { runTaskRounds } from "./runner.ts";
import {
  chatProgress,
  packChatPrompt,
  runChat,
  type ConsoleIO,
} from "./chat.ts";
import { ECHO_AGENT, EXAMPLE_ARTIFACT, TEAM_TOML } from "./templates.ts";
import type { AgentConfig, DecisionRecord, TaskMeta, TeamConfig } from "./types.ts";

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Map<string, string | true>;
  json: boolean;
  configPath: string;
  printPrompt: boolean;
}

export class CliError extends Error {
  code: number;
  constructor(msg: string, code = 1) {
    super(msg);
    this.code = code;
  }
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  let command = "";
  let json = false;
  let configPath = "team.toml";
  let printPrompt = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") json = true;
    else if (a === "--print-prompt") printPrompt = true;
    else if (a === "--config") configPath = argv[++i] ?? configPath;
    else if (a === "-h" || a === "--help") flags.set("help", true);
    else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) flags.set(a.slice(2, eq), a.slice(eq + 1));
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) flags.set(a.slice(2), argv[++i]);
      else flags.set(a.slice(2), true);
    } else if (!command) command = a;
    else positional.push(a);
  }
  return { command, positional, flags, json, configPath, printPrompt };
}

const USAGE = `team — local-first agent orchestration (v0)

usage: team [--json] [--config team.toml] <command> [...]

commands:
  init                                scaffold team.toml + echo-agent + example task
  doctor [--live]                     validate config, probe binaries, print resolved argv
  tasks                               list tasks
  ask [--agents a,b] <prompt>         fan one prompt out to N agents
  chat --agents a,b --topic "..."     pairwise dialogue, orchestrator as relay
      [--max-turns N] [--history-budget chars] [--console-timeout ms]
  chat --resume <task-id>             continue a cancelled/interrupted chat
  workshop <artifact.md> [--rounds N] bounded review: critique, cross-review, awaiting_decision
  workshop --resume <task-id>         continue from the last completed round
  arbitrate <task-id>                 interactive pick, or:
      --accept <event-id> | --reject <event-id> | --merge <id1,id2> | --defer
      [--rationale "..."]
  verdict <task-id> good|bad|mixed [note]
  export <task-id> [--out path]       deterministic bundle (inputs, events, decisions, metrics)

global flags: --json  --print-prompt (ask, workshop, chat)  --config
`;

function log(msg: string) {
  console.error(msg);
}

function fail(msg: string, code = 1): never {
  throw new CliError(msg, code);
}

function printJson(obj: unknown) {
  console.log(JSON.stringify(obj, null, 2));
}

async function requireConfig(path: string): Promise<TeamConfig> {
  try {
    return await loadConfig(path);
  } catch (e) {
    fail((e as Error).message);
  }
}

function selectAgents(config: TeamConfig, flag: string | true | undefined): AgentConfig[] {
  if (flag === undefined || flag === true) return config.agents;
  const wanted = String(flag).split(",").map((s) => s.trim()).filter(Boolean);
  const out: AgentConfig[] = [];
  for (const id of wanted) {
    const a = config.agents.find((x) => x.id === id);
    if (!a) fail(`unknown agent id ${JSON.stringify(id)} (configured: ${config.agents.map((x) => x.id).join(", ")})`);
    out.push(a);
  }
  if (!out.length) fail("no agents selected");
  return out;
}

function newMeta(kind: TaskMeta["kind"], config: TeamConfig, artifactText: string, label: string, agents: AgentConfig[], rounds: number): TaskMeta {
  const now = new Date().toISOString();
  return {
    id: newTaskId(),
    kind,
    state: "created",
    created_at: now,
    updated_at: now,
    started_at: now,
    artifact_sha256: sha256(artifactText),
    artifact_label: label,
    team_sha256: config.hash,
    agents: agents.map((a) => a.id),
    rounds_planned: rounds,
    completed_rounds: 0,
    runs_completed: 0,
    estimated_cost_usd: 0,
  };
}

function progressHooks(json: boolean) {
  return {
    onRunStart: (rid: string, agent: string) => {
      if (!json) log(`  run ${rid} (${agent}) ...`);
    },
    onRunEnd: (r: { run_id: string; agent_id: string; status: string; latency_ms: number }) => {
      if (!json) log(`  run ${r.run_id} (${r.agent_id}): ${r.status} ${r.latency_ms}ms`);
    },
  };
}

// ---------- commands ----------

async function cmdInit(args: ParsedArgs): Promise<void> {
  const dir = process.cwd();
  const force = args.flags.has("force");
  const files: Record<string, string> = {
    "team.toml": TEAM_TOML,
    "echo-agent.ts": ECHO_AGENT,
    "example.md": EXAMPLE_ARTIFACT,
  };
  const written: string[] = [];
  for (const [name, content] of Object.entries(files)) {
    const p = join(dir, name);
    if (existsSync(p) && !force) {
      if (name === "team.toml") fail(`${name} already exists (use --force to overwrite)`);
      continue; // never clobber auxiliary files unless forced
    }
    writeFileSync(p, content);
    written.push(name);
  }
  const result = { ok: true, written, dir };
  if (args.json) printJson(result);
  else {
    for (const w of written) log(`wrote ${w}`);
    log(`next: team doctor && team workshop example.md`);
  }
}

async function probeBinary(executable: string): Promise<{ path: string | null; version: string | null }> {
  const path = Bun.which(executable);
  if (!path) return { path: null, version: null };
  try {
    const proc = Bun.spawn([path, "--version"], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), 5000);
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    clearTimeout(timer);
    const first = out.trim().split("\n")[0]?.trim();
    return { path, version: code === 0 && first ? first.slice(0, 120) : null };
  } catch {
    return { path, version: null };
  }
}

async function cmdDoctor(args: ParsedArgs): Promise<void> {
  const config = await requireConfig(args.configPath);
  const live = args.flags.has("live");
  const report: Record<string, unknown> = {
    ok: true,
    config: config.path,
    team: config.team,
    team_hash: config.hash.slice(0, 12),
    defaults: config.defaults,
    budgets: config.budgets,
    roles: config.roles.map((r) => r.name),
    agents: [] as unknown[],
  };
  const warnings: string[] = [];
  const agentReports: Record<string, unknown>[] = [];
  for (const agent of config.agents) {
    if (agent.kind === "console") {
      agentReports.push({
        id: agent.id,
        kind: "console",
        adapter: agent.adapter,
        model: agent.model ?? null,
        role: agent.role,
        binary: "n/a (live operator)",
        auth: "n/a",
      });
      continue;
    }
    const spec = buildSpawnSpec(agent, config, "<prompt>");
    const probe = await probeBinary(agent.command!.executable);
    const rep: Record<string, unknown> = {
      id: agent.id,
      kind: "cli",
      adapter: agent.adapter,
      model: agent.model ?? null,
      role: agent.role,
      resolved_argv: [spec.executable, ...spec.args],
      stdin: spec.stdin,
      timeout_ms: spec.timeoutMs,
      max_output_bytes: spec.maxOutputBytes,
      cwd: spec.cwd,
      binary: probe.path ?? "MISSING",
      version: probe.version,
      auth: agent.adapter === "echo" ? "n/a" : "not_probed",
      cost_per_run_usd: agent.cost_per_run_usd ?? "unknown",
    };
    if (!probe.path) rep.warning = "executable not found on PATH";
    if (agent.auth_env) {
      const present =
        agent.env[agent.auth_env] !== undefined ||
        process.env[agent.auth_env] !== undefined;
      rep.auth_env = agent.auth_env;
      rep.auth = present ? `present (${agent.auth_env})` : `missing (${agent.auth_env})`;
      if (!present) {
        rep.warning = `${agent.auth_env} not set` + (rep.warning ? `; ${rep.warning}` : "");
        warnings.push(`agent ${agent.id}: ${agent.auth_env} not set`);
      }
    }
    if (live && probe.path) {
      const outcome = await spawnAgent(
        buildSpawnSpec(agent, config, "Reply with a one-word acknowledgment."),
        "Reply with a one-word acknowledgment.",
        config
      );
      rep.live_probe = { status: outcome.status, latency_ms: outcome.latency_ms };
      rep.auth = outcome.status === "auth_error" ? "failed" : outcome.status === "failed" ? "unknown" : "ok";
    }
    agentReports.push(rep);
  }
  report.agents = agentReports;
  const missing = agentReports.filter((r) => r.binary === "MISSING").length;
  if (missing) warnings.unshift(`${missing} agent binary(ies) missing on PATH`);
  if (warnings.length) report.warnings = warnings;

  if (args.json) printJson(report);
  else {
    log(`team: ${config.team}  config: ${config.path}`);
    log(`budgets: max_runs=${config.budgets.max_runs} wall=${config.budgets.max_wall_time_ms}ms spend<=$${config.budgets.max_estimated_cost_usd}`);
    log(`defaults: timeout=${config.defaults.timeout_ms}ms max_out=${config.defaults.max_output_bytes}B conc=${config.defaults.concurrency}`);
    for (const r of agentReports) {
      log(`\nagent ${r.id} [${r.adapter}${r.model ? "/" + r.model : ""}] kind=${r.kind ?? "cli"} role=${r.role}`);
      if (r.resolved_argv) {
        log(`  argv: ${(r.resolved_argv as string[]).join(" ")}   stdin: ${r.stdin}`);
      }
      log(`  binary: ${r.binary}${r.version ? `  version: ${r.version}` : ""}   auth: ${r.auth}`);
      if (r.warning) log(`  WARNING: ${r.warning}`);
      if (r.live_probe) log(`  live: ${JSON.stringify(r.live_probe)}`);
    }
  }
}

async function cmdTasks(args: ParsedArgs): Promise<void> {
  const config = await requireConfig(args.configPath);
  const bb = new Blackboard(join(config.root, ".team"));
  const tasks = bb.listTasks();
  if (args.json) printJson({ ok: true, tasks });
  else {
    for (const t of tasks) {
      log(`${t.id}  ${t.kind}  ${t.state}  rounds=${t.completed_rounds}/${t.rounds_planned}  ${t.artifact_label}`);
    }
    if (!tasks.length) log("no tasks yet");
  }
}

async function cmdAsk(args: ParsedArgs): Promise<void> {
  const promptText = args.positional.join(" ");
  if (!promptText.trim()) fail("usage: team ask [--agents a,b] <prompt>", 2);
  const config = await requireConfig(args.configPath);
  const agents = selectAgents(config, args.flags.get("agents"));
  const bb = new Blackboard(join(config.root, ".team"));
  mkdirSync(bb.teamDir, { recursive: true });

  const meta = newMeta("ask", config, promptText, "argv", agents, 1);
  bb.initTask(meta, promptText);
  await bb.appendEvent(meta.id, {
    actor: "orchestrator", type: "task_created", round: 0, reply_to: null,
    body: `ask: ${promptText.slice(0, 200)}`,
  });

  if (args.printPrompt) {
    const prompts = agents.map((a) => ({
      agent_id: a.id,
      prompt: composePrompt({ config, agent: a, kind: "ask", round: 1, artifactText: promptText, artifactLabel: "argv", priorEvents: [] }),
    }));
    if (args.json) printJson({ ok: true, dry_run: true, task_id: meta.id, prompts });
    else for (const p of prompts) { log(`=== prompt for ${p.agent_id} ===`); console.log(p.prompt); }
    return;
  }

  const summary = await runTaskRounds(bb, config, meta, agents, progressHooks(args.json));
  const events = bb.readEvents(meta.id);
  const agentEvents = events.filter((e) => e.actor !== "orchestrator" && e.type !== "issue");

  if (args.json) {
    printJson({ ok: true, task_id: meta.id, state: meta.state, results: summary.results, events });
  } else {
    log(`\ntask ${meta.id} — ${meta.state}`);
    for (const ev of agentEvents) {
      console.log(`\n--- ${ev.actor} (${ev.type}) ${ev.unstructured ? "[unstructured]" : ""} ---`);
      console.log(ev.body);
    }
    log(`\nblackboard: ${bb.taskDir(meta.id)}`);
  }
}

async function cmdWorkshop(args: ParsedArgs): Promise<void> {
  const config = await requireConfig(args.configPath);
  const bb = new Blackboard(join(config.root, ".team"));
  const resumeId = args.flags.get("resume");

  let meta: TaskMeta;
  let agents: AgentConfig[];

  if (resumeId !== undefined) {
    const id = String(resumeId);
    if (!bb.taskExists(id)) fail(`task not found: ${id}`);
    meta = bb.readMeta(id);
    if (meta.state === "awaiting_decision" || meta.state === "completed") {
      const out = { ok: true, task_id: id, state: meta.state, message: "nothing to resume — all planned rounds completed" };
      if (args.json) printJson(out);
      else log(`${id}: ${out.message} (state=${meta.state})`);
      return;
    }
    if (meta.state === "cancelled") fail(`task ${id} is cancelled`);
    agents = meta.agents.map((id2) => {
      const a = config.agents.find((x) => x.id === id2);
      if (!a) fail(`task ${id} references agent ${JSON.stringify(id2)} not in config`);
      return a;
    });
    log(`resuming task ${id} from round ${meta.completed_rounds + 1}`);
  } else {
    const artifactPath = args.positional[0];
    if (!artifactPath) fail("usage: team workshop <artifact.md> [--rounds N] | team workshop --resume <task-id>", 2);
    const abs = resolve(artifactPath);
    if (!existsSync(abs)) fail(`artifact not found: ${abs}`);
    const artifactText = readFileSync(abs, "utf8");
    const rounds = Number(args.flags.get("rounds") ?? 2);
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > 2) {
      fail("--rounds must be 1 or 2 (fixed topology: critique -> cross-review)");
    }
    agents = selectAgents(config, args.flags.get("agents"));
    mkdirSync(bb.teamDir, { recursive: true });
    meta = newMeta("workshop", config, artifactText, artifactPath, agents, rounds);
    bb.initTask(meta, artifactText);
    await bb.appendEvent(meta.id, {
      actor: "orchestrator", type: "task_created", round: 0, reply_to: null,
      body: `workshop on ${artifactPath} (sha256:${meta.artifact_sha256.slice(0, 12)})`,
    });
  }

  if (args.printPrompt) {
    const round = meta.completed_rounds + 1;
    if (round > meta.rounds_planned) {
      const out = { ok: true, dry_run: true, task_id: meta.id, message: "no rounds left to preview" };
      if (args.json) printJson(out);
      else log(out.message);
      return;
    }
    const prior = bb.readEvents(meta.id).filter((e) => e.round < round);
    const prompts = agents.map((a) => ({
      agent_id: a.id,
      round,
      prompt: composePrompt({ config, agent: a, kind: "workshop", round, artifactText: bb.readArtifact(meta.id), artifactLabel: meta.artifact_label, priorEvents: prior }),
    }));
    if (args.json) printJson({ ok: true, dry_run: true, task_id: meta.id, prompts });
    else for (const p of prompts) { log(`=== prompt for ${p.agent_id} (round ${p.round}) ===`); console.log(p.prompt); }
    return;
  }

  const summary = await runTaskRounds(bb, config, meta, agents, progressHooks(args.json));
  if (args.json) {
    printJson({ ok: true, task_id: meta.id, state: meta.state, budget_exceeded: summary.budgetExceeded ?? null, results: summary.results });
  } else {
    log(`\ntask ${meta.id} — ${meta.state}`);
    if (summary.budgetExceeded) log(`budget: ${summary.budgetExceeded}`);
    if (meta.state === "awaiting_decision") log(`next: team arbitrate ${meta.id}`);
    log(`view: ${bb.viewPath(meta.id)}`);
  }
}

/** Real console IO: transcript goes to stderr (stdout stays clean for --json). */
function realConsoleIO(): ConsoleIO {
  return {
    isTTY: process.stdin.isTTY === true,
    print: (t) => process.stderr.write(t + "\n"),
    prompt: (q) =>
      new Promise<string | null>((res) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
        let settled = false;
        const done = (v: string | null) => {
          if (settled) return;
          settled = true;
          rl.close();
          res(v);
        };
        rl.question(q, (a) => done(a));
        rl.on("SIGINT", () => done(null)); // ctrl-C
        rl.on("close", () => done(null)); // ctrl-D / TTY loss
      }),
  };
}

function numFlag(v: string | true | undefined): number | undefined {
  if (v === undefined || v === true) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) fail(`invalid numeric flag value: ${JSON.stringify(v)}`);
  return n;
}

async function cmdChat(args: ParsedArgs): Promise<void> {
  const config = await requireConfig(args.configPath);
  const bb = new Blackboard(join(config.root, ".team"));
  const resumeId = args.flags.get("resume");
  const maxTurns = numFlag(args.flags.get("max-turns"));
  const historyBudgetChars = numFlag(args.flags.get("history-budget"));
  const consoleTimeoutMs = numFlag(args.flags.get("console-timeout"));

  let meta: TaskMeta;
  let agents: AgentConfig[];

  if (resumeId !== undefined) {
    const id = String(resumeId);
    if (!bb.taskExists(id)) fail(`task not found: ${id}`);
    meta = bb.readMeta(id);
    if (meta.kind !== "chat") fail(`task ${id} is kind ${meta.kind}, not a chat`);
    if (meta.state === "completed") {
      const out = { ok: true, task_id: id, state: meta.state, message: "nothing to resume — chat already ended" };
      if (args.json) printJson(out);
      else log(`${id}: ${out.message} (state=${meta.state})`);
      return;
    }
    agents = meta.agents.map((aid) => {
      const a = config.agents.find((x) => x.id === aid);
      if (!a) fail(`task ${id} references agent ${JSON.stringify(aid)} not in config`);
      return a;
    });
    if (!args.json) log(`resuming chat ${id}`);
  } else {
    const topicFlag = args.flags.get("topic");
    const topic = (typeof topicFlag === "string" ? topicFlag : args.positional.join(" ")).trim();
    if (!topic) fail('usage: team chat --agents a,b --topic "..." [--max-turns N] [--history-budget chars] [--console-timeout ms] | team chat --resume <task-id>', 2);
    agents = selectAgents(config, args.flags.get("agents"));
    if (agents.length !== 2) fail(`chat requires exactly two agents (got ${agents.length}); use --agents a,b`);
    mkdirSync(bb.teamDir, { recursive: true });
    meta = newMeta("chat", config, topic, "topic", agents, maxTurns ?? config.chat.max_turns);
    meta.chat = {
      topic,
      max_turns: maxTurns ?? config.chat.max_turns,
      history_budget_chars: historyBudgetChars ?? config.chat.history_budget_chars,
      console_timeout_ms: consoleTimeoutMs ?? config.chat.console_timeout_ms,
      substantive_turns: 0,
      total_turns: 0,
    };
    bb.initTask(meta, topic);
  }

  const ids: [string, string] = [agents[0].id, agents[1].id];

  if (args.printPrompt) {
    const events = bb.readEvents(meta.id);
    const prog = chatProgress(events, ids);
    const agent = agents.find((a) => a.id === prog.nextActor)!;
    const pack = packChatPrompt({
      config,
      agent,
      peerId: prog.nextActor === ids[0] ? ids[1] : ids[0],
      topic: meta.chat?.topic ?? bb.readArtifact(meta.id),
      turns: prog.turns,
      historyBudgetChars: historyBudgetChars ?? meta.chat?.history_budget_chars ?? config.chat.history_budget_chars,
    });
    const out = { ok: true, dry_run: true, task_id: meta.id, next_actor: prog.nextActor, prompt: pack.prompt, omitted: pack.omitted };
    if (args.json) printJson(out);
    else { log(`=== next turn prompt for ${prog.nextActor} ===`); console.log(pack.prompt); }
    return;
  }

  try {
    const summary = await runChat(bb, config, meta, agents, {
      maxTurns,
      historyBudgetChars,
      consoleTimeoutMs,
      consoleIO: realConsoleIO(),
      hooks: {
        onEvent: (ev) => {
          if (!args.json && ev.type === "turn") {
            log(`\n--- turn ${ev.event_id} — ${ev.actor} (signal=${ev.signal ?? "?"})${ev.malformed ? " [malformed]" : ""} ---`);
            log(ev.body.length > 800 ? ev.body.slice(0, 800) + "…" : ev.body);
          }
        },
        onTurnStart: (actor, rid) => {
          if (!args.json) log(`  ${rid} (${actor}) ...`);
        },
      },
    });
    if (args.json) {
      printJson({ ok: true, ...summary, events: bb.readEvents(meta.id) });
    } else {
      log(`\nchat ${meta.id} — ${summary.state} (end_reason=${summary.end_reason})`);
      log(`view: ${bb.viewPath(meta.id)}`);
      if (summary.state === "cancelled") log(`resume: team chat --resume ${meta.id}`);
    }
  } catch (e) {
    fail((e as Error).message);
  }
}

async function cmdArbitrate(args: ParsedArgs): Promise<void> {
  const taskId = args.positional[0];
  if (!taskId) fail("usage: team arbitrate <task-id> [--accept|--reject|--merge|--defer ...]", 2);
  const config = await requireConfig(args.configPath);
  const bb = new Blackboard(join(config.root, ".team"));
  if (!bb.taskExists(taskId)) fail(`task not found: ${taskId}`);
  const meta = bb.readMeta(taskId);
  if (meta.state !== "awaiting_decision") {
    fail(`task ${taskId} is ${meta.state}; only awaiting_decision tasks can be arbitrated`);
  }

  const accept = args.flags.get("accept");
  const reject = args.flags.get("reject");
  const merge = args.flags.get("merge");
  const defer = args.flags.has("defer");
  const rationale = args.flags.get("rationale");
  const rationaleStr = typeof rationale === "string" ? rationale : undefined;

  const events = bb.readEvents(taskId);
  const candidates = events.filter((e) => e.actor !== "orchestrator" && !e.unstructured);

  let decision: DecisionRecord;

  if (accept !== undefined) {
    const id = String(accept);
    if (!events.some((e) => e.event_id === id)) fail(`no such event: ${id}`);
    decision = { ts: new Date().toISOString(), action: "accept", event_ids: [id], rationale: rationaleStr, actor: "human" };
  } else if (merge !== undefined) {
    const ids = String(merge).split(",").map((s) => s.trim()).filter(Boolean);
    for (const id of ids) if (!events.some((e) => e.event_id === id)) fail(`no such event: ${id}`);
    if (!ids.length) fail("--merge needs at least one event id");
    decision = { ts: new Date().toISOString(), action: "merge", event_ids: ids, rationale: rationaleStr, actor: "human" };
  } else if (reject !== undefined) {
    const id = String(reject);
    if (!events.some((e) => e.event_id === id)) fail(`no such event: ${id}`);
    decision = { ts: new Date().toISOString(), action: "reject", event_ids: [id], rationale: rationaleStr, actor: "human" };
  } else if (defer) {
    decision = { ts: new Date().toISOString(), action: "defer", event_ids: [], rationale: rationaleStr, actor: "human" };
  } else {
    // interactive pick
    if (!process.stdin.isTTY) {
      fail("stdin is not a TTY; use --accept/--reject/--merge/--defer for non-interactive arbitration", 2);
    }
    if (!candidates.length) fail("no candidate events to pick from");
    candidates.forEach((e, i) => {
      log(`[${i + 1}] ${e.event_id} — ${e.actor} (${e.type}, round ${e.round})`);
      log(`    ${e.body.slice(0, 200)}${e.body.length > 200 ? "…" : ""}`);
    });
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const answer = await new Promise<string>((res) => rl.question(`pick 1-${candidates.length} (or 'd' to defer): `, res));
    rl.close();
    const trimmed = answer.trim().toLowerCase();
    if (trimmed === "d" || trimmed === "defer") {
      decision = { ts: new Date().toISOString(), action: "defer", event_ids: [], rationale: rationaleStr, actor: "human" };
    } else {
      const n = Number(trimmed);
      if (!Number.isInteger(n) || n < 1 || n > candidates.length) fail(`invalid pick: ${answer}`);
      decision = { ts: new Date().toISOString(), action: "accept", event_ids: [candidates[n - 1].event_id], rationale: rationaleStr, actor: "human" };
    }
  }

  const bodies = new Map(events.map((e) => [e.event_id, e.body] as const));
  bb.writeDecision(taskId, decision, bodies);
  meta.decision = decision;
  // accept/merge close the task; reject/defer keep it arbitrable
  meta.state = decision.action === "accept" || decision.action === "merge" ? "completed" : "awaiting_decision";
  bb.writeMeta(meta);
  await bb.appendEvent(taskId, {
    actor: "orchestrator", type: "decision", round: meta.completed_rounds, reply_to: null,
    body: `${decision.action} ${decision.event_ids.join(",") || "(none)"}${decision.rationale ? ` — ${decision.rationale}` : ""}`,
    claims: decision.event_ids,
  });
  await bb.appendTaste({ kind: "decision", task_id: taskId, action: decision.action, event_ids: decision.event_ids, rationale: decision.rationale ?? null });
  bb.renderView(taskId);

  if (args.json) printJson({ ok: true, task_id: taskId, decision, state: meta.state });
  else log(`${taskId}: ${decision.action} ${decision.event_ids.join(", ") || ""} → ${meta.state}`);
}

async function cmdVerdict(args: ParsedArgs): Promise<void> {
  const [taskId, verdictWord, ...noteParts] = args.positional;
  if (!taskId || !verdictWord) fail("usage: team verdict <task-id> good|bad|mixed [note]", 2);
  if (!["good", "bad", "mixed"].includes(verdictWord)) fail(`verdict must be good|bad|mixed (got ${verdictWord})`, 2);
  const note = noteParts.join(" ") || undefined;
  const config = await requireConfig(args.configPath);
  const bb = new Blackboard(join(config.root, ".team"));
  if (!bb.taskExists(taskId)) fail(`task not found: ${taskId}`);
  const meta = bb.readMeta(taskId);
  const verdict = { verdict: verdictWord as "good" | "bad" | "mixed", note, ts: new Date().toISOString() };
  meta.verdict = verdict;
  bb.writeMeta(meta);
  await bb.appendEvent(taskId, {
    actor: "orchestrator", type: "verdict", round: meta.completed_rounds, reply_to: null,
    body: `verdict: ${verdictWord}${note ? ` — ${note}` : ""}`,
  });
  await bb.appendTaste({ kind: "verdict", task_id: taskId, verdict: verdictWord, note: note ?? null });
  bb.renderView(taskId);
  if (args.json) printJson({ ok: true, task_id: taskId, verdict });
  else log(`${taskId}: verdict=${verdictWord}${note ? ` (${note})` : ""}`);
}

/** deterministic JSON: recursively sort object keys */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) o[k] = sortKeys((v as Record<string, unknown>)[k]);
    return o;
  }
  return v;
}

async function cmdExport(args: ParsedArgs): Promise<void> {
  const taskId = args.positional[0];
  if (!taskId) fail("usage: team export <task-id> [--out path]", 2);
  const config = await requireConfig(args.configPath);
  const bb = new Blackboard(join(config.root, ".team"));
  if (!bb.taskExists(taskId)) fail(`task not found: ${taskId}`);
  const meta = bb.readMeta(taskId);
  const events = bb.readEvents(taskId);
  const artifactText = bb.readArtifact(taskId);

  const runsDir = join(bb.taskDir(taskId), "runs");
  const runSummaries: Record<string, unknown>[] = [];
  try {
    const { readdirSync } = await import("node:fs");
    for (const rid of readdirSync(runsDir).sort()) {
      try {
        const res = JSON.parse(readFileSync(join(runsDir, rid, "result.json"), "utf8"));
        runSummaries.push(res);
      } catch {
        runSummaries.push({ run_id: rid, status: "incomplete" });
      }
    }
  } catch {
    // no runs
  }

  const bundle = sortKeys({
    format: "team-export-v1",
    task: meta,
    artifact: { sha256: meta.artifact_sha256, label: meta.artifact_label, text: artifactText },
    events,
    decision: meta.decision ?? null,
    verdict: meta.verdict ?? null,
    runs: runSummaries,
    taste_log_entries: bb.readTasteLog().filter((e) => e.task_id === taskId),
  });

  const outFlag = args.flags.get("out");
  const outPath = typeof outFlag === "string" ? resolve(outFlag) : join(bb.taskDir(taskId), "export.json");
  writeFileSync(outPath, JSON.stringify(bundle, null, 2) + "\n");
  if (args.json) printJson({ ok: true, task_id: taskId, export_path: outPath, bundle });
  else log(`exported ${taskId} -> ${outPath}`);
}

// ---------- entry ----------

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  try {
    switch (args.command) {
      case "":
      case "help":
        process.stderr.write(USAGE);
        return args.command ? 0 : 2;
      case "init": return await wrap(args, () => cmdInit(args));
      case "doctor": return await wrap(args, () => cmdDoctor(args));
      case "tasks": return await wrap(args, () => cmdTasks(args));
      case "ask": return await wrap(args, () => cmdAsk(args));
      case "chat": return await wrap(args, () => cmdChat(args));
      case "workshop": return await wrap(args, () => cmdWorkshop(args));
      case "arbitrate": return await wrap(args, () => cmdArbitrate(args));
      case "verdict": return await wrap(args, () => cmdVerdict(args));
      case "export": return await wrap(args, () => cmdExport(args));
      default:
        fail(`unknown command: ${args.command}\n\n${USAGE}`, 2);
    }
  } catch (e) {
    if (e instanceof CliError) {
      if (args.json) printJson({ ok: false, error: e.message });
      else console.error(`error: ${e.message}`);
      return e.code;
    }
    if (args.json) printJson({ ok: false, error: String((e as Error)?.message ?? e) });
    else console.error(`error: ${(e as Error)?.stack ?? e}`);
    return 1;
  }
}

async function wrap(_args: ParsedArgs, fn: () => Promise<void>): Promise<number> {
  await fn();
  return 0;
}
