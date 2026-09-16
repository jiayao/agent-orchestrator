#!/usr/bin/env bun
// peek-channel — read-only decrypt of a bus channel's relay log.
// Usage: bun bin/peek-channel.ts
// Reads state from the persisted claim bundle path passed as --state-dir,
// or defaults to ../../.team/join/claim.json (workspace claim.json shape).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decryptPayload } from "../src/bus/crypto.ts";

const argv = process.argv.slice(2);
const flags = new Map<string, string>();
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) {
    flags.set(argv[i].slice(2), argv[i + 1] ?? "");
    i++;
  }
}

type Secrets = { busUrl?: string; channel: string; secret?: string; channel_secret?: string; participant?: string; token: string };

let s: Secrets;
const stateDir = flags.get("state-dir");
if (stateDir) {
  s = JSON.parse(readFileSync(join(stateDir, "bus.join.json"), "utf8")) as Secrets;
} else {
  const p = flags.get("secrets") ?? join(process.cwd(), "..", ".team", "join", "claim.json");
  s = JSON.parse(readFileSync(p, "utf8")) as Secrets;
}
const secret = s.secret ?? s.channel_secret!;
const busUrl = (s.busUrl ?? flags.get("bus-url") ?? "https://agent-bus-relay.fly.dev").replace(/\/+$/, "");

const res = await fetch(`${busUrl}/c/${encodeURIComponent(s.channel)}/messages?since=0&wait=0`, {
  headers: { authorization: `Bearer ${s.token}` },
});
const body = (await res.json()) as { messages: Array<Record<string, unknown>>; latest: number };
process.stderr.write(`[peek] channel=${s.channel} me=${s.participant ?? "?"} latest=${body.latest}\n`);
for (const m of body.messages) {
  let text: string;
  try {
    text = decryptPayload(secret, s.channel, m.msg_id as string, {
      nonce: m.nonce as string,
      ct: m.ct as string,
    });
  } catch (e) {
    text = `<decrypt failed: ${(e as Error).message}>`;
  }
  console.log(`--- seq=${m.seq} author=${m.author} ts=${m.ts} msg_id=${m.msg_id}`);
  console.log(text);
}
