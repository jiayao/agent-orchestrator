// Seats (v0.4), stage (a): declaring the seat list at provisioning.
//
// A seat is the channel's stable, addressable slot. Stage (a) is only the
// declaration + storage half: the relay records which slots exist, provisions
// them atomically with the tokens, and never lets a seat exist without a
// credential behind it. Claiming/refilling (b)(c) build on this.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRelay } from "../src/bus/relay.ts";
import { RelayStore } from "../src/bus/store.ts";
import { adminProvisionChannel } from "../src/bus/client.ts";
import { newChannelSecret, newToken } from "../src/bus/crypto.ts";

async function channel(seats?: unknown) {
  const relay = startRelay({ port: 0, adminToken: "adm-test" });
  const tokens = { a: newToken(), b: newToken(), orchestrator: newToken() };
  const id = "chat-seats";
  await adminProvisionChannel(relay.url, "adm-test", {
    channel: id,
    epoch: "e-seats",
    tokens,
    ...(seats !== undefined ? { seats: seats as never } : {}),
  });
  return { relay, tokens, id, ch: relay.channel(id)! };
}

describe("seats: declaring the list", () => {
  test("a seat list absent from the request derives one seat per participant", async () => {
    const { relay, ch } = await channel();
    try {
      // the reserved "orchestrator" auditor author is not a seat
      expect([...ch.seats.keys()].sort()).toEqual(["a", "b"]);
      for (const s of ch.seats.values()) expect(s.state).toBe("claimed");
    } finally {
      relay.stop();
    }
  });

  test("an explicit seat list is recorded with its label and role", async () => {
    const { relay, ch } = await channel([
      { seat_id: "a", display_name: "Moss", role: "critic" },
      { seat_id: "b" },
    ]);
    try {
      expect([...ch.seats.keys()].sort()).toEqual(["a", "b"]);
      expect(ch.seats.get("a")).toMatchObject({
        seat_id: "a",
        display_name: "Moss",
        role: "critic",
        state: "claimed",
      });
      // a label-less seat is still a valid seat
      expect(ch.seats.get("b")!.display_name).toBeUndefined();
    } finally {
      relay.stop();
    }
  });

  test("a seat may hold a slot no speaker occupies yet", async () => {
    // provision declares an extra open seat: the chat is still a speakers=2
    // conversation, but the channel can hand out slot "reviewer" later.
    const relay = startRelay({ port: 0, adminToken: "adm-test" });
    try {
      const tokens = { a: newToken(), b: newToken(), reviewer: newToken(), orchestrator: newToken() };
      await adminProvisionChannel(relay.url, "adm-test", {
        channel: "chat-open",
        epoch: "e1",
        tokens,
        seats: [{ seat_id: "a" }, { seat_id: "b" }, { seat_id: "reviewer" }],
      });
      expect([...relay.channel("chat-open")!.seats.keys()].sort()).toEqual([
        "a",
        "b",
        "reviewer",
      ]);
    } finally {
      relay.stop();
    }
  });

  test("a seat with no token is refused at provision, not at join", async () => {
    const relay = startRelay({ port: 0, adminToken: "adm-test" });
    try {
      const tokens = { a: newToken(), orchestrator: newToken() };
      await expect(
        adminProvisionChannel(relay.url, "adm-test", {
          channel: "chat-orphan",
          epoch: "e1",
          tokens,
          seats: [{ seat_id: "a" }, { seat_id: "ghost" }],
        })
      ).rejects.toThrow(/no token/);
      // the failed provision must not leave a half-built channel behind
      expect(relay.channel("chat-orphan")).toBeUndefined();
    } finally {
      relay.stop();
    }
  });

  test("duplicate seat ids are refused", async () => {
    const relay = startRelay({ port: 0, adminToken: "adm-test" });
    try {
      const tokens = { a: newToken(), orchestrator: newToken() };
      await expect(
        adminProvisionChannel(relay.url, "adm-test", {
          channel: "chat-dup",
          epoch: "e1",
          tokens,
          seats: [{ seat_id: "a" }, { seat_id: "a" }],
        })
      ).rejects.toThrow(/duplicate seat/);
    } finally {
      relay.stop();
    }
  });
});

describe("seats: durable from the start", () => {
  test("seats round-trip through the store", () => {
    const dir = mkdtempSync(join(tmpdir(), "team-seats-"));
    const hash = (t: string) => new Bun.CryptoHasher("sha256").update(t).digest("hex");
    const aTok = newToken();

    const s1 = new RelayStore(dir);
    s1.createChannel("chat-x", "e1", new Date().toISOString(), [[hash(aTok), "a"]], [
      { seat_id: "a" },
      { seat_id: "b", display_name: "Bee" },
    ]);
    s1.close();

    const s2 = new RelayStore(dir);
    const [loaded] = s2.loadChannels();
    expect([...loaded.seats.keys()].sort()).toEqual(["a", "b"]);
    expect(loaded.seats.get("b")).toMatchObject({ seat_id: "b", display_name: "Bee", state: "claimed" });
    expect(loaded.tokens.get(hash(aTok))).toBe("a");
    s2.close();
  });

  test("a pre-seat store (no seat rows) derives seats from its live tokens", () => {
    // A store written by a relay with no seats table populated: boot must
    // reconstruct seats from the tokens instead of reporting none, and the
    // reserved orchestrator author must never become a seat.
    const dir = mkdtempSync(join(tmpdir(), "team-seats-migrate-"));
    const hash = (t: string) => new Bun.CryptoHasher("sha256").update(t).digest("hex");

    const s1 = new RelayStore(dir);
    s1.createChannel(
      "chat-old",
      "e1",
      new Date().toISOString(),
      [[hash(newToken()), "a"], [hash(newToken()), "b"], [hash(newToken()), "orchestrator"]],
      []
    );
    s1.close();

    const s2 = new RelayStore(dir);
    const [loaded] = s2.loadChannels();
    expect([...loaded.seats.keys()].sort()).toEqual(["a", "b"]);
    for (const s of loaded.seats.values()) expect(s.state).toBe("claimed");
    s2.close();
  });
});
