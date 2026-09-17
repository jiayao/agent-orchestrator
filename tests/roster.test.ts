// Roster (presentation-only display names) tests.
//
// The roster rides on the chat_started control and exists purely so a human
// reading a transcript sees "mini-moss (juno)" instead of a bare wire id.
// These tests pin the property that matters: names are cosmetic. They never
// become an identity, never affect turn validation, and a malformed roster
// can never wedge a channel.

import { describe, expect, test } from "bun:test";
import { decodePayload, encodeStarted, TurnValidator } from "../src/bus/protocol.ts";
import { validateConfig, ConfigError } from "../src/config.ts";
import { buildRoster } from "../src/bus/session.ts";
import type { AgentConfig, RosterEntry } from "../src/types.ts";

function decode(text: string) {
  return decodePayload(text);
}

function agent(id: string, display_name?: string): AgentConfig {
  return {
    id,
    kind: "bus",
    adapter: "bus",
    role: "peer",
    env: {},
    bus_url: "https://relay.test",
    token_env: "T",
    ...(display_name !== undefined ? { display_name } : {}),
  };
}

describe("roster wire format", () => {
  test("encodeStarted omits roster when absent or empty (wire shape unchanged)", () => {
    const bare = JSON.parse(encodeStarted("a", "topic"));
    expect("roster" in bare).toBe(false);

    const empty = JSON.parse(encodeStarted("a", "topic", []));
    expect("roster" in empty).toBe(false);
  });

  test("encodeStarted carries roster when populated", () => {
    const roster: RosterEntry[] = [{ id: "a", display_name: "Moss" }, { id: "b" }];
    const p = JSON.parse(encodeStarted("a", "topic", roster));
    expect(p.roster).toEqual(roster);
    expect(p.first_speaker).toBe("a");
  });

  test("round-trips through decodePayload", () => {
    const roster: RosterEntry[] = [
      { id: "juno", display_name: "mini-moss" },
      { id: "moss", display_name: "Moss (Linktree)" },
    ];
    const decoded = decode(encodeStarted("moss", "topic", roster));
    expect(decoded?.type).toBe("control");
    if (decoded?.type !== "control") throw new Error("unreachable");
    expect(decoded.control).toBe("chat_started");
    expect(decoded.first_speaker).toBe("moss");
    expect(decoded.roster).toEqual(roster);
  });

  test("pre-roster chat_started still decodes (backward compatible)", () => {
    // Exactly what an older orchestrator publishes.
    const legacy = JSON.stringify({
      v: 1,
      type: "control",
      control: "chat_started",
      first_speaker: "a",
      topic: "t",
    });
    const decoded = decode(legacy);
    expect(decoded?.type).toBe("control");
    if (decoded?.type !== "control") throw new Error("unreachable");
    expect(decoded.first_speaker).toBe("a");
    expect(decoded.roster).toBeUndefined();
  });
});

describe("roster degrades gracefully (never fatal)", () => {
  test("malformed entries are dropped, control is NOT nulled", () => {
    // A strict parse would return null here, which becomes bad_shape and
    // discards the whole chat_started — wedging the channel over cosmetics.
    const text = JSON.stringify({
      v: 1,
      type: "control",
      control: "chat_started",
      first_speaker: "a",
      topic: "t",
      roster: [
        null,
        "not-an-object",
        42,
        [],
        { display_name: "no id" },
        { id: "" },
        { id: "a", display_name: "Moss" },
      ],
    });
    const decoded = decode(text);
    expect(decoded).not.toBeNull();
    if (decoded?.type !== "control") throw new Error("unreachable");
    expect(decoded.first_speaker).toBe("a");
    expect(decoded.roster).toEqual([{ id: "a", display_name: "Moss" }]);
  });

  test("non-array roster is ignored, not fatal", () => {
    const text = JSON.stringify({
      v: 1,
      type: "control",
      control: "chat_started",
      first_speaker: "a",
      topic: "t",
      roster: "oops",
    });
    const decoded = decode(text);
    expect(decoded).not.toBeNull();
    if (decoded?.type !== "control") throw new Error("unreachable");
    expect(decoded.roster).toBeUndefined();
  });

  test("a roster that collapses to empty is omitted entirely", () => {
    const text = JSON.stringify({
      v: 1,
      type: "control",
      control: "chat_started",
      first_speaker: "a",
      topic: "t",
      roster: [{ nope: true }],
    });
    const decoded = decode(text);
    if (decoded?.type !== "control") throw new Error("unreachable");
    expect(decoded.roster).toBeUndefined();
  });

  test("empty-string display_name is normalized to absent", () => {
    const text = JSON.stringify({
      v: 1,
      type: "control",
      control: "chat_started",
      first_speaker: "a",
      topic: "t",
      roster: [{ id: "a", display_name: "" }],
    });
    const decoded = decode(text);
    if (decoded?.type !== "control") throw new Error("unreachable");
    expect(decoded.roster).toEqual([{ id: "a" }]);
  });
});

describe("roster is presentation-only, never identity", () => {
  test("duplicate display names do not affect speaker validation", () => {
    // Both sides call themselves "moss" — the exact end-user confusion the
    // roster exists to fix. Validation must still key on ids only.
    // Mirrors real usage: the auditor and participant construct the validator
    // with participants only — firstSpeaker arrives via the chat_started control.
    const v = new TurnValidator(["a", "b"]);
    expect(v.expected).toBeNull();

    const started = decode(
      encodeStarted("a", "t", [
        { id: "a", display_name: "moss" },
        { id: "b", display_name: "moss" },
      ])
    );
    if (started?.type !== "control") throw new Error("unreachable");
    expect(v.ingest({ seq: 1, author: "orchestrator" }, started).kind).toBe("started");

    // a speaks first, then b — alternation by id, unaffected by labels
    expect(v.ingest({ seq: 2, author: "a" }, { v: 1, type: "turn", in_reply_to: null, body: "hi" }).kind).toBe("turn");
    expect(v.expected).toBe("b");
    expect(v.ingest({ seq: 3, author: "b" }, { v: 1, type: "turn", in_reply_to: 2, body: "yo" }).kind).toBe("turn");
    expect(v.expected).toBe("a");
  });

  test("a display name is not accepted as a speaker identity", () => {
    const v = new TurnValidator(["a", "b"]);
    const started = decode(encodeStarted("a", "t", [{ id: "a", display_name: "moss" }]));
    if (started?.type !== "control") throw new Error("unreachable");
    expect(v.ingest({ seq: 1, author: "orchestrator" }, started).kind).toBe("started");

    // speaking under the display name must be rejected: only ids are speakers
    const asLabel = v.ingest(
      { seq: 2, author: "moss" },
      { v: 1, type: "turn", in_reply_to: null, body: "spoof" }
    );
    expect(asLabel.kind).toBe("ignore");
    if (asLabel.kind !== "ignore") throw new Error("unreachable");
    expect(asLabel.why).toBe("not_participant");
  });
});

describe("buildRoster", () => {
  test("includes display_name only when set", () => {
    expect(buildRoster([agent("a", "Moss"), agent("b")])).toEqual([
      { id: "a", display_name: "Moss" },
      { id: "b" },
    ]);
  });

  test("is empty-safe for agents without names", () => {
    expect(buildRoster([agent("a"), agent("b")])).toEqual([{ id: "a" }, { id: "b" }]);
  });
});

describe("display_name config parsing", () => {
  const cfg = (agentsToml: string) => `
schema_version = 1

[[roles]]
name = "peer"
instructions = "peer"

${agentsToml}
`;

  test("parses display_name on a bus agent", () => {
    const c = validateConfig(
      Bun.TOML.parse(
        cfg(`
[[agents]]
id = "a"
kind = "bus"
role = "peer"
bus_url = "https://relay.test"
token_env = "T"
display_name = "mini-moss"
`)
      ),
      "/fake.toml"
    );
    expect(c.agents[0].display_name).toBe("mini-moss");
  });

  test("trims whitespace and treats blank as absent", () => {
    const c = validateConfig(
      Bun.TOML.parse(
        cfg(`
[[agents]]
id = "a"
kind = "bus"
role = "peer"
bus_url = "https://relay.test"
token_env = "T"
display_name = "   "
`)
      ),
      "/fake.toml"
    );
    expect(c.agents[0].display_name).toBeUndefined();
  });

  test("allows colliding display names across distinct ids", () => {
    const c = validateConfig(
      Bun.TOML.parse(
        cfg(`
[[agents]]
id = "a"
kind = "bus"
role = "peer"
bus_url = "https://relay.test"
token_env = "T"
display_name = "moss"

[[agents]]
id = "b"
kind = "bus"
role = "peer"
bus_url = "https://relay.test"
token_env = "T"
display_name = "moss"
`)
      ),
      "/fake.toml"
    );
    expect(c.agents.map((a) => a.display_name)).toEqual(["moss", "moss"]);
  });

  test("still rejects colliding ids", () => {
    expect(() =>
      validateConfig(
        Bun.TOML.parse(
          cfg(`
[[agents]]
id = "a"
kind = "bus"
role = "peer"
bus_url = "https://relay.test"
token_env = "T"
display_name = "one"

[[agents]]
id = "a"
kind = "bus"
role = "peer"
bus_url = "https://relay.test"
token_env = "T"
display_name = "two"
`)
        ),
        "/fake.toml"
      )
    ).toThrow(ConfigError);
  });
});
