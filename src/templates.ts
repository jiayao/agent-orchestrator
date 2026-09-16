// Scaffold contents written by `team init` and shipped under examples/.

export const TEAM_TOML = `schema_version = 1
team = "default"

[defaults]
timeout_ms = 100000          # under omp's ~110s practical ceiling
max_output_bytes = 200000
concurrency = 3

[budgets]
max_runs = 8
max_wall_time_ms = 600000
max_estimated_cost_usd = 5.00

# Pairwise chat tuning (v0.1)
[chat]
max_turns = 10               # substantive turns cap; end_reason=expired
history_budget_chars = 12000 # transcript budget, enforced in estimated tokens
console_timeout_ms = 600000  # wall-clock per console turn

# stderr -> status classification table (first match wins).
# New failure modes are a TOML edit, not a release.
[[stderr_patterns]]
pattern = "rate.?limit|HTTP 429|too many requests"
status = "rate_limited"

[[stderr_patterns]]
pattern = "unauthorized|invalid api key|not logged in|HTTP 401|403"
status = "auth_error"

# Secret patterns redacted before anything is persisted.
# [redact]
# patterns = ["sk-[A-Za-z0-9]+"]

[[roles]]
name = "critic"
instructions = """
You are a critic, not a co-author. Identify the three weakest points:
concrete defects, unsupported assumptions, failure modes. Do NOT rewrite
the artifact.
"""

# --- Mock echo agents (zero auth; the demo harness) ---

[[agents]]
id = "echo-a"
adapter = "echo"
model = "mock"
role = "critic"
cost_tier = "low"
cost_per_run_usd = 0.0

[agents.command]
executable = "bun"
args = ["echo-agent.ts", "--name", "echo-a"]
stdin = "prompt"             # prompt piped on stdin

[[agents]]
id = "echo-b"
adapter = "echo"
model = "mock"
role = "critic"
cost_tier = "low"
cost_per_run_usd = 0.0

[agents.command]
executable = "bun"
args = ["echo-agent.ts", "--name", "echo-b"]
stdin = "prompt"

# --- Real agent profiles (uncomment when omp/codex are installed) ---
# stdin-pipe profile:
# [[agents]]
# id = "kimi"
# adapter = "omp"
# model = "fireworks/kimi-k3"
# role = "critic"
# cost_tier = "low"
# cost_per_run_usd = 0.05
# [agents.command]
# executable = "omp"
# args = ["-p", "--no-session"]
# stdin = "prompt"
#
# argv-placeholder profile:
# [[agents]]
# id = "codex"
# adapter = "codex"
# model = "gpt-5.6-sol"
# role = "critic"
# cost_tier = "high"
# [agents.command]
# executable = "codex"
# args = ["exec", "--skip-git-repo-check", "{prompt}"]
# stdin = "null"             # always, or codex blocks on stdin
#
# grok profile (chat-capable; auth via GROK_API_KEY in the environment):
# [[agents]]
# id = "grok"
# adapter = "grok"
# role = "critic"
# auth_env = "GROK_API_KEY"  # passed through to the child; doctor reports presence
# [agents.command]
# executable = "grok"
# args = ["-p", "{prompt}"]
# stdin = "null"
#
# console agent: the orchestrator prints the transcript and blocks for a live
# operator reply (this is how a human — or a wrapping agent — takes a turn):
# [[agents]]
# id = "me"
# kind = "console"
# role = "critic"
#
# bus agent (v0.2): a peer on an outbound-only relay channel — for agents that
# can't accept inbound connections. "team bus-serve" runs a local dev relay;
# "team chat --agents a,b" provisions the channel and mints the token that
# goes in token_env:
# [[agents]]
# id = "grok"
# kind = "bus"
# bus_url = "http://127.0.0.1:8787"
# token_env = "TEAM_BUS_TOKEN_GROK"
`;

export const ECHO_AGENT = `#!/usr/bin/env bun
// Mock echo agent — the zero-auth test harness and demo adapter.
// Reads the prompt from stdin (or a positional arg), emits one
// TEAM_EVENT_V1 envelope mid-stream and a final TEAM_RESULT_V1 envelope.

const argv = process.argv.slice(2);
let name = "echo";
let promptArg: string | undefined;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--name") name = argv[++i] ?? name;
  else if (!argv[i].startsWith("-") && promptArg === undefined) promptArg = argv[i];
}

let prompt = promptArg ?? "";
if (!prompt) prompt = await new Response(Bun.stdin.stream()).text();

const round = Number(prompt.match(/^ROUND: (\\d+)/m)?.[1] ?? "1");
const isChat = prompt.includes("CHAT TURN CONTRACT");
const priorTurns = (prompt.match(/^\\[evt_\\d+\\] [^\\n]*\\(signal=/gm) ?? []).length;
const firstEvt = prompt.match(/\\[(evt_\\d+)\\]/)?.[1] ?? null;
const artHash = prompt.match(/ARTIFACT \\(sha256:([0-9a-f]{12})/)?.[1] ?? "unknown";

const emit = (kind: string, obj: unknown) =>
  console.log("<<<" + kind + "\\n" + JSON.stringify(obj) + "\\n" + kind + ">>>");

if (isChat) {
  // Chat turn: echo the transcript size, propose close once 2+ turns exist.
  // Override the signal with ECHO_SIGNAL env (e.g. "pass", "abort").
  const signal = process.env.ECHO_SIGNAL ?? (priorTurns >= 2 ? "propose_close" : "continue");
  emit("TEAM_EVENT_V1", {
    type: "message",
    body: \`[\${name}] thinking about turn \${priorTurns + 1} (mock)\`,
  });
  emit("TEAM_RESULT_V1", {
    body: \`[\${name}] chat reply: saw \${priorTurns} prior turn(s) on the topic (echo adapter)\`,
    signal,
  });
} else if (round <= 1) {
  emit("TEAM_EVENT_V1", {
    type: "issue",
    body: \`[\${name}] weakest point in artifact \${artHash}: unverified assumptions need scrutiny (mock finding)\`,
    claims: [\`mock claim from \${name}\`],
  });
  emit("TEAM_RESULT_V1", {
    type: "critique",
    summary: \`[\${name}] mock critique of artifact \${artHash}: identified 3 weakest points — assumptions, missing failure-mode analysis, unbounded scope. (echo adapter)\`,
    claims: [
      "artifact makes unsupported assumptions (mock)",
      "failure modes are not enumerated (mock)",
      "scope is unbounded (mock)",
    ],
    replies: [],
  });
} else {
  emit("TEAM_EVENT_V1", {
    type: "reply",
    reply_to: firstEvt,
    body: \`[\${name}] cross-reviewing \${firstEvt ?? "the round"}: partial agreement — the assumptions critique stands, severity is debatable (mock)\`,
  });
  emit("TEAM_RESULT_V1", {
    type: "position",
    summary: \`[\${name}] mock cross-review position for round \${round}: converging on 'assumptions' as the top issue (echo adapter)\`,
    claims: ["converged on top issue (mock)"],
    replies: firstEvt
      ? [{ reply_to: firstEvt, body: \`[\${name}] agrees with the core issue raised (mock)\` }]
      : [],
  });
}
`;

export const EXAMPLE_ARTIFACT = `# Example artifact under review

## Proposal: ship a cached settings endpoint

We will add a \`GET /settings\` endpoint backed by a 60-second in-process
cache. The cache key is the user's session id. Settings rarely change, so
staleness is acceptable.

## Assumptions

- Settings writes are rare (no invalidation path needed).
- In-process cache is fine because we run a single replica.
- Session ids are stable across deploys.

## Failure modes

(none listed)
`;
