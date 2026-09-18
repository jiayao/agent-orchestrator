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
import {
  adminMintClaim,
  adminProvisionChannel,
  adminRevokeToken,
  BusClient,
  fetchClaim,
} from "../src/bus/client.ts";
import { newChannelSecret, newToken } from "../src/bus/crypto.ts";
import { provisionBusChat } from "../src/bus/session.ts";

async function channel(seats?: unknown) {
  const relay = startRelay({ port: 0, adminToken: "adm-test" });
  const secret = newChannelSecret();
  const tokens = { a: newToken(), b: newToken(), orchestrator: newToken() };
  const id = "chat-seats";
  await adminProvisionChannel(relay.url, "adm-test", {
    channel: id,
    epoch: "e-seats",
    tokens,
    ...(seats !== undefined ? { seats: seats as never } : {}),
  });
  return { relay, secret, tokens, id, ch: relay.channel(id)! };
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

describe("seats: claim carries seat identity", () => {
  test("a redeemed claim reports its seat_id and that it was freshly claimed", async () => {
    const { relay, id } = await channel();
    try {
      const secret = newChannelSecret();
      const minted = await adminMintClaim(relay.url, "adm-test", id, "a", secret, 60_000);
      const bundle = await fetchClaim(`${relay.url}/c/${id}/claim/${minted.claim_id}`);
      expect(bundle.participant).toBe("a");
      expect(bundle.seat_id).toBe("a");
      expect(bundle.seat_state).toBe("claimed");
    } finally {
      relay.stop();
    }
  });

  test("the seat fields are additive: a bundle without them still parses", async () => {
    // A relay that predates seats returns a body with NO seat_id/seat_state.
    // Stub that response literally rather than hitting a seat-aware relay —
    // otherwise the test passes on fields the old relay would never send.
    const stub = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({
          participant: "a",
          token: "tok-legacy",
          channel_secret: "sec-legacy",
          channel: "chat-legacy",
          epoch: "e1",
        }),
    });
    try {
      const bundle = await fetchClaim(`http://127.0.0.1:${stub.port}/claim/legacy`);
      expect(bundle.participant).toBe("a");
      // the redeemer must degrade, not reject: rejecting throws AFTER the
      // relay burned the one-time claim
      expect(bundle.seat_id).toBeUndefined();
      expect(bundle.seat_state).toBeUndefined();
    } finally {
      stub.stop(true);
    }
  });
});

describe("seats: revoke vacates rather than erases", () => {
  test("the seat survives revocation and is marked vacant", async () => {
    const { relay, ch, id } = await channel();
    try {
      await adminRevokeToken(relay.url, "adm-test", id, "a");
      // the credential is gone...
      expect([...ch.tokens.values()]).not.toContain("a");
      // ...but the seat is still addressable, which is the whole point
      expect(ch.seats.has("a")).toBe(true);
      expect(ch.seats.get("a")!.state).toBe("vacant");
      // the untouched seat is unaffected
      expect(ch.seats.get("b")!.state).toBe("claimed");
    } finally {
      relay.stop();
    }
  });

  test("a revoked participant's token no longer authenticates", async () => {
    const { relay, secret, tokens, id } = await channel();
    try {
      await adminRevokeToken(relay.url, "adm-test", id, "a");
      const dead = new BusClient({ busUrl: relay.url, channel: id, token: tokens.a, secret });
      await expect(dead.poll(0, 0)).rejects.toThrow();
    } finally {
      relay.stop();
    }
  });

  test("revoking an unknown seat is a 404, not a silent success", async () => {
    const { relay, id } = await channel();
    try {
      await expect(adminRevokeToken(relay.url, "adm-test", id, "nobody")).rejects.toThrow(
        /no such seat/
      );
    } finally {
      relay.stop();
    }
  });
});

describe("seats: refilling a vacant seat", () => {
  test("minting a vacant seat without a token is refused with a clear reason", async () => {
    const { relay, secret, id } = await channel();
    try {
      await adminRevokeToken(relay.url, "adm-test", id, "a");
      // this is exactly where the OLD relay said "no such participant" and
      // made the refill impossible; now it names the real problem
      await expect(adminMintClaim(relay.url, "adm-test", id, "a", secret)).rejects.toThrow(
        /vacant/
      );
    } finally {
      relay.stop();
    }
  });

  test("minting a vacant seat with a fresh token rebinds it; the claim redeems", async () => {
    const { relay, secret, id, ch } = await channel();
    try {
      await adminRevokeToken(relay.url, "adm-test", id, "a");
      const fresh = newToken();
      const minted = await adminMintClaim(relay.url, "adm-test", id, "a", secret, 60_000, fresh);

      // the seat is claimed again, now holding the fresh credential
      expect(ch.seats.get("a")!.state).toBe("claimed");
      expect([...ch.tokens.values()]).toContain("a");

      const bundle = await fetchClaim(`${relay.url}/c/${id}/claim/${minted.claim_id}`);
      expect(bundle.participant).toBe("a");
      expect(bundle.token).toBe(fresh);
      // the redeemer can tell it walked into a refilled seat
      expect(bundle.seat_id).toBe("a");
      expect(bundle.seat_state).toBe("vacant");
      expect(bundle.participants).toContain("a");
      expect(bundle.attested).toBe(true);
    } finally {
      relay.stop();
    }
  });

  test("the refilled credential authenticates; the revoked one cannot", async () => {
    const { relay, secret, tokens, id } = await channel();
    try {
      await adminRevokeToken(relay.url, "adm-test", id, "a");
      const fresh = newToken();
      const minted = await adminMintClaim(relay.url, "adm-test", id, "a", secret, 60_000, fresh);
      await fetchClaim(`${relay.url}/c/${id}/claim/${minted.claim_id}`);

      const revived = new BusClient({ busUrl: relay.url, channel: id, token: fresh, secret });
      // authenticates: an empty log is a valid poll, not an auth error
      await expect(revived.poll(0, 0)).resolves.toBeDefined();

      const dead = new BusClient({ busUrl: relay.url, channel: id, token: tokens.a, secret });
      await expect(dead.poll(0, 0)).rejects.toThrow();
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

  test("derived seats are persisted: vacate survives a reload (pre-seat store)", () => {
    // The migration derives seats from tokens. If those rows are only in
    // memory, vacate's write hits a missing row and the seat disappears on
    // the next boot (refill then 400 no such seat). Persisting on boot -
    // or upserting on vacate - must keep the seat addressable.
    const dir = mkdtempSync(join(tmpdir(), "team-seats-persist-"));
    const hash = (t: string) => new Bun.CryptoHasher("sha256").update(t).digest("hex");

    const s1 = new RelayStore(dir);
    s1.createChannel(
      "chat-old",
      "e1",
      new Date().toISOString(),
      [[hash(newToken()), "a"], [hash(newToken()), "orchestrator"]],
      []
    );
    s1.close();

    // boot derives the seat, then it is revoked
    const s2 = new RelayStore(dir);
    s2.loadChannels();
    s2.vacateSeat("chat-old", "a");
    s2.close();

    // reload: the seat must still be there, and vacant
    const s3 = new RelayStore(dir);
    const [after] = s3.loadChannels();
    expect(after.seats.has("a")).toBe(true);
    expect(after.seats.get("a")!.state).toBe("vacant");
    s3.close();
  });

  test("an open seat passes provisioning (token minted per seat_id)", async () => {
    // The relay refuses a seat with no token behind it, so a declared open
    // slot must still carry a credential or provisioning 400s at "seat X has
    // no token". Claims stay bound to the two speaking agents.
    const relay = startRelay({ port: 0, adminToken: "adm-test" });
    try {
      const agents = [
        { id: "a", kind: "bus", bus_url: relay.url },
        { id: "b", kind: "bus", bus_url: relay.url },
      ] as Parameters<typeof provisionBusChat>[2];
      const prov = await provisionBusChat(relay.url, "adm-test", agents, {
        seats: [{ seat_id: "a" }, { seat_id: "b" }, { seat_id: "reviewer" }],
      });
      const ch = relay.channel(prov.channel)!;
      expect([...ch.seats.keys()].sort()).toEqual(["a", "b", "reviewer"]);
      // the open seat is backed by a token...
      expect([...ch.tokens.values()]).toContain("reviewer");
      // ...but is not handed a claim: onboarding stays at the two speakers
      expect(Object.keys(prov.claims).sort()).toEqual(["a", "b"]);
    } finally {
      relay.stop();
    }
  });
});
