import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Blackboard } from "../src/blackboard.ts";
import { loadConfig } from "../src/config.ts";
import { runRound } from "../src/runner.ts";
import type { RunResult } from "../src/types.ts";
import { ARTIFACT, makeMeta, makeTeamDir } from "./helpers.ts";

const BIN = join(import.meta.dir, "..", "bin", "team.ts");
const T = 30_000;

describe("workshop --resume", () => {
  test("continues from the last completed round without re-running completed invocations", async () => {
    const dir = makeTeamDir(["a1", "a2"]);
    const config = await loadConfig(join(dir, "team.toml"));
    const bb = new Blackboard(join(dir, ".team"));
    const meta = makeMeta("t-resume-1", "workshop", ["a1", "a2"], 2);
    bb.initTask(meta, ARTIFACT);

    // Round 1 completes normally.
    await runRound(bb, config, meta, 1, config.agents);
    expect(meta.completed_rounds).toBe(1);

    // Simulate a kill mid-round-2: a1's run finished (result.json on disk,
    // runs_completed already counted), a2 never spawned.
    const finished: RunResult = {
      run_id: "r2-a1",
      task_id: meta.id,
      agent_id: "a1",
      round: 2,
      status: "succeeded",
      exit_code: 0,
      signal: null,
      started_at: "SENTINEL-NO-RESPAWN",
      ended_at: "SENTINEL-NO-RESPAWN",
      latency_ms: 1,
      timed_out: false,
      output_limited: false,
      cost_usd: 0,
      cost_source: "estimated",
    };
    bb.initRunDir(meta.id, "r2-a1");
    bb.writeRunFile(meta.id, "r2-a1", "result.json", finished);
    meta.runs_completed = 3;
    meta.state = "running";
    bb.writeMeta(meta);

    // Resume through the real CLI.
    const proc = Bun.spawn(
      ["bun", BIN, "--config", join(dir, "team.toml"), "--json", "workshop", "--resume", meta.id],
      { cwd: dir, stdout: "pipe", stderr: "pipe" }
    );
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;

    expect(stderr).not.toContain("error:");
    expect(code).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.ok).toBe(true);
    expect(out.task_id).toBe(meta.id);
    expect(out.state).toBe("awaiting_decision");

    // a1's completed round-2 run was not respawned: sentinel is intact.
    const a1Result = JSON.parse(
      readFileSync(join(bb.runDir(meta.id, "r2-a1"), "result.json"), "utf8")
    ) as RunResult;
    expect(a1Result.started_at).toBe("SENTINEL-NO-RESPAWN");

    // a2's missing round-2 run was spawned and completed.
    const a2Path = join(bb.runDir(meta.id, "r2-a2"), "result.json");
    expect(existsSync(a2Path)).toBe(true);
    const a2Result = JSON.parse(readFileSync(a2Path, "utf8")) as RunResult;
    expect(a2Result.status).toBe("succeeded");
    expect(a2Result.started_at).not.toBe("SENTINEL-NO-RESPAWN");

    // Task meta reflects completion of all planned rounds.
    const diskMeta = bb.readMeta(meta.id);
    expect(diskMeta.completed_rounds).toBe(2);
    expect(diskMeta.state).toBe("awaiting_decision");

    // a2 produced a round-2 result event; a1 got no duplicate.
    const events = bb.readEvents(meta.id);
    expect(events.some((e) => e.actor === "a2" && e.round === 2 && e.run_id === "r2-a2")).toBe(true);
    expect(events.filter((e) => e.run_id === "r2-a1")).toHaveLength(0);
  }, T);

  test("refuses to resume a completed task", async () => {
    const dir = makeTeamDir(["a1"]);
    const config = await loadConfig(join(dir, "team.toml"));
    const bb = new Blackboard(join(dir, ".team"));
    const meta = makeMeta("t-resume-2", "workshop", ["a1"], 1);
    bb.initTask(meta, ARTIFACT);
    await runRound(bb, config, meta, 1, config.agents);
    meta.state = "awaiting_decision";
    bb.writeMeta(meta);

    const proc = Bun.spawn(
      ["bun", BIN, "--config", join(dir, "team.toml"), "--json", "workshop", "--resume", meta.id],
      { cwd: dir, stdout: "pipe", stderr: "pipe" }
    );
    const out = JSON.parse(await new Response(proc.stdout).text());
    expect(await proc.exited).toBe(0);
    expect(out.ok).toBe(true);
    expect(out.message).toContain("nothing to resume");
  }, T);
});
