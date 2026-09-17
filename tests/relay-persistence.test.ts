// Relay durability (v0.3): `team bus-serve --data-dir` round-trip — a real
// subprocess relay is killed -9 mid-chat and restarted on the same data
// dir; channels, token hashes, and the full log must be intact, the auditor
// lease reset, and a participant resuming from its durable cursor must see
// no loss and no duplicates. Plus the in-process reload path and the
// unchanged ephemeral default.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRelay } from "../src/bus/relay.ts";
import {
  adminMintClaim,
  adminProvisionChannel,
  BusClient,
  fetchClaim,
} from "../src/bus/client.ts";
import { newChannelSecret, newToken } from "../src/bus/crypto.ts";
import {
  encodeEnded,
  encodeStarted,
  encodeTurn,
  endedMsgId,
  openingMsgId,
  turnMsgId,
  type RelayMessage,
} from "../src/bus/protocol.ts";
import { ParticipantRuntime } from "../src/bus/participant.ts";

const T = 60_000;
const REPO = join(import.meta.dir, "..");
const TEAM = join(REPO, "bin", "team.ts");
const ADMIN = "adm-durable";

type RelayProc = ReturnType<typeof Bun.spawn>;

async function waitFor(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

/** A momentarily-free loopback port (small race, fine on a dev box). */
async function freePort(): Promise<number> {
  const r = startRelay({ port: 0, adminToken: "x" });
  const port = r.port;
  r.stop();
  return port;
}

/** Spawn `team bus-serve --data-dir` as a real subprocess; await /healthz. */
async function spawnRelay(port: number, dataDir: string): Promise<RelayProc> {
  const proc = Bun.spawn(
    [
      process.execPath, TEAM, "bus-serve",
      "--port", String(port),
      "--admin-token", ADMIN,
      "--data-dir", dataDir,
    ],
    { cwd: REPO, stdout: "pipe", stderr: "pipe" }
  );
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const res = await fetch(`${url}/healthz`);
      if (res.ok) return proc;
    } catch {
      // not up yet
    }
    if (proc.exitCode !== null) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`relay exited before healthz (code ${proc.exitCode}): ${err}`);
    }
    if (Date.now() > deadline) {
      proc.kill(9);
      throw new Error("relay did not become healthy within 20s");
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function kill9(proc: RelayProc): Promise<void> {
  proc.kill(9);
  await proc.exited;
}

describe("relay durability", () => {
  test(
    "kill -9 round-trip: channel + tokens + full log intact, lease cleared, participant resumes",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "team-relay-durable-"));
      const dataDir = join(dir, "data");
      const stateDir = join(dir, "p-b");
      const port = await freePort();
      const url = `http://127.0.0.1:${port}`;
      const secret = newChannelSecret();
      const tokens = { a: newToken(), b: newToken(), orchestrator: newToken() };
      const channel = "chat-durable1";
      const epoch = "e-dur1";
      const mk = (id: "a" | "b" | "orchestrator") =>
        new BusClient({ busUrl: url, channel, token: tokens[id], secret });

      // ---- boot 1: provision, run a real exchange, hold the lease ----
      let before: RelayMessage[] = [];
      let claimId = "";
      let relay = await spawnRelay(port, dataDir);
      try {
        await adminProvisionChannel(url, ADMIN, { channel, epoch, tokens });
        const [ca, co] = [mk("a"), mk("orchestrator")];

        // participant b answers a's opening turn through the live channel
        const ctl1 = new AbortController();
        const pb1 = new ParticipantRuntime({
          busUrl: url, channel, epoch, token: tokens.b, secret,
          agentId: "b", peerId: "a", stateDir,
          pollWaitMs: 30, replyTimeoutMs: 60_000,
          onTurn: async (ctx) => ({
            body: `b answers seq ${ctx.peerTurn?.seq ?? 0}`,
          }),
        });
        const runB1 = pb1.run(ctl1.signal);
        await co.publish(openingMsgId(epoch), encodeStarted("a", "durability"));
        await ca.publish(turnMsgId("a", epoch, null), encodeTurn(null, "a opens"));
        // b's reply lands as seq 3 and b observes it (cursor covers its own msg)
        await waitFor(() => pb1.cursor >= 3, "b's reply committed");
        ctl1.abort();
        await runB1;
        expect(pb1.transcript.map((t) => t.author)).toEqual(["a", "b"]);

        // auditor lease held pre-kill — a second author is rejected
        await co.requestAuditorLease();
        await expect(ca.requestAuditorLease()).rejects.toThrow(/held by/);

        // an outstanding unredeemed claim (must NOT survive the restart)
        const minted = await adminMintClaim(url, ADMIN, channel, "a", secret);
        claimId = minted.claim_id;

        // a committed terminal control on the log
        const endAck = await co.publish(
          endedMsgId(epoch, 3, "idle_timeout"),
          encodeEnded("idle_timeout", 3)
        );
        expect(endAck.seq).toBe(4);

        before = (await ca.poll(0, 0)).messages;
        expect(before.map((m) => m.seq)).toEqual([1, 2, 3, 4]);
        expect(before.map((m) => m.author)).toEqual([
          "orchestrator", "a", "b", "orchestrator",
        ]);
      } finally {
        await kill9(relay);
      }

      // ---- boot 2: same data dir — recoverable state is back ----
      relay = await spawnRelay(port, dataDir);
      try {
        const [ca, co] = [mk("a"), mk("orchestrator")];

        // the full log is intact, envelopes identical to pre-kill
        const res = await ca.poll(0, 0);
        expect(res.latest).toBe(4);
        expect(res.messages).toEqual(before);

        // dedupe survived: a retried msg_id returns its seq, no new append
        const dup = await ca.publish(before[1].msg_id, encodeTurn(null, "a opens"));
        expect(dup.seq).toBe(2);
        expect(dup.deduped).toBe(true);
        expect((await ca.poll(0, 0)).latest).toBe(4);

        // token auth survived: the same bearer token authenticates as "a"
        // (dup publish above already proved it; wrong tokens still rejected)
        const impostor = new BusClient({
          busUrl: url, channel, token: newToken(), secret,
        });
        await expect(impostor.poll(0, 0)).rejects.toThrow(/unauthorized/);

        // lease cleared on boot: a can acquire what was held (and 409'd) pre-kill
        const lease = await ca.requestAuditorLease();
        expect(lease.auditor).toBe("a");
        // and single-holder semantics still apply afterwards
        await expect(co.requestAuditorLease()).rejects.toThrow(/held by a/);

        // the pre-kill claim is gone — claims are deliberately transient
        await expect(
          fetchClaim(`${url}/c/${channel}/claim/${claimId}`)
        ).rejects.toThrow(/no such claim/);
        // post-restart the relay holds no raw tokens: minting without one fails
        await expect(
          adminMintClaim(url, ADMIN, channel, "b", secret)
        ).rejects.toThrow(/token/);
        // but minting with the participant's token in the body works
        const mintedB = await adminMintClaim(
          url, ADMIN, channel, "b", secret, 60_000, tokens.b
        );
        const bundleB = await fetchClaim(`${url}/c/${channel}/claim/${mintedB.claim_id}`);
        expect(bundleB.token).toBe(tokens.b);
        expect(bundleB.peers).toEqual(["a"]);

        // raw tokens never touched disk — only their SHA-256 hashes did
        for (const f of ["relay.sqlite", "relay.sqlite-wal"]) {
          const p = join(dataDir, f);
          if (!existsSync(p)) continue;
          const bytes = readFileSync(p);
          for (const t of Object.values(tokens)) {
            expect(bytes.includes(t)).toBe(false);
          }
        }

        // a restarted participant resumes from its durable cursor: it sees
        // the terminal control and ends — no loss, no duplicates, no crash
        let calls = 0;
        const pb2 = new ParticipantRuntime({
          busUrl: url, channel, epoch, token: tokens.b, secret,
          agentId: "b", peerId: "a", stateDir,
          pollWaitMs: 30, replyTimeoutMs: 60_000,
          onTurn: async () => {
            calls++;
            return { body: "must never be produced" };
          },
        });
        const res2 = await pb2.run();
        expect(res2.ended).toBe("idle_timeout");
        expect(pb2.transcript.map((t) => t.author)).toEqual(["a", "b"]);
        expect(new Set(pb2.transcript.map((t) => t.seq)).size).toBe(2);
        expect(pb2.cursor).toBe(4);
        expect(calls).toBe(0);

        // the log keeps assigning seqs — the counter survived the restart
        const late = await ca.publish("a-late-1", encodeTurn(4, "post-restart"));
        expect(late.seq).toBe(5);
        expect((await ca.poll(0, 0)).latest).toBe(5);
      } finally {
        await kill9(relay);
      }
    },
    T
  );

  test("in-process restart reloads the data dir; no --data-dir stays ephemeral", async () => {
    const dir = mkdtempSync(join(tmpdir(), "team-relay-mem-"));
    const dataDir = join(dir, "data");
    const secret = newChannelSecret();
    const tokens = { a: newToken(), b: newToken(), orchestrator: newToken() };
    const channel = "chat-mem1";

    // durable path: stop() + startRelay() on the same dir reloads everything
    const r1 = startRelay({ port: 0, adminToken: ADMIN, dataDir });
    await adminProvisionChannel(r1.url, ADMIN, { channel, epoch: "e1", tokens });
    const c1 = new BusClient({ busUrl: r1.url, channel, token: tokens.a, secret });
    await c1.publish("m-1", encodeTurn(null, "durable in-process"));
    r1.stop();

    const r2 = startRelay({ port: 0, adminToken: ADMIN, dataDir });
    try {
      const c2 = new BusClient({ busUrl: r2.url, channel, token: tokens.a, secret });
      const res = await c2.poll(0, 0);
      expect(res.messages.map((m) => m.msg_id)).toEqual(["m-1"]);
      expect(res.latest).toBe(1);
      const ack = await c2.publish("m-2", encodeTurn(1, "continues"));
      expect(ack.seq).toBe(2);
    } finally {
      r2.stop();
    }

    // ephemeral default: same exercise without --data-dir loses everything
    const e1 = startRelay({ port: 0, adminToken: ADMIN });
    await adminProvisionChannel(e1.url, ADMIN, { channel, epoch: "e1", tokens });
    const ce = new BusClient({ busUrl: e1.url, channel, token: tokens.a, secret });
    await ce.publish("m-1", encodeTurn(null, "ephemeral"));
    e1.stop();

    const e2 = startRelay({ port: 0, adminToken: ADMIN });
    try {
      const ce2 = new BusClient({ busUrl: e2.url, channel, token: tokens.a, secret });
      await expect(ce2.poll(0, 0)).rejects.toThrow(/no such channel/);
    } finally {
      e2.stop();
    }
  }, T);
});
