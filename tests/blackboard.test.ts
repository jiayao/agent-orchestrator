import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Blackboard } from "../src/blackboard.ts";
import { ARTIFACT, makeMeta, makeTeamDir } from "./helpers.ts";

describe("blackboard", () => {
  test("events.jsonl is append-only with monotonically increasing seq", async () => {
    const dir = makeTeamDir(["a1"]);
    const bb = new Blackboard(join(dir, ".team"));
    const meta = makeMeta("t-test-1", "workshop", ["a1"], 2);
    bb.initTask(meta, ARTIFACT);

    const e0 = await bb.appendEvent(meta.id, {
      actor: "orchestrator", type: "task_created", round: 0, reply_to: null, body: "created",
    });
    const e1 = await bb.appendEvent(meta.id, {
      actor: "a1", type: "position", round: 1, reply_to: null, body: "first",
    });
    const e2 = await bb.appendEvent(meta.id, {
      actor: "a1", type: "position", round: 1, reply_to: e1.event_id, body: "second",
    });

    expect([e0.seq, e1.seq, e2.seq]).toEqual([0, 1, 2]);
    expect([e0.event_id, e1.event_id, e2.event_id]).toEqual(["evt_0000", "evt_0001", "evt_0002"]);

    const lines = readFileSync(bb.eventsPath(meta.id), "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => JSON.parse(l).seq)).toEqual([0, 1, 2]);
    expect(bb.readEvents(meta.id).map((e) => e.body)).toEqual(["created", "first", "second"]);
  });

  test("concurrent appends get unique sequential seq numbers", async () => {
    const dir = makeTeamDir(["a1"]);
    const bb = new Blackboard(join(dir, ".team"));
    const meta = makeMeta("t-test-2", "ask", ["a1"], 1);
    bb.initTask(meta, ARTIFACT);

    const evs = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        bb.appendEvent(meta.id, {
          actor: "a1", type: "note", round: 1, reply_to: null, body: `note ${i}`,
        })
      )
    );
    expect(new Set(evs.map((e) => e.seq)).size).toBe(8);
    expect(evs.map((e) => e.seq).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(bb.eventCount(meta.id)).toBe(8);
  });

  test("view.md renders after appends", async () => {
    const dir = makeTeamDir(["a1"]);
    const bb = new Blackboard(join(dir, ".team"));
    const meta = makeMeta("t-test-3", "workshop", ["a1"], 2);
    bb.initTask(meta, ARTIFACT);
    expect(existsSync(bb.viewPath(meta.id))).toBe(true);

    await bb.appendEvent(meta.id, {
      actor: "a1", type: "issue", round: 1, reply_to: null,
      body: "the assumption is unverified", claims: ["claim one"],
    });
    bb.renderView(meta.id);

    const view = readFileSync(bb.viewPath(meta.id), "utf8");
    expect(view).toContain(`# Task ${meta.id} (workshop)`);
    expect(view).toContain("## Round 1");
    expect(view).toContain("the assumption is unverified");
    expect(view).toContain("- claim one");
  });
});
