import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { Blackboard } from "../src/blackboard.ts";
import { loadConfig } from "../src/config.ts";
import { runTaskRounds } from "../src/runner.ts";
import { ARTIFACT, makeMeta, makeTeamDir } from "./helpers.ts";

const T = 20_000;

describe("budgets", () => {
  test("max_runs=1 refuses the round-2 fan-out before spawning", async () => {
    const dir = makeTeamDir(["a1"], { budgets: "max_runs = 1\nmax_wall_time_ms = 600000\nmax_estimated_cost_usd = 5.0" });
    const config = await loadConfig(join(dir, "team.toml"));
    const bb = new Blackboard(join(dir, ".team"));
    const meta = makeMeta("t-budget-runs", "workshop", ["a1"], 2);
    bb.initTask(meta, ARTIFACT);

    const summary = await runTaskRounds(bb, config, meta, config.agents);

    expect(summary.budgetExceeded).toContain("max_runs");
    expect(meta.completed_rounds).toBe(1);
    expect(meta.state).toBe("awaiting_decision");
    expect(meta.error).toContain("budget_exceeded");

    // round 1 spawned; round 2 never fanned out
    const runDirs = readdirSync(join(bb.taskDir(meta.id), "runs")).sort();
    expect(runDirs).toEqual(["r1-a1"]);
    expect(bb.readEvents(meta.id).some((e) => e.type === "budget_exceeded" && e.round === 2)).toBe(true);
  }, T);

  test("tiny max_estimated_cost_usd refuses the round-2 fan-out before spawning", async () => {
    const dir = makeTeamDir(["a1"], {
      budgets: "max_runs = 8\nmax_wall_time_ms = 600000\nmax_estimated_cost_usd = 0.05",
      cost: 0.05,
    });
    const config = await loadConfig(join(dir, "team.toml"));
    const bb = new Blackboard(join(dir, ".team"));
    const meta = makeMeta("t-budget-cost", "workshop", ["a1"], 2);
    bb.initTask(meta, ARTIFACT);

    const summary = await runTaskRounds(bb, config, meta, config.agents);

    expect(summary.budgetExceeded).toContain("max_estimated_cost_usd");
    expect(meta.completed_rounds).toBe(1);
    expect(meta.estimated_cost_usd).toBeCloseTo(0.05, 6);
    const runDirs = readdirSync(join(bb.taskDir(meta.id), "runs")).sort();
    expect(runDirs).toEqual(["r1-a1"]);
  }, T);

  test("budget exhausted before round 1 fails the task", async () => {
    const dir = makeTeamDir(["a1", "a2"], { budgets: "max_runs = 1\nmax_wall_time_ms = 600000\nmax_estimated_cost_usd = 5.0" });
    const config = await loadConfig(join(dir, "team.toml"));
    const bb = new Blackboard(join(dir, ".team"));
    const meta = makeMeta("t-budget-zero", "workshop", ["a1", "a2"], 2);
    bb.initTask(meta, ARTIFACT);

    const summary = await runTaskRounds(bb, config, meta, config.agents);

    expect(summary.budgetExceeded).toContain("max_runs");
    expect(meta.completed_rounds).toBe(0);
    expect(meta.state).toBe("failed");
    expect(readdirSync(join(bb.taskDir(meta.id), "runs"))).toHaveLength(0);
  }, T);
});
