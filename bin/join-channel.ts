#!/usr/bin/env bun
// join-channel — participant-side runner for a `team chat` bus channel.
//
// The orchestrator (`team chat --agents a,b`) provisions a channel on the
// relay and prints one-time claim URLs per side. This script is the missing
// participant entry point: redeem the claim (or reuse persisted secrets),
// then run ParticipantRuntime until the chat ends.
//
// Usage:
//   bun bin/join-channel.ts --claim <url> --peer <id> [reply mode] [flags]
//
// The claim URL is single-use: the redeemed bundle (token + channel secret)
// is persisted to <state-dir>/bus.join.json (0600) immediately, so a restart
// rejoins from disk — pass --state-dir again WITHOUT --claim to resume.
//
// Reply modes (how each turn's body is produced):
//   --command "<cmd>"   spawn per turn; TurnContext JSON on stdin; stdout is
//                       {"body","signal"} JSON or a TEAM_RESULT_V1 envelope
//   --body "<text>"     fixed body every turn
//   --echo              "[id] echo re:<peer seq>" (smoke tests)
//
// Flags:
//   --signal <s>        continue|pass|propose_close|abort (with --body/--echo)
//   --close-after <n>   emit propose_close once this side has spoken n turns
//   --state-dir <dir>   durable state (default .team/join/<channel>-<me>)
//   --turn-timeout <ms> per-turn command timeout (default 600000)
//   --poll-wait <ms>    long-poll wait (default 1000)

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { claimBusSecrets } from "../src/bus/session.ts";
import { ParticipantRuntime, type TurnContext } from "../src/bus/participant.ts";
import { CHAT_SIGNALS } from "../src/chat.ts";
import type { ChatSignal } from "../src/types.ts";

function usage(code = 2): never {
  process.stderr.write(
    [
      "usage: bun bin/join-channel.ts --claim <url> --peer <id> [--command <cmd> | --body <text> | --echo]",
      "       bun bin/join-channel.ts --state-dir <dir>   (resume from persisted secrets)",
      "flags: --signal <s> --close-after <n> --turn-timeout <ms> --poll-wait <ms>",
    ].join("\n") + "\n"
  );
  process.exit(code);
}

// ---- arg parsing ----
const argv = process.argv.slice(2);
const flags = new Map<string, string>();
const BOOL_FLAGS = new Set(["echo"]);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith("--")) usage();
  const key = a.slice(2);
  if (BOOL_FLAGS.has(key)) {
    flags.set(key, "1");
    continue;
  }
  const val = argv[i + 1];
  if (val === undefined || val.startsWith("--")) usage();
  flags.set(key, val);
  i++;
}
if (flags.size === 0) usage();

const claimUrl = flags.get("claim");
const stateDirFlag = flags.get("state-dir");
const signalFlag = flags.get("signal") as ChatSignal | undefined;
if (signalFlag && !CHAT_SIGNALS.includes(signalFlag)) {
  process.stderr.write(`error: --signal must be one of ${CHAT_SIGNALS.join("|")}\n`);
  process.exit(2);
}
const closeAfter = Number(flags.get("close-after") ?? "0");
const turnTimeoutMs = Number(flags.get("turn-timeout") ?? "600000");
const pollWaitMs = Number(flags.get("poll-wait") ?? "1000");

// ---- secrets: redeem the claim once, then persist (0600) ----
interface JoinSecrets {
  busUrl: string;
  channel: string;
  epoch: string;
  participant: string;
  token: string;
  secret: string;
  peer: string;
}

function secretsPath(dir: string): string {
  return join(dir, "bus.join.json");
}

async function resolveSecrets(): Promise<{ secrets: JoinSecrets; stateDir: string }> {
  if (claimUrl) {
    const peer = flags.get("peer");
    if (!peer) {
      process.stderr.write("error: --claim requires --peer <peer participant id> (see the connection instructions the orchestrator printed)\n");
      process.exit(2);
    }
    const bundle = await claimBusSecrets(claimUrl);
    const dir = stateDirFlag ?? join(".team", "join", `${bundle.channel}-${bundle.participant}`);
    mkdirSync(dir, { recursive: true });
    const s: JoinSecrets = { ...bundle, peer };
    writeFileSync(secretsPath(dir), JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
    process.stderr.write(
      `[join] claimed channel=${s.channel} epoch=${s.epoch} me=${s.participant} peer=${peer}\n` +
        `[join] secrets persisted (0600): ${secretsPath(dir)} — the claim URL is now dead; resume with --state-dir ${dir}\n`
    );
    return { secrets: s, stateDir: dir };
  }
  if (stateDirFlag) {
    const p = secretsPath(stateDirFlag);
    if (!existsSync(p)) {
      process.stderr.write(`error: no persisted secrets at ${p} — pass --claim <url> --peer <id> to join\n`);
      process.exit(2);
    }
    const s = JSON.parse(readFileSync(p, "utf8")) as JoinSecrets;
    process.stderr.write(`[join] resumed channel=${s.channel} me=${s.participant} peer=${s.peer} from ${p}\n`);
    return { secrets: s, stateDir: stateDirFlag };
  }
  usage();
}

const { secrets, stateDir } = await resolveSecrets();

// ---- turn handler ----
const commandMode = flags.get("command");
const fixedBody = flags.get("body");
const echoMode = flags.has("echo");
if ([commandMode, fixedBody, echoMode].filter(Boolean).length !== 1) {
  process.stderr.write("error: exactly one reply mode required: --command <cmd> | --body <text> | --echo\n");
  process.exit(2);
}

let ownTurns = 0;

function parseEnvelope(stdout: string): { body: string; signal?: ChatSignal } | null {
  const m = /<<<TEAM_RESULT_V1\n([\s\S]*?)\nTEAM_RESULT_V1>>>/.exec(stdout);
  const jsonText = m ? m[1] : stdout;
  try {
    const j = JSON.parse(jsonText.trim()) as Record<string, unknown>;
    if (typeof j.body !== "string") return null;
    const signal = typeof j.signal === "string" && (CHAT_SIGNALS as string[]).includes(j.signal)
      ? (j.signal as ChatSignal)
      : undefined;
    return { body: j.body, signal };
  } catch {
    return null;
  }
}

async function commandTurn(ctx: TurnContext): Promise<{ body: string; signal?: ChatSignal }> {
  const proc = Bun.spawn(["sh", "-c", commandMode!], {
    stdin: new Response(JSON.stringify(ctx)),
    stdout: "pipe",
    stderr: "inherit",
    env: {
      ...process.env,
      TEAM_CHANNEL: ctx.channel,
      TEAM_PARTICIPANT: ctx.agentId,
      TEAM_PEER: ctx.peerId,
      TEAM_TOPIC: ctx.topic ?? "",
      // the handler's real budget: it must yield before the kill below, or the
      // runtime publishes a junk "(turn handler failed)" turn instead.
      TEAM_TURN_TIMEOUT_MS: String(turnTimeoutMs),
    },
  });
  const timer = setTimeout(() => proc.kill(), turnTimeoutMs);
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  clearTimeout(timer);
  if (proc.exitCode !== 0) {
    process.stderr.write(`[join] turn command exited ${proc.exitCode} — yielding (pass)\n`);
    return { body: "(turn handler failed)", signal: "pass" };
  }
  const parsed = parseEnvelope(stdout);
  if (!parsed) {
    // Unstructured stdout is still a turn: commit it verbatim, keep going.
    return { body: stdout.trim() || "(empty turn output)", signal: signalFlag ?? "continue" };
  }
  return { body: parsed.body, signal: parsed.signal ?? signalFlag ?? "continue" };
}

const onTurn = async (ctx: TurnContext): Promise<{ body: string; signal?: ChatSignal }> => {
  ownTurns += 1;
  let out: { body: string; signal?: ChatSignal };
  if (commandMode) out = await commandTurn(ctx);
  else if (fixedBody) out = { body: fixedBody, signal: signalFlag ?? "continue" };
  else out = {
    body: `[${ctx.agentId}] echo re:${ctx.peerTurn ? ctx.peerTurn.seq : "opening"} (turn ${ownTurns})`,
    signal: signalFlag ?? "continue",
  };
  if (closeAfter > 0 && ownTurns >= closeAfter) out.signal = "propose_close";
  process.stderr.write(`[join] turn ${ownTurns} -> signal=${out.signal ?? "continue"} body=${out.body.slice(0, 120)}\n`);
  return out;
};

// ---- run ----
const runtime = new ParticipantRuntime({
  busUrl: secrets.busUrl,
  channel: secrets.channel,
  epoch: secrets.epoch,
  token: secrets.token,
  secret: secrets.secret,
  agentId: secrets.participant,
  peerId: secrets.peer,
  stateDir,
  pollWaitMs,
  onTurn,
  hooks: {
    onAcceptedTurn: (t) => {
      process.stderr.write(`[join] accepted ${t.author} seq=${t.seq}: ${t.body.slice(0, 200)}\n`);
    },
    onPublish: (msgId, seq) => process.stderr.write(`[join] published ${msgId} -> seq=${seq}\n`),
    onEnd: (reason) => process.stderr.write(`[join] chat_ended reason=${reason}\n`),
  },
});

process.stderr.write(`[join] connected to ${secrets.busUrl}/c/${secrets.channel} as ${secrets.participant} — polling\n`);
const result = await runtime.run();
const transcript = runtime.transcript;
console.log(JSON.stringify({
  ok: true,
  channel: secrets.channel,
  participant: secrets.participant,
  ended: result.ended,
  turns: result.turns,
  transcript: transcript.map((t) => ({ seq: t.seq, author: t.author, body: t.body })),
}, null, 2));
process.exit(result.ended ? 0 : 1);
