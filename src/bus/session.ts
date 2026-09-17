// Bus session (v0.2): `team chat --agents a,b` with kind="bus" agents.
// Provisioning is this command — the trusted channel: it mints a random
// channel id + epoch, one bearer token per participant (plus the auditor's
// "orchestrator" token), and the shared channel secret; registers the channel
// with the relay over the admin API; writes secrets to bus.secret.json in the
// task dir; prints connection instructions per side; then starts the auditor.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Blackboard } from "../blackboard.ts";
import type { AgentConfig, ChatSignal, RosterEntry, TaskMeta, TeamConfig } from "../types.ts";
import {
  consoleTurn,
  packChatPrompt,
  parseChatResult,
  type ChatSummary,
  type ConsoleIO,
} from "../chat.ts";
import { buildSpawnSpec, spawnAgent } from "../spawn.ts";
import type { AcceptedTurn } from "../chatcore.ts";
import {
  adminMintClaim,
  adminProvisionChannel,
  BusClient,
  fetchClaim,
  type ClaimBundle,
  type FetchFn,
} from "./client.ts";
import { newChannelSecret, newId, newToken } from "./crypto.ts";
import { runBusAuditor, type BusAuditorOptions } from "./auditor.ts";
import {
  ParticipantRuntime,
  type ParticipantOptions,
  type TranscriptTurn,
  type TurnContext,
  type TurnHandler,
} from "./participant.ts";

export interface BusSecrets {
  channel_secret: string;
  /** author -> bearer token */
  tokens: Record<string, string>;
}

export interface BusClaim {
  claim_id: string;
  claim_url: string;
  expires_at: string;
}

export interface BusProvision {
  busUrl: string;
  channel: string;
  epoch: string;
  secret: string;
  /** participant id -> bearer token (includes "orchestrator") */
  tokens: Record<string, string>;
  firstSpeaker: string;
  /** participant id -> one-time onboarding claim (single-use, TTL-bounded) */
  claims: Record<string, BusClaim>;
  /** presentation-only name roster published on chat_started */
  roster: RosterEntry[];
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
  agents: [AgentConfig, AgentConfig],
  opts: { claimTtlMs?: number } = {}
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
  // One-time claim per participant: the operator hands the remote side the
  // claim URL instead of pasting the long-lived token + channel secret into
  // a chat transcript. Local sides keep using bus.secret.json.
  const claims: Record<string, BusClaim> = {};
  for (const agent of agents) {
    const minted = await adminMintClaim(
      busUrl,
      adminToken,
      channel,
      agent.id,
      secret,
      opts.claimTtlMs ?? 3_600_000
    );
    claims[agent.id] = {
      claim_id: minted.claim_id,
      claim_url: `${busUrl.replace(/\/+$/, "")}/c/${channel}/claim/${minted.claim_id}`,
      expires_at: minted.expires_at,
    };
  }
  return {
    busUrl,
    channel,
    epoch,
    secret,
    tokens,
    firstSpeaker: agents[0].id,
    claims,
    roster: buildRoster(agents),
  };
}

/**
 * Build the presentation-only roster for a pair of agents. Names are labels,
 * not identities: the id is what the relay attests and what validation keys
 * on, so a missing or duplicate display_name is always safe here.
 */
export function buildRoster(agents: AgentConfig[]): RosterEntry[] {
  return agents.map((a) =>
    a.display_name ? { id: a.id, display_name: a.display_name } : { id: a.id }
  );
}

/**
 * Fetch a one-time claim URL and normalize it into participant options.
 * The caller should write the token + secret to a local 0600 file and
 * never paste them into chat — the claim URL is the only thing that ever
 * traveled through the chat transcript, and it is dead after this call.
 * The bundle also carries the relay-attested participant list: `peers` is
 * the provisioned peer id(s), learned here rather than inferred from the
 * first peer turn.
 */
export async function claimBusSecrets(
  claimUrl: string
): Promise<{
  busUrl: string;
  channel: string;
  epoch: string;
  participant: string;
  participants: string[];
  peers: string[];
  /** false when the relay predates attestation — `peers` is then empty */
  attested: boolean;
  token: string;
  secret: string;
}> {
  const bundle: ClaimBundle = await fetchClaim(claimUrl);
  const busUrl = new URL(claimUrl).origin;
  return {
    busUrl,
    channel: bundle.channel,
    epoch: bundle.epoch,
    participant: bundle.participant,
    participants: bundle.participants,
    peers: bundle.peers,
    attested: bundle.attested,
    token: bundle.token,
    secret: bundle.channel_secret,
  };
}

/**
 * What the joining side persists after redeeming a claim: the credentials
 * plus the relay-attested participant list, so the provisioned peer id is
 * on disk next to the token — never inferred from the first peer turn.
 */
export interface JoinCredentials {
  bus_url: string;
  channel: string;
  epoch: string;
  /** this side's participant id */
  participant: string;
  /** the channel's attested participant list, including `participant` */
  participants: string[];
  /** participants minus `participant` — the provisioned peer id(s) */
  peers: string[];
  /** false when the relay predates attestation: participants/peers above
   *  were supplied by the operator (`--peer`) rather than attested. */
  attested?: boolean;
  token: string;
  channel_secret: string;
}

/** File name inside a join state dir (mode 0600). */
export const JOIN_CREDENTIALS_FILE = "bus.credentials.json";

export function joinCredentialsPath(stateDir: string): string {
  return join(stateDir, JOIN_CREDENTIALS_FILE);
}

export function writeJoinCredentials(stateDir: string, creds: JoinCredentials): string {
  mkdirSync(stateDir, { recursive: true });
  const path = joinCredentialsPath(stateDir);
  writeFileSync(path, JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
  return path;
}

export function readJoinCredentials(stateDir: string): JoinCredentials {
  const j = JSON.parse(readFileSync(joinCredentialsPath(stateDir), "utf8")) as JoinCredentials;
  if (
    typeof j.bus_url !== "string" ||
    typeof j.channel !== "string" ||
    typeof j.epoch !== "string" ||
    typeof j.participant !== "string" ||
    !Array.isArray(j.participants) ||
    !j.participants.includes(j.participant) ||
    !Array.isArray(j.peers) ||
    j.peers.includes(j.participant) ||
    typeof j.token !== "string" ||
    typeof j.channel_secret !== "string"
  ) {
    throw new Error(`malformed join credentials in ${joinCredentialsPath(stateDir)}`);
  }
  return j;
}

/**
 * The join flow: redeem a one-time claim URL and persist the credentials
 * (incl. the provisioned peer list) to `<stateDir>/bus.credentials.json`
 * mode 0600. This is the ONLY thing the claim URL ever buys; it is dead
 * after this call.
 */
export async function joinBusChat(
  claimUrl: string,
  stateDir: string,
  opts: { peerHint?: string } = {}
): Promise<{ creds: JoinCredentials; path: string }> {
  const got = await claimBusSecrets(claimUrl);
  // A relay that predates attestation returns no participant list, so the
  // peer id has to come from provisioning knowledge. Require it explicitly:
  // guessing here would defeat the peer check the runtime performs.
  let participants = got.participants;
  let peers = got.peers;
  if (!got.attested) {
    const peer = opts.peerHint;
    if (!peer) {
      throw new Error(
        `relay did not attest participants for ${got.channel} — pass the peer id ` +
          `(from the orchestrator's connection instructions) to join`
      );
    }
    participants = [got.participant, peer];
    peers = [peer];
  }
  const creds: JoinCredentials = {
    bus_url: got.busUrl,
    channel: got.channel,
    epoch: got.epoch,
    participant: got.participant,
    participants,
    peers,
    attested: got.attested,
    token: got.token,
    channel_secret: got.secret,
  };
  const path = writeJoinCredentials(stateDir, creds);
  return { creds, path };
}

/**
 * Load a join state dir's credentials into ParticipantRuntime options.
 * The runtime is pairwise: exactly one provisioned peer is required, and
 * `peerId` always comes from the attested list — `over` is tunables only —
 * so the runtime's peer check compares wire authorship against what
 * provisioning actually attested, never against a hand-set value.
 */
export function participantOptionsFromJoin(
  stateDir: string,
  onTurn: TurnHandler,
  over: Partial<Pick<ParticipantOptions, "replyTimeoutMs" | "pollWaitMs" | "fetchFn" | "hooks">> = {}
): ParticipantOptions {
  const creds = readJoinCredentials(stateDir);
  if (creds.peers.length !== 1) {
    throw new Error(
      `pairwise runtime needs exactly one provisioned peer; ` +
        `channel ${creds.channel} ${creds.attested === false ? "was joined without attestation" : "attests"} ` +
        `participants=${JSON.stringify(creds.participants)}`
    );
  }
  return {
    busUrl: creds.bus_url,
    channel: creds.channel,
    epoch: creds.epoch,
    token: creds.token,
    secret: creds.channel_secret,
    agentId: creds.participant,
    peerId: creds.peers[0],
    stateDir,
    onTurn,
    ...over,
  };
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
  const claim = prov.claims[agent.id];
  return [
    `--- connection instructions for ${agent.id}${
      agent.display_name ? ` (${agent.display_name})` : ""
    } ---`,
    `bus_url:    ${prov.busUrl}`,
    `channel:    ${prov.channel}`,
    `epoch:      ${prov.epoch}`,
    `peer:       ${peerId}`,
    ``,
    `one-time claim URL (single-use, expires ${claim.expires_at}):`,
    `  ${claim.claim_url}`,
    `paste ONLY this URL into chat with the ${agent.id} side — never the token or channel secret.`,
    `on the ${agent.id} machine, fetch it once and store the result in a 0600 file:`,
    `  curl -s ${claim.claim_url}`,
    `  -> {"participant","participants","peers","token","channel_secret","channel","epoch"}`,
    `after this fetch the URL is dead; a leaked transcript copy is worthless.`,
    `"peers" is provisioning's attestation of your peer id — it must read`,
    `["${peerId}"]. if it doesn't, or a wire turn arrives authored by anyone`,
    `else, the channel is mis-provisioned: abort, do not chat.`,
    ``,
    `operator's local copy of all secrets: bus.secret.json in the task dir (0600).`,
    ``,
    `participant protocol:`,
    `  GET  ${prov.busUrl}/c/${prov.channel}/messages?since=<seq>&wait=<ms>`,
    `       (Authorization: Bearer <your token>; long-poll subscribe)`,
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
      // Older tasks predate the roster field; passing undefined publishes the
      // original wire shape.
      roster: bus.roster,
    },
    opts
  );
}

export type BusTurnAdapter = "echo" | "cli" | "console";

export interface BusRunOptions {
  /** the local agent to drive — must be one of bus.participants */
  agent: AgentConfig;
  /** how turns are produced: scripted echo | spawn a cli agent | human console */
  adapter?: BusTurnAdapter;
  /** echo adapter: propose_close once this many accepted turns exist */
  echoCloseAfter?: number;
  /** cap the whole turn (incl. spawn) — a null result publishes "pass" */
  replyTimeoutMs?: number;
  /** per-request long-poll wait; default 1s */
  pollWaitMs?: number;
  /** durable participant state dir; default <task>/participant-<id>/ */
  stateDir?: string;
  /** console adapter I/O + idle timeout */
  consoleIO?: ConsoleIO;
  consoleTimeoutMs?: number;
  /** transcript budget for the packed prompt; default from chat config */
  historyBudgetChars?: number;
  fetchFn?: FetchFn;
  signal?: AbortSignal;
  /** informational progress notes (adapter chosen, turn published, ...) */
  onNote?: (s: string) => void;
}

export interface BusRunSummary {
  agent: string;
  ended: string | null;
  /** accepted turns observed (including ours) when the run finished */
  turns: number;
}

/** TranscriptTurn -> the normalized AcceptedTurn shape prompt packing takes. */
const transcriptToAccepted = (t: TranscriptTurn): AcceptedTurn => ({
  seq: t.seq,
  actor: t.author,
  in_reply_to: t.in_reply_to,
  body: t.body,
  signal: t.signal ?? "continue",
  id: `seq-${t.seq}`,
});

/**
 * Run one bus participant end-to-end: ParticipantRuntime owns the poll /
 * outbox / retry loop; `adapter` picks how a turn's body+signal is produced.
 * This is what `team bus-run <task> --as <agent>` wraps.
 */
export async function runBusParticipant(
  bb: Blackboard,
  config: TeamConfig,
  meta: TaskMeta,
  opts: BusRunOptions
): Promise<BusRunSummary> {
  const bus = meta.chat?.bus;
  if (!bus) throw new Error(`task ${meta.id} has no bus provisioning`);
  const agentId = opts.agent.id;
  const peerId = bus.participants[0] === agentId ? bus.participants[1] : bus.participants[0];
  if (!peerId || !bus.participants.includes(agentId)) {
    throw new Error(`agent ${agentId} is not a participant of task ${meta.id}`);
  }
  const adapter: BusTurnAdapter =
    opts.adapter ??
    (opts.agent.adapter === "echo" ? "echo"
      : opts.agent.kind === "cli" ? "cli"
      : opts.agent.kind === "console" ? "console"
      : "echo");

  const secrets = readBusSecrets(bb, meta.id);
  const token = secrets.tokens[agentId];
  if (!token) throw new Error(`no bus token for ${agentId} in task ${meta.id}`);

  const budget =
    opts.historyBudgetChars ?? meta.chat?.history_budget_chars ?? config.chat.history_budget_chars;
  const pack = (ctx: TurnContext): string =>
    packChatPrompt({
      config,
      agent: opts.agent,
      peerId,
      topic: ctx.topic ?? meta.chat?.topic ?? bb.readArtifact(meta.id),
      turns: ctx.transcript.map(transcriptToAccepted),
      historyBudgetChars: budget,
    }).prompt;

  const closeAfter = Math.max(1, opts.echoCloseAfter ?? 4);
  const onTurn: TurnHandler = async (ctx) => {
    if (adapter === "echo") {
      // scripted participant — lets a two-sided bus chat run with no runtime
      const n = ctx.transcript.length + 1;
      const answering = ctx.peerTurn
        ? ` answering seq ${ctx.peerTurn.seq}: ${ctx.peerTurn.body.slice(0, 120)}`
        : "";
      return {
        body: `[${agentId}] echo turn ${n}${answering}`,
        signal: (ctx.transcript.length >= closeAfter ? "propose_close" : "continue") as ChatSignal,
      };
    }
    const prompt = pack(ctx);
    if (adapter === "cli") {
      if (!opts.agent.command) {
        throw new Error(`agent ${agentId} has kind=${opts.agent.kind} but no [agents.command]`);
      }
      const spec = buildSpawnSpec(opts.agent, config, prompt);
      const out = await spawnAgent(spec, prompt, config);
      const parsed = parseChatResult(out);
      return { body: parsed.body, signal: parsed.signal };
    }
    // console adapter — same operator path as local chat
    if (!opts.consoleIO) throw new Error("console adapter requires consoleIO");
    const res = await consoleTurn(
      opts.consoleIO,
      agentId,
      prompt,
      opts.consoleTimeoutMs ?? meta.chat?.console_timeout_ms ?? config.chat.console_timeout_ms
    );
    if (!res.ok) {
      return { body: `(operator cancelled: ${res.reason})`, signal: "abort" as ChatSignal };
    }
    return { body: res.body, signal: res.signal };
  };

  const stateDir = opts.stateDir ?? join(bb.taskDir(meta.id), `participant-${agentId}`);
  mkdirSync(stateDir, { recursive: true });

  const runtime = new ParticipantRuntime({
    busUrl: bus.bus_url,
    channel: bus.channel,
    epoch: bus.epoch,
    token,
    secret: secrets.channel_secret,
    agentId,
    peerId,
    stateDir,
    onTurn,
    replyTimeoutMs: opts.replyTimeoutMs,
    pollWaitMs: opts.pollWaitMs,
    fetchFn: opts.fetchFn,
    hooks: {
      onAcceptedTurn: (t: TranscriptTurn) =>
        opts.onNote?.(`accepted turn seq=${t.seq} author=${t.author} signal=${t.signal ?? "continue"}`),
      onPublish: (id: string, seq: number) => opts.onNote?.(`published ${id} seq=${seq}`),
      onEnd: (reason: string) => opts.onNote?.(`chat ended: ${reason}`),
    },
  });
  const res = await runtime.run(opts.signal);
  return { agent: agentId, ended: res.ended, turns: res.turns };
}
