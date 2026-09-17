// Team config: TOML parse + validation.
// Rejects: wrong schema_version, duplicate agent ids, unknown roles,
// unknown {placeholders}, more than one {prompt} arg, bad stdin modes.

import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import type { AgentConfig, RunStatus, StderrPattern, TeamConfig } from "./types.ts";

const RUN_STATUSES: RunStatus[] = [
  "succeeded", "failed", "timed_out", "auth_error", "rate_limited",
  "output_limit", "protocol_error", "empty",
];

const PLACEHOLDER_RE = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

export class ConfigError extends Error {
  errors: string[];
  constructor(errors: string[]) {
    super("invalid team config:\n" + errors.map((e) => "  - " + e).join("\n"));
    this.name = "ConfigError";
    this.errors = errors;
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function sha256(s: string | Uint8Array): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Validate a parsed TOML doc. Returns a normalized TeamConfig or throws ConfigError. */
export function validateConfig(raw: unknown, path: string): TeamConfig {
  const errors: string[] = [];
  if (!isObj(raw)) throw new ConfigError(["top-level config must be a TOML table"]);

  if (raw.schema_version !== 1) {
    errors.push(`schema_version must be 1 (got ${JSON.stringify(raw.schema_version)})`);
  }
  const team = asString(raw.team) ?? "default";

  const defaultsRaw = isObj(raw.defaults) ? raw.defaults : {};
  const defaults = {
    timeout_ms: asNumber(defaultsRaw.timeout_ms) ?? 100_000,
    max_output_bytes: asNumber(defaultsRaw.max_output_bytes) ?? 200_000,
    concurrency: Math.max(1, Math.floor(asNumber(defaultsRaw.concurrency) ?? 3)),
  };
  if (defaults.timeout_ms <= 0) errors.push("defaults.timeout_ms must be > 0");
  if (defaults.max_output_bytes <= 0) errors.push("defaults.max_output_bytes must be > 0");

  const budgetsRaw = isObj(raw.budgets) ? raw.budgets : {};
  const budgets = {
    max_runs: Math.floor(asNumber(budgetsRaw.max_runs) ?? 8),
    max_wall_time_ms: asNumber(budgetsRaw.max_wall_time_ms) ?? 600_000,
    max_estimated_cost_usd: asNumber(budgetsRaw.max_estimated_cost_usd) ?? 5.0,
  };
  if (budgets.max_runs <= 0) errors.push("budgets.max_runs must be > 0");

  // pairwise chat tuning (v0.1)
  const chatRaw = isObj(raw.chat) ? raw.chat : {};
  const chat = {
    max_turns: Math.floor(asNumber(chatRaw.max_turns) ?? 10),
    history_budget_chars: asNumber(chatRaw.history_budget_chars) ?? 12_000,
    console_timeout_ms: asNumber(chatRaw.console_timeout_ms) ?? 600_000,
  };
  if (chat.max_turns <= 0) errors.push("chat.max_turns must be > 0");
  if (chat.history_budget_chars <= 0) errors.push("chat.history_budget_chars must be > 0");
  if (chat.console_timeout_ms <= 0) errors.push("chat.console_timeout_ms must be > 0");

  // stderr classification table
  const stderr_patterns: StderrPattern[] = [];
  const sp = raw.stderr_patterns;
  if (sp !== undefined) {
    if (!Array.isArray(sp)) errors.push("stderr_patterns must be an array of tables");
    else {
      for (const [i, entry] of sp.entries()) {
        if (!isObj(entry) || !asString(entry.pattern)) {
          errors.push(`stderr_patterns[${i}]: needs a "pattern" string`);
          continue;
        }
        const status = asString(entry.status) ?? "failed";
        if (!RUN_STATUSES.includes(status as RunStatus)) {
          errors.push(`stderr_patterns[${i}]: unknown status ${JSON.stringify(status)}`);
          continue;
        }
        try {
          stderr_patterns.push({
            pattern: entry.pattern as string,
            status: status as RunStatus,
            regex: new RegExp(entry.pattern as string, "i"),
          });
        } catch {
          errors.push(`stderr_patterns[${i}]: invalid regex ${JSON.stringify(entry.pattern)}`);
        }
      }
    }
  }

  // redaction patterns
  const redact_patterns: RegExp[] = [];
  const redactRaw = isObj(raw.redact) ? raw.redact.patterns : undefined;
  if (redactRaw !== undefined) {
    if (!Array.isArray(redactRaw)) errors.push("redact.patterns must be an array of regex strings");
    else {
      for (const [i, p] of redactRaw.entries()) {
        if (typeof p !== "string") {
          errors.push(`redact.patterns[${i}] must be a string`);
          continue;
        }
        try {
          redact_patterns.push(new RegExp(p, "g"));
        } catch {
          errors.push(`redact.patterns[${i}]: invalid regex ${JSON.stringify(p)}`);
        }
      }
    }
  }

  // roles
  const roles: { name: string; instructions: string }[] = [];
  const roleNames = new Set<string>();
  const rolesRaw = raw.roles;
  if (rolesRaw !== undefined) {
    if (!Array.isArray(rolesRaw)) errors.push("roles must be an array of tables");
    else {
      for (const [i, r] of rolesRaw.entries()) {
        if (!isObj(r) || !asString(r.name)) {
          errors.push(`roles[${i}]: needs a "name"`);
          continue;
        }
        const name = r.name as string;
        if (roleNames.has(name)) errors.push(`duplicate role name ${JSON.stringify(name)}`);
        roleNames.add(name);
        roles.push({ name, instructions: asString(r.instructions) ?? "" });
      }
    }
  }

  // agents
  const agents: AgentConfig[] = [];
  const agentIds = new Set<string>();
  const agentsRaw = raw.agents;
  if (!Array.isArray(agentsRaw) || agentsRaw.length === 0) {
    errors.push("config must define at least one [[agents]] entry");
  } else {
    for (const [i, a] of agentsRaw.entries()) {
      const where = `agents[${i}]`;
      if (!isObj(a)) {
        errors.push(`${where}: must be a table`);
        continue;
      }
      const id = asString(a.id);
      if (!id) {
        errors.push(`${where}: missing "id"`);
        continue;
      }
      if (agentIds.has(id)) errors.push(`duplicate agent id ${JSON.stringify(id)}`);
      agentIds.add(id);

      const kind = asString(a.kind) ?? "cli";
      if (kind !== "cli" && kind !== "console" && kind !== "bus") {
        errors.push(`agent ${JSON.stringify(id)}: kind must be "cli", "console", or "bus"`);
      }

      const role = asString(a.role) ?? "";
      if (role && !roleNames.has(role)) {
        errors.push(`agent ${JSON.stringify(id)}: unknown role ${JSON.stringify(role)}`);
      }

      const authEnv = asString(a.auth_env);
      if (authEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(authEnv)) {
        errors.push(`agent ${JSON.stringify(id)}: auth_env must be an env var name`);
      }

      // display_name is a presentation label, not an identity: collisions are
      // allowed (two sides may both call themselves "moss") and it never
      // enters auth or turn validation. Empty/whitespace is treated as absent.
      const displayNameRaw = asString(a.display_name);
      const displayName =
        displayNameRaw !== undefined && displayNameRaw.trim() !== ""
          ? displayNameRaw.trim()
          : undefined;

      const cmd = a.command;
      if (!isObj(cmd)) {
        if (kind === "console") {
          agents.push({
            id, kind: "console", adapter: asString(a.adapter) ?? "console",
            model: asString(a.model), role, cost_tier: asString(a.cost_tier),
            cost_per_run_usd: asNumber(a.cost_per_run_usd),
            auth_env: authEnv, env: {}, display_name: displayName,
          });
        } else if (kind === "bus") {
          const busUrl = asString(a.bus_url);
          if (!busUrl || !/^https?:\/\/.+/.test(busUrl)) {
            errors.push(`agent ${JSON.stringify(id)}: kind "bus" requires bus_url (http(s)://...)`);
          }
          const tokenEnv = asString(a.token_env);
          if (!tokenEnv || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) {
            errors.push(`agent ${JSON.stringify(id)}: kind "bus" requires token_env (an env var name)`);
          }
          const channel = asString(a.channel);
          if (a.channel !== undefined && (!channel || !/^[A-Za-z0-9_-]{1,128}$/.test(channel))) {
            errors.push(`agent ${JSON.stringify(id)}: channel must match [A-Za-z0-9_-]{1,128}`);
          }
          agents.push({
            id, kind: "bus", adapter: asString(a.adapter) ?? "bus",
            model: asString(a.model), role, cost_tier: asString(a.cost_tier),
            cost_per_run_usd: asNumber(a.cost_per_run_usd),
            auth_env: authEnv, env: {},
            bus_url: busUrl, channel, token_env: tokenEnv, display_name: displayName,
          });
        } else {
          errors.push(`agent ${JSON.stringify(id)}: missing [agents.command]`);
        }
        continue;
      }
      if (kind === "console" || kind === "bus") {
        errors.push(`agent ${JSON.stringify(id)}: kind "${kind}" must not have [agents.command]`);
      }
      const executable = asString(cmd.executable);
      if (!executable) errors.push(`agent ${JSON.stringify(id)}: command.executable required`);

      const argsRaw = cmd.args;
      const args: string[] = [];
      if (argsRaw !== undefined && !Array.isArray(argsRaw)) {
        errors.push(`agent ${JSON.stringify(id)}: command.args must be an array of strings`);
      } else {
        for (const arg of (argsRaw as unknown[]) ?? []) {
          if (typeof arg !== "string") {
            errors.push(`agent ${JSON.stringify(id)}: command.args entries must be strings`);
            continue;
          }
          // reject unknown placeholders
          for (const m of arg.matchAll(PLACEHOLDER_RE)) {
            if (m[1] !== "prompt") {
              errors.push(
                `agent ${JSON.stringify(id)}: unknown placeholder {${m[1]}} in args (only {prompt} is supported)`
              );
            }
          }
          args.push(arg);
        }
      }
      const promptArgs = args.filter((a2) => a2.includes("{prompt}"));
      if (promptArgs.length > 1) {
        errors.push(`agent ${JSON.stringify(id)}: {prompt} may appear in at most one arg`);
      }
      for (const arg of args) {
        if ((arg.match(/\{prompt\}/g) ?? []).length > 1) {
          errors.push(`agent ${JSON.stringify(id)}: {prompt} may appear only once per arg`);
        }
      }

      const stdin = asString(cmd.stdin) ?? "null";
      if (stdin !== "prompt" && stdin !== "null") {
        errors.push(`agent ${JSON.stringify(id)}: command.stdin must be "prompt" or "null"`);
      }
      if (promptArgs.length === 1 && stdin === "prompt") {
        errors.push(
          `agent ${JSON.stringify(id)}: {prompt} in args AND stdin="prompt" is ambiguous; pick one`
        );
      }

      const envRaw = a.env;
      const env: Record<string, string> = {};
      if (envRaw !== undefined) {
        if (!isObj(envRaw)) errors.push(`agent ${JSON.stringify(id)}: env must be a table`);
        else {
          for (const [k, v] of Object.entries(envRaw)) {
            if (typeof v !== "string") {
              errors.push(`agent ${JSON.stringify(id)}: env.${k} must be a string`);
              continue;
            }
            env[k] = v;
          }
        }
      }

      agents.push({
        id,
        kind: kind as "cli" | "console",
        adapter: asString(a.adapter) ?? "generic",
        model: asString(a.model),
        role,
        cost_tier: asString(a.cost_tier),
        cost_per_run_usd: asNumber(a.cost_per_run_usd),
        auth_env: authEnv,
        command: { executable: executable ?? "", args, stdin: stdin as "prompt" | "null" },
        env,
        display_name: displayName,
      });
    }
  }

  if (errors.length) throw new ConfigError(errors);

  return {
    schema_version: 1,
    team,
    defaults,
    budgets,
    chat,
    stderr_patterns,
    redact_patterns,
    roles,
    agents,
    path,
    root: dirname(path),
    hash: "", // filled by loadConfig
  };
}

export async function loadConfig(path: string): Promise<TeamConfig> {
  const abs = resolve(path);
  const file = Bun.file(abs);
  if (!(await file.exists())) {
    throw new ConfigError([`config file not found: ${abs}`]);
  }
  const text = await file.text();
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(text);
  } catch (e) {
    throw new ConfigError([`TOML parse error in ${abs}: ${(e as Error).message}`]);
  }
  const cfg = validateConfig(parsed, abs);
  cfg.hash = sha256(text);
  return cfg;
}
