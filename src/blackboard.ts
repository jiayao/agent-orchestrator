// Blackboard: per-task directory under .team/tasks/<task-id>/.
// events.jsonl is the append-only source of truth; the orchestrator is the
// sole writer. view.md is regenerated atomically (tmp + rename).

import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { appendFile, open } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import type { DecisionRecord, TaskMeta, TeamEvent } from "./types.ts";
import { sha256 } from "./config.ts";

/** Thrown when a task's runner lock is held by a live process. */
export class TaskLockError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "TaskLockError";
  }
}

export interface LockHandle {
  path: string;
  release(): void;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the pid exists but isn't ours to signal — still alive
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class Blackboard {
  private appendQueues = new Map<string, Promise<unknown>>();

  constructor(public teamDir: string) {}

  get tasksDir(): string {
    return join(this.teamDir, "tasks");
  }

  taskDir(taskId: string): string {
    return join(this.tasksDir, taskId);
  }

  /** Create the task directory and initial files. */
  initTask(meta: TaskMeta, artifactText: string): void {
    const dir = this.taskDir(meta.id);
    mkdirSync(join(dir, "runs"), { recursive: true });
    writeFileSync(join(dir, "artifact.md"), artifactText);
    writeFileSync(join(dir, "events.jsonl"), "");
    this.writeMeta(meta);
    this.renderView(meta.id);
  }

  metaPath(taskId: string): string {
    return join(this.taskDir(taskId), "task.json");
  }

  eventsPath(taskId: string): string {
    return join(this.taskDir(taskId), "events.jsonl");
  }

  viewPath(taskId: string): string {
    return join(this.taskDir(taskId), "view.md");
  }

  decisionPath(taskId: string): string {
    return join(this.taskDir(taskId), "decision.md");
  }

  runDir(taskId: string, runId: string): string {
    return join(this.taskDir(taskId), "runs", runId);
  }

  taskExists(taskId: string): boolean {
    try {
      readFileSync(this.metaPath(taskId));
      return true;
    } catch {
      return false;
    }
  }

  readMeta(taskId: string): TaskMeta {
    return JSON.parse(readFileSync(this.metaPath(taskId), "utf8")) as TaskMeta;
  }

  writeMeta(meta: TaskMeta): void {
    meta.updated_at = new Date().toISOString();
    const p = this.metaPath(meta.id);
    writeFileSync(p + ".tmp", JSON.stringify(meta, null, 2) + "\n");
    renameSync(p + ".tmp", p);
  }

  readArtifact(taskId: string): string {
    return readFileSync(join(this.taskDir(taskId), "artifact.md"), "utf8");
  }

  /** Append one event. Assigns event_id and seq. Sole writer.
   *  Appends are serialized per task so concurrent streamed envelopes
   *  can't race on seq assignment. */
  appendEvent(
    taskId: string,
    ev: Omit<TeamEvent, "event_id" | "seq" | "ts"> & { ts?: string }
  ): Promise<TeamEvent> {
    const prev = this.appendQueues.get(taskId) ?? Promise.resolve();
    const next = prev.then(() => this.appendEventInner(taskId, ev));
    this.appendQueues.set(taskId, next.catch(() => {}));
    return next;
  }

  private async appendEventInner(
    taskId: string,
    ev: Omit<TeamEvent, "event_id" | "seq" | "ts"> & { ts?: string }
  ): Promise<TeamEvent> {
    const seq = this.eventCount(taskId);
    const full: TeamEvent = {
      event_id: `evt_${seq.toString().padStart(4, "0")}`,
      seq,
      ts: ev.ts ?? new Date().toISOString(),
      actor: ev.actor,
      type: ev.type,
      round: ev.round,
      reply_to: ev.reply_to ?? null,
      body: ev.body,
      ...(ev.claims ? { claims: ev.claims } : {}),
      ...(ev.unstructured ? { unstructured: true } : {}),
      ...(ev.run_id ? { run_id: ev.run_id } : {}),
      ...(ev.signal ? { signal: ev.signal } : {}),
      ...(ev.malformed ? { malformed: true } : {}),
      ...(ev.verdict ? { verdict: ev.verdict } : {}),
      ...(ev.ignore_why ? { ignore_why: ev.ignore_why } : {}),
      ...(ev.bus ? { bus: ev.bus } : {}),
    };
    const path = this.eventsPath(taskId);
    // "a+" (read/append): the torn-tail check below reads the last byte, so
    // the fd must be readable — "a" alone is write-only and read() throws EBADF.
    const fh = await open(path, "a+");
    try {
      // a crash mid-append leaves a torn tail with no trailing newline —
      // terminate it so this event lands on its own line and stays parseable
      const st = await fh.stat();
      if (st.size > 0) {
        const tail = Buffer.alloc(1);
        await fh.read(tail, 0, 1, st.size - 1);
        if (tail[0] !== 0x0a) await fh.write("\n");
      }
      await fh.write(JSON.stringify(full) + "\n");
      await fh.sync(); // durable before the append is observable to readers
    } finally {
      await fh.close();
    }
    return full;
  }

  /**
   * Parse events.jsonl line by line, salvaging every well-formed record.
   * Corrupt lines (a torn tail from a crash mid-append) are skipped, never
   * silently zero the log: they're reported via `corrupt` for callers that
   * want to warn. `readEvents` keeps the array-only shape for convenience.
   */
  readEventsTail(taskId: string): { events: TeamEvent[]; corrupt: string[] } {
    const events: TeamEvent[] = [];
    const corrupt: string[] = [];
    let text: string;
    try {
      text = readFileSync(this.eventsPath(taskId), "utf8");
    } catch {
      return { events, corrupt };
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as TeamEvent);
      } catch {
        corrupt.push(line);
      }
    }
    return { events, corrupt };
  }

  readEvents(taskId: string): TeamEvent[] {
    return this.readEventsTail(taskId).events;
  }

  eventCount(taskId: string): number {
    try {
      const text = readFileSync(this.eventsPath(taskId), "utf8");
      return text.split("\n").filter((l) => l.trim().length > 0).length;
    } catch {
      return 0;
    }
  }

  /**
   * Per-task sole-writer lock: tasks/<id>/<name> (default runner.lock)
   * created O_EXCL with pid+hostname+command. A live same-host holder refuses
   * the acquisition; a stale lock (dead pid) is reclaimed automatically;
   * `steal` is the operator escape hatch. Release deletes only our own lock.
   */
  acquireLock(
    taskId: string,
    opts: { name?: string; steal?: boolean; cmd?: string } = {}
  ): LockHandle {
    const path = join(this.taskDir(taskId), opts.name ?? "runner.lock");
    const info = {
      pid: process.pid,
      hostname: hostname(),
      cmd: opts.cmd ?? process.argv.slice(1).join(" "),
      acquired_at: new Date().toISOString(),
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(path, "wx"); // O_EXCL create — fails when held
        try {
          writeFileSync(fd, JSON.stringify(info, null, 2) + "\n");
        } finally {
          closeSync(fd);
        }
        let released = false;
        return {
          path,
          release: () => {
            if (released) return;
            released = true;
            try {
              const cur = JSON.parse(readFileSync(path, "utf8"));
              if (cur?.pid === process.pid) unlinkSync(path);
            } catch {
              // lock already gone or replaced — nothing to release
            }
          },
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        let holder: { pid?: number; hostname?: string; cmd?: string } | null = null;
        try {
          holder = JSON.parse(readFileSync(path, "utf8"));
        } catch {
          // unreadable lock — treat as stale
        }
        const sameHost = !holder?.hostname || holder.hostname === hostname();
        const alive =
          sameHost && typeof holder?.pid === "number" && pidAlive(holder.pid);
        if (opts.steal || !alive) {
          try {
            unlinkSync(path);
          } catch {
            // already gone — retry the create
          }
          continue;
        }
        const desc = `pid=${holder!.pid}@${holder!.hostname}${
          holder!.cmd ? ` cmd=${JSON.stringify(holder!.cmd)}` : ""
        }`;
        throw new TaskLockError(
          `task ${taskId} is locked by a live process (${desc}); ` +
            `use --steal-lock to take over`
        );
      }
    }
    throw new TaskLockError(`task ${taskId}: could not acquire ${path}`);
  }

  initRunDir(taskId: string, runId: string): string {
    const dir = this.runDir(taskId, runId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  writeRunFile(taskId: string, runId: string, name: string, data: string | object): void {
    const p = join(this.runDir(taskId, runId), name);
    writeFileSync(p, typeof data === "string" ? data : JSON.stringify(data, null, 2) + "\n");
  }

  writeDecision(taskId: string, decision: DecisionRecord, bodies: Map<string, string>): void {
    const lines: string[] = [
      `# Decision — ${taskId}`,
      "",
      `- action: ${decision.action}`,
      `- at: ${decision.ts}`,
      `- actor: ${decision.actor}`,
      `- events: ${decision.event_ids.join(", ") || "(none)"}`,
      decision.rationale ? `- rationale: ${decision.rationale}` : null,
      "",
      "## Selected events",
      "",
    ].filter((l): l is string => l !== null);
    for (const id of decision.event_ids) {
      lines.push(`### ${id}`, "", bodies.get(id) ?? "(missing)", "");
    }
    const p = this.decisionPath(taskId);
    writeFileSync(p + ".tmp", lines.join("\n"));
    renameSync(p + ".tmp", p);
  }

  /** Regenerate view.md atomically. */
  renderView(taskId: string): void {
    const meta = this.readMeta(taskId);
    const events = this.readEvents(taskId);
    const lines: string[] = [
      `# Task ${meta.id} (${meta.kind})`,
      "",
      `- state: **${meta.state}**`,
      `- created: ${meta.created_at}`,
      `- artifact: sha256:${meta.artifact_sha256.slice(0, 12)} (${meta.artifact_label})`,
      `- team: sha256:${meta.team_sha256.slice(0, 12)}`,
      `- agents: ${meta.agents.join(", ")}`,
      `- rounds: ${meta.completed_rounds}/${meta.rounds_planned} completed`,
      `- runs: ${meta.runs_completed} | est. spend: $${meta.estimated_cost_usd.toFixed(4)}`,
      meta.chat
        ? `- chat: turns ${meta.chat.total_turns} (${meta.chat.substantive_turns} substantive)${meta.chat.end_reason ? ` | end_reason=${meta.chat.end_reason}` : ""}`
        : null,
      meta.error ? `- error: ${meta.error}` : null,
      "",
    ].filter((l): l is string => l !== null);

    const rounds = new Map<number, TeamEvent[]>();
    for (const ev of events) {
      const r = ev.round;
      if (!rounds.has(r)) rounds.set(r, []);
      rounds.get(r)!.push(ev);
    }
    for (const [round, evs] of [...rounds.entries()].sort((a, b) => a[0] - b[0])) {
      lines.push(`## Round ${round}`, "");
      for (const ev of evs) {
        if (ev.type === "bus_record") {
          if (ev.verdict === "turn") {
            // accepted turns render like turns — this is the conversation
            const sig = ev.signal ? ` signal=${ev.signal}` : "";
            lines.push(
              `### ${ev.event_id} — ${ev.actor} · turn ch_seq=${ev.bus?.seq ?? "?"}${sig}`,
              ""
            );
            lines.push(ev.body, "");
          } else {
            // one line per wire message — full detail is in events.jsonl
            const what =
              ev.verdict === "control_started" || ev.verdict === "control_ended"
                ? `${ev.verdict}${ev.bus?.reason ? ` reason=${ev.bus.reason}` : ""}`
                : `ignored${ev.ignore_why ? ` (${ev.ignore_why})` : ""}`;
            lines.push(
              `- bus ch_seq=${ev.bus?.seq ?? "?"} author=${ev.bus?.author ?? ev.actor} msg_id=${ev.bus?.msg_id ?? "?"} ${what}${ev.unstructured ? " [undecryptable]" : ""}`,
              ""
            );
          }
          continue;
        }
        if (ev.type === "bus_raw") {
          // legacy raw records, one line each — full wire detail is in events.jsonl
          lines.push(
            `- raw ch_seq=${ev.bus?.seq ?? "?"} author=${ev.bus?.author ?? ev.actor} msg_id=${ev.bus?.msg_id ?? "?"}${ev.unstructured ? " [undecryptable]" : ""}`,
            ""
          );
          continue;
        }
        const flag = ev.unstructured ? " [unstructured]" : "";
        const sig = ev.signal ? ` signal=${ev.signal}` : "";
        const mal = ev.malformed ? " [malformed]" : "";
        const reply = ev.reply_to ? ` (reply to ${ev.reply_to})` : "";
        const chSeq = ev.bus ? ` ch_seq=${ev.bus.seq}` : "";
        lines.push(`### ${ev.event_id} — ${ev.actor} · ${ev.type}${chSeq}${reply}${sig}${flag}${mal}`, "");
        lines.push(ev.body, "");
        if (ev.claims?.length) {
          for (const c of ev.claims) lines.push(`- ${c}`);
          lines.push("");
        }
      }
    }

    if (meta.decision) {
      lines.push("## Decision", "");
      lines.push(`- action: ${meta.decision.action}`);
      lines.push(`- events: ${meta.decision.event_ids.join(", ")}`);
      if (meta.decision.rationale) lines.push(`- rationale: ${meta.decision.rationale}`);
      lines.push("");
    }
    if (meta.verdict) {
      lines.push("## Verdict", "");
      lines.push(`- ${meta.verdict.verdict}${meta.verdict.note ? ": " + meta.verdict.note : ""}`);
      lines.push("");
    }

    const p = this.viewPath(taskId);
    writeFileSync(p + ".tmp", lines.join("\n"));
    renameSync(p + ".tmp", p);
  }

  // ---- taste log ----

  tasteLogPath(): string {
    return join(this.teamDir, "taste-log.jsonl");
  }

  async appendTaste(entry: Record<string, unknown>): Promise<void> {
    mkdirSync(this.teamDir, { recursive: true });
    await appendFile(this.tasteLogPath(), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  }

  readTasteLog(): Record<string, unknown>[] {
    try {
      return readFileSync(this.tasteLogPath(), "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }

  listTasks(): TaskMeta[] {
    const out: TaskMeta[] = [];
    try {
      for (const name of readdirSync(this.tasksDir)) {
        try {
          out.push(this.readMeta(name));
        } catch {
          // skip non-task dirs
        }
      }
    } catch {
      // no tasks dir yet
    }
    return out.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
}

export function newTaskId(): string {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const rand = sha256(`${now.getTime()}-${Math.random()}`).slice(0, 6);
  return `t-${stamp}-${rand}`;
}
