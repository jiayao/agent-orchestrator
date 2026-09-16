#!/usr/bin/env bun
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

const round = Number(prompt.match(/^ROUND: (\d+)/m)?.[1] ?? "1");
const isChat = prompt.includes("CHAT TURN CONTRACT");
const priorTurns = (prompt.match(/^\[evt_\d+\] [^\n]*\(signal=/gm) ?? []).length;
const firstEvt = prompt.match(/\[(evt_\d+)\]/)?.[1] ?? null;
const artHash = prompt.match(/ARTIFACT \(sha256:([0-9a-f]{12})/)?.[1] ?? "unknown";

const emit = (kind: string, obj: unknown) =>
  console.log("<<<" + kind + "\n" + JSON.stringify(obj) + "\n" + kind + ">>>");

if (isChat) {
  // Chat turn: echo the transcript size, propose close once 2+ turns exist.
  // Override the signal with ECHO_SIGNAL env (e.g. "pass", "abort").
  const signal = process.env.ECHO_SIGNAL ?? (priorTurns >= 2 ? "propose_close" : "continue");
  emit("TEAM_EVENT_V1", {
    type: "message",
    body: `[${name}] thinking about turn ${priorTurns + 1} (mock)`,
  });
  emit("TEAM_RESULT_V1", {
    body: `[${name}] chat reply: saw ${priorTurns} prior turn(s) on the topic (echo adapter)`,
    signal,
  });
} else if (round <= 1) {
  emit("TEAM_EVENT_V1", {
    type: "issue",
    body: `[${name}] weakest point in artifact ${artHash}: unverified assumptions need scrutiny (mock finding)`,
    claims: [`mock claim from ${name}`],
  });
  emit("TEAM_RESULT_V1", {
    type: "critique",
    summary: `[${name}] mock critique of artifact ${artHash}: identified 3 weakest points — assumptions, missing failure-mode analysis, unbounded scope. (echo adapter)`,
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
    body: `[${name}] cross-reviewing ${firstEvt ?? "the round"}: partial agreement — the assumptions critique stands, severity is debatable (mock)`,
  });
  emit("TEAM_RESULT_V1", {
    type: "position",
    summary: `[${name}] mock cross-review position for round ${round}: converging on 'assumptions' as the top issue (echo adapter)`,
    claims: ["converged on top issue (mock)"],
    replies: firstEvt
      ? [{ reply_to: firstEvt, body: `[${name}] agrees with the core issue raised (mock)` }]
      : [],
  });
}
