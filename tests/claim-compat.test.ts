// Claim-bundle compatibility tests.
//
// A relay that predates participant attestation returns only the five
// credential fields. fetchClaim used to demand participants/peers and throw
// *after* redemption — and redemption burns the claim before responding, so
// the strict check destroyed a valid one-time URL for a field the client can
// do without. These tests pin the tolerant behavior and the hard errors that
// must survive it.

import { describe, expect, test } from "bun:test";
import { fetchClaim } from "../src/bus/client.ts";

/** Serve one JSON body on a loopback port; returns the base URL. */
function stubServer(body: unknown, status = 200): { url: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

const CREDS = {
  participant: "juno",
  token: "t".repeat(48),
  channel_secret: "s".repeat(64),
  channel: "chat-test",
  epoch: "e-test",
};

describe("claim bundle: relay predating attestation", () => {
  test("accepts the 5-key bundle and marks it unattested", async () => {
    const s = stubServer(CREDS);
    try {
      const b = await fetchClaim(`${s.url}/c/chat-test/claim/abc`);
      expect(b.participant).toBe("juno");
      expect(b.channel).toBe("chat-test");
      expect(b.epoch).toBe("e-test");
      expect(b.token).toBe(CREDS.token);
      expect(b.channel_secret).toBe(CREDS.channel_secret);
      // the whole point: no attestation, no throw
      expect(b.attested).toBe(false);
      expect(b.participants).toEqual([]);
      expect(b.peers).toEqual([]);
    } finally {
      s.stop();
    }
  });
});

describe("claim bundle: relay with attestation", () => {
  test("carries participants and peers through", async () => {
    const s = stubServer({
      ...CREDS,
      participants: ["juno", "moss"],
      peers: ["moss"],
    });
    try {
      const b = await fetchClaim(`${s.url}/c/chat-test/claim/abc`);
      expect(b.attested).toBe(true);
      expect(b.participants).toEqual(["juno", "moss"]);
      expect(b.peers).toEqual(["moss"]);
    } finally {
      s.stop();
    }
  });

  test("rejects attestation that contradicts the redeemer", async () => {
    // participants must include the redeemer, and peers must not
    const s = stubServer({ ...CREDS, participants: ["moss"], peers: ["moss"] });
    try {
      await expect(fetchClaim(`${s.url}/c/chat-test/claim/abc`)).rejects.toThrow(
        /contradicts the redeemer/
      );
    } finally {
      s.stop();
    }
  });
});

describe("claim bundle: credentials stay mandatory", () => {
  for (const missing of ["participant", "token", "channel_secret", "channel", "epoch"]) {
    test(`rejects a bundle missing ${missing} (with attestation present)`, async () => {
      const body: Record<string, unknown> = {
        ...CREDS,
        participants: ["juno", "moss"],
        peers: ["moss"],
      };
      delete body[missing];
      const s = stubServer(body);
      try {
        await expect(fetchClaim(`${s.url}/c/chat-test/claim/abc`)).rejects.toThrow(
          /malformed bundle/
        );
      } finally {
        s.stop();
      }
    });
  }

  test("rejects a non-OK response with the relay's error", async () => {
    const s = stubServer({ error: "no such claim" }, 404);
    try {
      await expect(fetchClaim(`${s.url}/c/chat-test/claim/abc`)).rejects.toThrow(
        /no such claim/
      );
    } finally {
      s.stop();
    }
  });

  test("a non-array attestation is treated as absent, not fatal", async () => {
    // shape drift shouldn't burn a claim either
    const s = stubServer({ ...CREDS, participants: "juno", peers: "moss" });
    try {
      const b = await fetchClaim(`${s.url}/c/chat-test/claim/abc`);
      expect(b.attested).toBe(false);
      expect(b.participants).toEqual([]);
    } finally {
      s.stop();
    }
  });
});
