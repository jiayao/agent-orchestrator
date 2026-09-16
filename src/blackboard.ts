// Blackboard: per-task directory under .team/tasks/<task-id>/.
// events.jsonl is the append-only source of truth; the orchestrator is the
// sole writer. view.md is regenerated atomically (tmp + rename).

import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { DecisionRecord, TaskMeta, TeamEvent } from "./types.ts";
import { sha256 } from "./config.ts";

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
      ...(ev.bus ? { bus: ev.bus } : {}),
    };
    await appendFile(this.eventsPath(taskId), JSON.stringify(full) + "\n");
    return full;
  }

  readEvents(taskId: string): TeamEvent[] {
    try {
      const text = readFileSync(this.eventsPath(taskId), "utf8");
      return text
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as TeamEvent);
    } catch {
      return [];
    }
  }

  eventCount(taskId: string): number {
    try {
      const text = readFileSync(this.eventsPath(taskId), "utf8");
      return text.split("\n").filter((l) => l.trim().length > 0).length;
    } catch {
      return 0;
    }
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
        if (ev.type === "bus_raw") {
          // everything the relay served, one line each — full wire detail is in events.jsonl
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
