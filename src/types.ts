// Shared types for the v0 orchestrator. Mirrors DESIGN.md.

export type StdinMode = "prompt" | "null";

export type AgentKind = "cli" | "console" | "bus";

export type ChatSignal = "continue" | "pass" | "propose_close" | "abort";

export type ChatEndReason =
  | "agreed" | "aborted" | "expired" | "budget" | "cancelled"
  | "idle_timeout";

export type RunStatus =
  | "succeeded"
  | "failed"
  | "timed_out"
  | "auth_error"
  | "rate_limited"
  | "output_limit"
  | "protocol_error"
  | "empty";

export type TaskState =
  | "created"
  | "running"
  | "awaiting_decision"
  | "completed"
  | "failed"
  | "cancelled";

export interface CommandProfile {
  executable: string;
  args: string[]; // "{prompt}" allowed in exactly one arg
  stdin: StdinMode;
}

export interface Role {
  name: string;
  instructions: string;
}

export interface AgentConfig {
  id: string;
  kind: AgentKind; // "cli" spawned subprocess | "console" live operator
  adapter: string;
  model?: string;
  role: string; // references [[roles]].name
  cost_tier?: string;
  cost_per_run_usd?: number;
  /** env var name that holds this agent's credential; passed through to the
   *  child and probed (presence only) by `team doctor` */
  auth_env?: string;
  command?: CommandProfile; // required for kind "cli", absent for "console"/"bus"
  env: Record<string, string>;
  // kind "bus" (v0.2): participant on a reachable relay channel
  bus_url?: string;
  channel?: string; // default/pinned channel; `team chat` provisions a fresh one per chat
  /** env var name holding this participant's bearer token (minted at provisioning) */
  token_env?: string;
}

export interface StderrPattern {
  pattern: string;
  status: RunStatus;
  regex: RegExp;
}

export interface TeamConfig {
  schema_version: number;
  team: string;
  defaults: {
    timeout_ms: number;
    max_output_bytes: number;
    concurrency: number;
  };
  budgets: {
    max_runs: number;
    max_wall_time_ms: number;
    max_estimated_cost_usd: number;
  };
  stderr_patterns: StderrPattern[];
  redact_patterns: RegExp[];
  chat: {
    max_turns: number;
    history_budget_chars: number;
    console_timeout_ms: number;
  };
  roles: Role[];
  agents: AgentConfig[];
  /** absolute path of the loaded team.toml */
  path: string;
  /** dir containing team.toml; .team/ lives here, spawns run from here */
  root: string;
  /** sha256 of the raw config file */
  hash: string;
}

export interface SpawnSpec {
  executable: string;
  args: string[]; // prompt already substituted
  stdin: StdinMode;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface RunResult {
  run_id: string;
  task_id: string;
  agent_id: string;
  round: number;
  status: RunStatus;
  exit_code: number | null;
  signal: string | null;
  started_at: string;
  ended_at: string;
  latency_ms: number;
  timed_out: boolean;
  output_limited: boolean;
  cost_usd: number | null; // null == unknown
  cost_source: "estimated" | "reported" | "unknown";
  stderr_classification?: string;
}

export interface TeamEvent {
  event_id: string;
  seq: number;
  ts: string;
  actor: string; // agent id or "orchestrator"
  type: string;
  round: number;
  reply_to: string | null;
  body: string;
  claims?: string[];
  unstructured?: boolean;
  run_id?: string;
  signal?: ChatSignal; // chat "turn" events
  malformed?: boolean; // chat "turn" events whose result envelope was absent/broken
  /** bus (v0.2): wire metadata for records sourced from the relay.
   *  On accepted "turn" events: {channel, seq, msg_id, author, in_reply_to,
   *  payload_hash}. On "bus_raw" records: the relayed envelope as observed.
   *  On "chat_ended": {channel, seq, msg_id, reason, terminal_seq}. */
  bus?: {
    channel: string;
    seq: number; // relay-assigned channel seq
    msg_id: string;
    author?: string;
    in_reply_to?: number | null;
    payload_hash?: string;
    control?: "chat_started" | "chat_ended"; // committed control records
    first_speaker?: string; // chat_started
    reason?: string; // chat_ended
    terminal_seq?: number; // chat_ended
  };
}

export interface ChatMeta {
  topic: string;
  max_turns: number;
  history_budget_chars: number;
  console_timeout_ms: number;
  substantive_turns: number;
  total_turns: number;
  end_reason?: ChatEndReason;
  /** bus (v0.2) chat: provisioned channel coordinates. Secrets live in
   *  bus.secret.json in the task dir, never here. */
  bus?: {
    bus_url: string;
    channel: string;
    epoch: string;
    participants: [string, string];
    first_speaker: string;
  };
}

export interface TaskMeta {
  id: string;
  kind: "workshop" | "ask" | "chat";
  state: TaskState;
  created_at: string;
  updated_at: string;
  artifact_sha256: string;
  artifact_label: string;
  team_sha256: string;
  agents: string[];
  rounds_planned: number;
  completed_rounds: number;
  runs_completed: number;
  estimated_cost_usd: number;
  started_at: string; // wall-clock anchor for budget enforcement
  ended_at?: string;
  decision?: DecisionRecord;
  verdict?: { verdict: "good" | "bad" | "mixed"; note?: string; ts: string };
  chat?: ChatMeta;
  error?: string;
}

export interface DecisionRecord {
  ts: string;
  action: "accept" | "reject" | "merge" | "defer";
  event_ids: string[];
  rationale?: string;
  actor: string;
}

/** Parsed result envelope payload returned by an agent in stdout. */
export interface ResultPayload {
  type?: string;
  summary?: string;
  body?: string;
  claims?: string[];
  replies?: { reply_to?: string; body?: string; claims?: string[] }[];
}
