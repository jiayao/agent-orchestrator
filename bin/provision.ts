#!/usr/bin/env bun
// provision — create a fresh bus channel and print everything needed:
// channel coords, claim URLs, and the auditor resume id. Writes secrets to
// the task's bus.secret.json (0600) and claim URLs to claims.json (0600) so
// they survive the process (the stock `team chat` prints them to stderr and
// then blocks in the auditor).

import { mkdirSync, writeFileSync } from "node:fs";
import { loadConfig, sha256 } from "../src/config.ts";
import { Blackboard, newTaskId } from "../src/blackboard.ts";
import { provisionBusChat, writeBusSecrets } from "../src/bus/session.ts";
import type { AgentConfig, TaskMeta } from "../src/types.ts";

const argv = process.argv.slice(2);
const flags = new Map<string, string>();
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) {
    flags.set(argv[i].slice(2), argv[i + 1] ?? "");
    i++;
  }
}

const configPath = flags.get("config") ?? `${process.cwd()}/team.toml`;
const topic = flags.get("topic");
if (!topic) {
  process.stderr.write('usage: bun bin/provision.ts --config <team.toml> --topic "..." [--agents a,b] [--ttl-ms n]\n');
  process.exit(2);
}
const adminToken = process.env.TEAM_BUS_ADMIN_TOKEN;
if (!adminToken) {
  process.stderr.write("error: TEAM_BUS_ADMIN_TOKEN not set in the environment\n");
  process.exit(2);
}

const config = await loadConfig(configPath);
const ids = (flags.get("agents") ?? config.agents.map((a) => a.id).join(",")).split(",");
const picked = ids.map((id) => {
  const a = config.agents.find((x) => x.id === id);
  if (!a) throw new Error(`unknown agent ${JSON.stringify(id)}`);
  if (a.kind !== "bus") throw new Error(`agent ${id} is kind ${a.kind}, not bus`);
  return a as AgentConfig;
});
if (picked.length !== 2) throw new Error(`need exactly two agents (got ${picked.length})`);
const busUrl = picked[0].bus_url!;
if (picked[1].bus_url !== busUrl) throw new Error("both agents must share one bus_url");

mkdirSync(config.root + "/.team", { recursive: true });
const bb = new Blackboard(`${config.root}/.team`);
const id = newTaskId();
const now = new Date().toISOString();
const meta: TaskMeta = {
  id,
  kind: "chat",
  state: "created",
  created_at: now,
  updated_at: now,
  started_at: now,
  artifact_sha256: sha256(topic),
  artifact_label: "topic",
  team_sha256: config.hash,
  agents: picked.map((a) => a.id),
  rounds_planned: config.chat.max_turns,
  completed_rounds: 0,
  runs_completed: 0,
  estimated_cost_usd: 0,
};
meta.chat = {
  topic,
  max_turns: config.chat.max_turns,
  history_budget_chars: config.chat.history_budget_chars,
  console_timeout_ms: config.chat.console_timeout_ms,
  substantive_turns: 0,
  total_turns: 0,
};

bb.initTask(meta, topic);

const ttlMs = Number(flags.get("ttl-ms") ?? "3600000");
const prov = await provisionBusChat(busUrl, adminToken, [picked[0], picked[1]] as [AgentConfig, AgentConfig], { claimTtlMs: ttlMs });
meta.chat.bus = {
  bus_url: prov.busUrl,
  channel: prov.channel,
  epoch: prov.epoch,
  participants: [picked[0].id, picked[1].id] as [string, string],
  first_speaker: prov.firstSpeaker,
  // the auditor publishes this on chat_started; without it the roster never
  // reaches the wire on the provision.ts path (the CLI path sets it itself)
  roster: prov.roster,
};
bb.writeMeta(meta);
writeBusSecrets(bb, id, { channel_secret: prov.secret, tokens: prov.tokens });

const claims: Record<string, unknown> = {};
for (const a of picked) {
  claims[a.id] = { url: prov.claims[a.id].claim_url, expires_at: prov.claims[a.id].expires_at };
}
const claimsPath = `${bb.taskDir(id)}/claims.json`;
writeFileSync(claimsPath, JSON.stringify(claims, null, 2) + "\n", { mode: 0o600 });
// Also seal the task meta's chat.bus into the file for easy reuse.
writeFileSync(`${bb.taskDir(id)}/channel.json`, JSON.stringify(meta.chat.bus, null, 2) + "\n", { mode: 0o600 });

console.log(JSON.stringify({ task_id: id, channel: prov.channel, epoch: prov.epoch, bus_url: prov.busUrl, claims }, null, 2));
