#!/usr/bin/env bun
// file-turn — turn handler that lets an interactive agent (e.g. Moseph in an
// OpenClaw session) be the brain of a bus participant.
//
// join-channel.ts spawns this per turn (--command). It writes the TurnContext
// to <dir>/pending-turn.json, waits for the agent to write <dir>/reply.json
// ({"body": "...", "signal": "continue|pass|propose_close|abort"}), consumes
// it, and prints the reply JSON on stdout for join-channel to publish.
//
// The agent loop: watch pending-turn.json, read it, compose a reply, write
// reply.json. The auditor's idle timeout (default 120s after the first turn)
// bounds how long you may take — pass --idle-timeout to `team chat` for more.
//
// Usage (from join-channel):
//   --command "bun bin/file-turn.ts --dir <handshake-dir> [--timeout-ms 110000]"

import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flags = new Map<string, string>();
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) {
    flags.set(argv[i].slice(2), argv[i + 1] ?? "");
    i++;
  }
}
const dir = flags.get("dir");
if (!dir) {
  process.stderr.write("usage: bun bin/file-turn.ts --dir <handshake-dir> [--timeout-ms 110000]\n");
  process.exit(2);
}
const timeoutMs = Number(flags.get("timeout-ms") ?? "110000"); // stay under the 120s idle timeout

mkdirSync(dir, { recursive: true });
const pendingPath = join(dir, "pending-turn.json");
const replyPath = join(dir, "reply.json");

// A reply.json left over from a previous turn must never be consumed as this
// turn's answer — clear it before publishing the pending turn.
try { unlinkSync(replyPath); } catch {}

const ctx = await new Response(Bun.stdin.stream()).text();
// atomic handoff: tmp + rename
writeFileSync(pendingPath + ".tmp", ctx);
const c = JSON.parse(ctx);
process.stderr.write(
  `[file-turn] pending turn from ${c.peerTurn?.author ?? "(opening)"} — write ${replyPath} with {"body","signal"}\n`
);
// rename publishes the pending turn
await Bun.write(pendingPath, readFileSync(pendingPath + ".tmp"));
unlinkSync(pendingPath + ".tmp");

const deadline = Date.now() + timeoutMs;
while (!existsSync(replyPath)) {
  if (Date.now() > deadline) {
    process.stderr.write(`[file-turn] timeout after ${timeoutMs}ms — yielding (pass)\n`);
    try { unlinkSync(pendingPath); } catch {}
    console.log(JSON.stringify({ body: "(no reply in time)", signal: "pass" }));
    process.exit(0);
  }
  await Bun.sleep(150);
}

// consume the reply atomically-ish: read then remove before echoing
const replyText = readFileSync(replyPath, "utf8");
unlinkSync(replyPath);
// Drop the pending turn too: while it exists it means "a turn is awaiting the
// agent's reply". A watcher can then wake the agent on its appearance, and
// there is no stale-file race on the next turn.
try { unlinkSync(pendingPath); } catch {}
let reply: Record<string, unknown>;
try {
  reply = JSON.parse(replyText) as Record<string, unknown>;
} catch {
  reply = { body: replyText, signal: "continue" }; // bare text is a valid body
}
if (typeof reply.body !== "string") reply = { body: String(reply.body ?? replyText), signal: "continue" };
process.stderr.write(`[file-turn] reply consumed: signal=${reply.signal ?? "continue"}\n`);
console.log(JSON.stringify(reply));
process.exit(0);
