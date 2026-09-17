// Spawn engine: one parameterized mechanism, not N adapters.
// Structured argv with a single {prompt} placeholder, explicit stdin mode,
// no shell interpolation. Process-group kill on timeout (no grace period).
// Never auto-retries. A dead agent never kills the workshop.

import type { AgentConfig, RunResult, RunStatus, SpawnSpec, TeamConfig } from "./types.ts";
import { EnvelopeStreamParser, type ExtractedEnvelope } from "./envelope.ts";

const ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "USER", "TMPDIR"];

let hasSetsid: boolean | null = null;
function setsidAvailable(): boolean {
  if (hasSetsid === null) hasSetsid = !!Bun.which("setsid");
  return hasSetsid;
}

export function buildSpawnSpec(
  agent: AgentConfig,
  config: TeamConfig,
  prompt: string
): SpawnSpec {
  if (!agent.command) {
    throw new Error(`agent ${JSON.stringify(agent.id)} has no command (kind=${agent.kind})`);
  }
  const cmd = agent.command;
  const args = cmd.args.map((a) => a.split("{prompt}").join(prompt));
  const env: Record<string, string> = {};
  for (const k of ENV_ALLOWLIST) {
    if (process.env[k] !== undefined) env[k] = process.env[k] as string;
  }
  // declared credential passes through from the orchestrator's env
  if (agent.auth_env && process.env[agent.auth_env] !== undefined) {
    env[agent.auth_env] = process.env[agent.auth_env] as string;
  }
  for (const [k, v] of Object.entries(agent.env)) env[k] = v;
  return {
    executable: cmd.executable,
    args,
    stdin: cmd.stdin,
    cwd: config.root,
    env,
    timeoutMs: config.defaults.timeout_ms,
    maxOutputBytes: config.defaults.max_output_bytes,
  };
}

export interface SpawnCallbacks {
  /** Called for every envelope (event or result) as it completes on stdout. */
  onEnvelope?: (env: ExtractedEnvelope) => void;
  /** Called with each redacted stdout chunk (after envelope parsing). */
  onStdoutChunk?: (chunk: string) => void;
  onStderrChunk?: (chunk: string) => void;
}

export interface SpawnOutcome {
  status: RunStatus;
  exit_code: number | null;
  signal: string | null;
  timed_out: boolean;
  output_limited: boolean;
  stdout: string;
  stderr: string;
  sawResultEnvelope: boolean;
  resultPayload: unknown | null;
  resultParseError?: string;
  latency_ms: number;
}

function classifyStderr(stderr: string, config: TeamConfig): RunStatus | null {
  for (const p of config.stderr_patterns) {
    if (p.regex.test(stderr)) return p.status;
  }
  return null;
}

export function applyRedaction(text: string, config: TeamConfig): string {
  let out = text;
  for (const re of config.redact_patterns) {
    re.lastIndex = 0;
    out = out.replace(re, "[REDACTED]");
  }
  return out;
}

/**
 * Run one agent invocation. Tails stdout through the envelope parser so
 * TEAM_EVENT_V1 envelopes surface as they arrive, not at process exit.
 */
export async function spawnAgent(
  spec: SpawnSpec,
  prompt: string,
  config: TeamConfig,
  cb: SpawnCallbacks = {}
): Promise<SpawnOutcome> {
  const started = Date.now();
  const useSetsid = setsidAvailable();
  const cmd = useSetsid ? ["setsid", spec.executable, ...spec.args] : [spec.executable, ...spec.args];

  let proc;
  try {
    proc = Bun.spawn(cmd, {
      cwd: spec.cwd,
      env: spec.env,
      stdin: spec.stdin === "prompt" ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (e) {
    return {
      status: "failed",
      exit_code: null,
      signal: null,
      timed_out: false,
      output_limited: false,
      stdout: "",
      stderr: `spawn failed: ${(e as Error).message}`,
      sawResultEnvelope: false,
      resultPayload: null,
      latency_ms: Date.now() - started,
    };
  }

  let timedOut = false;
  let outputLimited = false;
  let stdoutLen = 0;
  let killed = false;

  const killGroup = () => {
    if (killed) return;
    killed = true;
    try {
      if (useSetsid) process.kill(-proc.pid, "SIGKILL");
      else proc.kill("SIGKILL");
    } catch {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already dead
      }
    }
  };

  const timer = setTimeout(() => {
    timedOut = true;
    killGroup();
  }, spec.timeoutMs);

  if (spec.stdin === "prompt") {
    try {
      proc.stdin?.write(prompt);
      proc.stdin?.end();
    } catch {
      // child may have exited already
    }
  }

  const parser = new EnvelopeStreamParser();
  let sawResult = false;
  let resultPayload: unknown | null = null;
  let resultParseError: string | undefined;
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const readStdout = (async () => {
    const reader = proc.stdout.getReader();
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        stdoutLen += value.byteLength;
        if (stdoutLen > spec.maxOutputBytes) {
          outputLimited = true;
          killGroup();
          break;
        }
        const text = applyRedaction(dec.decode(value, { stream: true }), config);
        stdoutChunks.push(text);
        cb.onStdoutChunk?.(text);
        for (const env of parser.feed(text)) {
          if (env.kind === "TEAM_RESULT_V1") {
            sawResult = true;
            if (env.json !== null && typeof env.json === "object") {
              resultPayload = env.json;
            } else {
              resultParseError = env.parse_error ?? "result envelope is not a JSON object";
            }
          }
          cb.onEnvelope?.(env);
        }
      }
    } catch {
      // stream died with the process
    } finally {
      // remainder is a suffix of text already pushed to stdoutChunks
      parser.flushRemainder();
      reader.releaseLock?.();
    }
  })();

  const readStderr = (async () => {
    const reader = proc.stderr.getReader();
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = applyRedaction(dec.decode(value, { stream: true }), config);
        stderrChunks.push(text);
        cb.onStderrChunk?.(text);
      }
    } catch {
      // ignore
    } finally {
      reader.releaseLock?.();
    }
  })();

  const exitCode = await proc.exited;
  clearTimeout(timer);
  // bound the post-exit drain: without setsid a detached grandchild can hold
  // the pipes open — take whatever arrived within a short grace window
  await Promise.race([
    Promise.all([readStdout, readStderr]),
    new Promise((r) => setTimeout(r, 2_000)),
  ]);

  const stdout = stdoutChunks.join("");
  const stderr = stderrChunks.join("");
  const latency_ms = Date.now() - started;

  let status: RunStatus;
  let signal: string | null = null;
  if (timedOut) {
    status = "timed_out";
    signal = "SIGKILL";
  } else if (outputLimited) {
    status = "output_limit";
    signal = "SIGKILL";
  } else if (exitCode !== 0) {
    status = classifyStderr(stderr, config) ?? "failed";
  } else if (!stdout.trim()) {
    status = "empty";
  } else if (!sawResult) {
    status = "protocol_error"; // no result envelope — fallback chain still applies
  } else if (resultParseError) {
    status = "protocol_error";
  } else {
    status = "succeeded";
  }

  return {
    status,
    exit_code: exitCode,
    signal,
    timed_out: timedOut,
    output_limited: outputLimited,
    stdout,
    stderr,
    sawResultEnvelope: sawResult,
    resultPayload,
    resultParseError,
    latency_ms,
  };
}

export function estimatedCost(agent: AgentConfig): { cost: number | null; source: "estimated" | "unknown" } {
  if (typeof agent.cost_per_run_usd === "number") {
    return { cost: agent.cost_per_run_usd, source: "estimated" };
  }
  return { cost: null, source: "unknown" };
}
