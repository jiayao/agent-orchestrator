// Bus session (v0.2): `team chat --agents a,b` with kind="bus" agents.
// Provisioning is this command — the trusted channel: it mints a random
// channel id + epoch, one bearer token per participant (plus the auditor's
// "orchestrator" token), and the shared channel secret; registers the channel
// with the relay over the admin API; writes secrets to bus.secret.json in the
// task dir; prints connection instructions per side; then starts the auditor.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Blackboard } from "../blackboard.ts";
import type { AgentConfig, TaskMeta, TeamConfig } from "../types.ts";
import type { ChatSummary } from "../chat.ts";
import { adminProvisionChannel, BusClient } from "./client.ts";
import { newChannelSecret, newId, newToken } from "./crypto.ts";
import { runBusAuditor, type BusAuditorOptions } from "./auditor.ts";

export interface BusSecrets {
  channel_secret: string;
  /** author -> bearer token */
  tokens: Record<string, string>;
}

export interface BusProvision {
  busUrl: string;
  channel: string;
  epoch: string;
  secret: string;
  /** participant id -> bearer token (includes "orchestrator") */
  tokens: Record<string, string>;
  firstSpeaker: string;
}

/** The file in the task dir holding channel secret + tokens (mode 0600). */
export function busSecretsPath(bb: Blackboard, taskId: string): string {
  return join(bb.taskDir(taskId), "bus.secret.json");
}

export function writeBusSecrets(bb: Blackboard, taskId: string, secrets: BusSecrets): void {
  writeFileSync(busSecretsPath(bb, taskId), JSON.stringify(secrets, null, 2) + "\n", {
    mode: 0o600,
  });
}

export function readBusSecrets(bb: Blackboard, taskId: string): BusSecrets {
  return JSON.parse(
    readFileSync(busSecretsPath(bb, taskId), "utf8")
  ) as BusSecrets;
}

/**
 * Provision a fresh channel on the relay for a bus chat: random channel id +
 * epoch, per-participant bearer tokens, channel secret. Returns everything
 * needed to print connection instructions and start the auditor.
 */
export async function provisionBusChat(
  busUrl: string,
  adminToken: string,
  agents: [AgentConfig, AgentConfig]
): Promise<BusProvision> {
  const channel = newId("chat-");
  const epoch = newId("e-");
  const secret = newChannelSecret();
  const tokens: Record<string, string> = {
    [agents[0].id]: newToken(),
    [agents[1].id]: newToken(),
    orchestrator: newToken(),
  };
  await adminProvisionChannel(busUrl, adminToken, { channel, epoch, tokens });
  return { busUrl, channel, epoch, secret, tokens, firstSpeaker: agents[0].id };
}

/**
 * Human/agent-facing connection instructions, printed per side at
 * provisioning. The participant protocol in one block — enough for grok's
 * loop or Juno's hook to implement it from the wire alone.
 */
export function connectionInstructions(
  prov: BusProvision,
  agent: AgentConfig,
  peerId: string
): string {
  const token = prov.tokens[agent.id];
  return [
    `--- connection instructions for ${agent.id} ---`,
    `bus_url:    ${prov.busUrl}`,
    `channel:    ${prov.channel}`,
    `epoch:      ${prov.epoch}`,
    `peer:       ${peerId}`,
    `export ${agent.token_env ?? "TEAM_BUS_TOKEN"}=${token}`,
    `channel_secret: ${prov.secret}   (shared; decrypts every message on this channel)`,
    ``,
    `participant protocol:`,
    `  GET  ${prov.busUrl}/c/${prov.channel}/messages?since=<seq>&wait=<ms>`,
    `       (Authorization: Bearer $${agent.token_env ?? "TEAM_BUS_TOKEN"}; long-poll subscribe)`,
    `  POST ${prov.busUrl}/c/${prov.channel}/messages`,
    `       body {"msg_id","nonce","ct"} — payload AEAD-encrypted under channel_secret`,
    `       (AES-256-GCM, AAD = "<channel>:<msg_id>", nonce||ct base64)`,
    `  turn payload: {"v":1,"type":"turn","in_reply_to":<peer turn seq|null>,"body","signal"?}`,
    `  reply msg_id: "${agent.id}@${prov.epoch}:re<in_reply_to|0>" — stable, retries are free`,
    `  speak only when the peer's turn is the latest accepted one; control`,
    `  messages (author "orchestrator") start and end the chat.`,
  ].join("\n");
}

/**
 * Run a provisioned bus chat: start the auditor against the relay and block
 * until the chat ends (or the signal aborts). Shared by `team chat` (fresh
 * provisioning) and `team chat --resume` (secrets reloaded from disk).
 */
export async function runBusChatSession(
  bb: Blackboard,
  config: TeamConfig,
  meta: TaskMeta,
  opts: BusAuditorOptions = {}
): Promise<ChatSummary> {
  const bus = meta.chat?.bus;
  if (!bus) throw new Error(`task ${meta.id} has no bus provisioning`);
  const secrets = readBusSecrets(bb, meta.id);
  const client = new BusClient({
    busUrl: bus.bus_url,
    channel: bus.channel,
    token: secrets.tokens.orchestrator,
    secret: secrets.channel_secret,
  });
  return runBusAuditor(
    bb,
    config,
    meta,
    client,
    {
      busUrl: bus.bus_url,
      channel: bus.channel,
      epoch: bus.epoch,
      agents: bus.participants,
      firstSpeaker: bus.first_speaker,
      topic: meta.chat?.topic ?? bb.readArtifact(meta.id),
    },
    opts
  );
}
