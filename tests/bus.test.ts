// Message bus (v0.2) tests: real relay over loopback HTTP, real AEAD
// envelopes, real auditor + participant runtimes. Mirrors DESIGN.md's
// required relay semantics and liveness ownership.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Blackboard } from "../src/blackboard.ts";
import { loadConfig, validateConfig } from "../src/config.ts";
import {
  decryptPayload,
  encryptPayload,
  newChannelSecret,
  newToken,
  BusCryptoError,
} from "../src/bus/crypto.ts";
import { startRelay, type RelayHandle } from "../src/bus/relay.ts";
import { adminProvisionChannel, BusClient, BusError, type FetchFn } from "../src/bus/client.ts";
import {
  encodeEnded,
  encodeStarted,
  encodeTurn,
  endedMsgId,
  type RelayMessage,
} from "../src/bus/protocol.ts";
import { runBusAuditor, type BusChatContext } from "../src/bus/auditor.ts";
import { ParticipantRuntime } from "../src/bus/participant.ts";
import { makeMeta } from "./helpers.ts";

const T = 30_000;

function busTeamToml(busUrl: string): string {
  return `schema_version = 1
team = "test"

[defaults]
timeout_ms = 30000
max_output_bytes = 200000
concurrency = 2

[budgets]
max_runs = 50
max_wall_time_ms = 600000
max_estimated_cost_usd = 5.00

[chat]
max_turns = 10
history_budget_chars = 12000
console_timeout_ms = 600000

[[roles]]
name = "critic"
instructions = "Find the weakest points."

[[agents]]
id = "a"
kind = "bus"
role = "critic"
bus_url = "${busUrl}"
token_env = "TEAM_BUS_TOKEN_A"

[[agents]]
id = "b"
kind = "bus"
role = "critic"
bus_url = "${busUrl}"
token_env = "TEAM_BUS_TOKEN_B"
`;
}

interface BusFixture {
  dir: string;
  relay: RelayHandle;
  config: Awaited<ReturnType<typeof loadConfig>>;
  bb: Blackboard;
  meta: ReturnType<typeof makeMeta>;
  ctx: BusChatContext;
  secret: string;
  tokens: Record<string, string>;
  clients: Record<"a" | "b" | "orchestrator", BusClient>;
}

async function setupBus(taskId: string, opts: { relay?: RelayHandle } = {}): Promise<BusFixture> {
  const relay = opts.relay ?? startRelay({ port: 0, adminToken: "adm-test" });
  const dir = mkdtempSync(join(tmpdir(), "team-bus-test-"));
  writeFileSync(join(dir, "team.toml"), busTeamToml(relay.url));
  const config = await loadConfig(join(dir, "team.toml"));
  const bb = new Blackboard(join(dir, ".team"));
  const meta = makeMeta(taskId, "chat", ["a", "b"], 10);
  meta.chat = {
    topic: "bus test topic",
    max_turns: 10,
    history_budget_chars: 12_000,
    console_timeout_ms: 600_000,
    substantive_turns: 0,
    total_turns: 0,
  };
  bb.initTask(meta, meta.chat.topic);

  const secret = newChannelSecret();
  const tokens = { a: newToken(), b: newToken(), orchestrator: newToken() };
  const channel = `chat-${taskId.replace(/[^A-Za-z0-9_-]/g, "")}`;
  const epoch = "e-test1";
  await adminProvisionChannel(relay.url, "adm-test", { channel, epoch, tokens });
  meta.chat.bus = {
    bus_url: relay.url,
    channel,
    epoch,
    participants: ["a", "b"],
    first_speaker: "a",
  };
  bb.writeMeta(meta);

  const ctx: BusChatContext = {
    busUrl: relay.url,
    channel,
    epoch,
    agents: ["a", "b"],
    firstSpeaker: "a",
    topic: meta.chat.topic,
  };
  const mk = (id: "a" | "b" | "orchestrator") =>
    new BusClient({ busUrl: relay.url, channel, token: tokens[id], secret });
  return { dir, relay, config, bb, meta, ctx, secret, tokens, clients: { a: mk("a"), b: mk("b"), orchestrator: mk("orchestrator") } };
}

async function waitFor(cond: () => boolean, what: string, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

const raws = (bb: Blackboard, id: string) =>
  bb.readEvents(id).filter((e) => e.type === "bus_raw");
const turns = (bb: Blackboard, id: string) =>
  bb.readEvents(id).filter((e) => e.type === "turn");

describe("bus crypto", () => {
  test("AEAD envelope round-trips and rejects tampering", () => {
    const secret = newChannelSecret();
    const env = encryptPayload(secret, "chat-1", "m-1", "hello bus");
    expect(decryptPayload(secret, "chat-1", "m-1", env)).toBe("hello bus");

    // bit flip in ciphertext -> auth failure
    const raw = Buffer.from(env.ct, "base64");
    raw[0] = raw[0] ^ 1;
    expect(() =>
      decryptPayload(secret, "chat-1", "m-1", { nonce: env.nonce, ct: raw.toString("base64") })
    ).toThrow(BusCryptoError);

    // wrong msg_id (AAD binding), wrong channel, wrong secret all reject
    expect(() => decryptPayload(secret, "chat-1", "m-2", env)).toThrow(BusCryptoError);
    expect(() => decryptPayload(secret, "chat-2", "m-1", env)).toThrow(BusCryptoError);
    expect(() => decryptPayload(newChannelSecret(), "chat-1", "m-1", env)).toThrow(BusCryptoError);
  });
});

describe("relay semantics", () => {
  test("POST msg_id dedupe: retry returns the original seq, single append", async () => {
    const f = await setupBus("t-dedupe");
    try {
      const ack1 = await f.clients.a.publish("m-dup-1", encodeTurn(null, "first"));
      const ack2 = await f.clients.a.publish("m-dup-1", encodeTurn(null, "first"));
      expect(ack1.seq).toBe(1);
      expect(ack2.seq).toBe(1);
      expect(ack2.deduped).toBe(true);
      expect(f.relay.channel(f.ctx.channel)!.messages).toHaveLength(1);
    } finally {
      f.relay.stop();
    }
  });

  test("auditor lease: one per channel, a second author is rejected", async () => {
    const f = await setupBus("t-lease");
    try {
      const lease = await f.clients.orchestrator.requestAuditorLease();
      expect(lease.auditor).toBe("orchestrator");
      await expect(f.clients.a.requestAuditorLease()).rejects.toThrow(/held by/);
      // same author re-request is idempotent (auditor restart)
      const again = await f.clients.orchestrator.requestAuditorLease();
      expect(again.auditor).toBe("orchestrator");
    } finally {
      f.relay.stop();
    }
  });
});

describe("bus auditor", () => {
  test("validation: dup ignored, spam burst raw-only, only accepted turns drive counts", async () => {
    const f = await setupBus("t-audit");
    const ctl = new AbortController();
    try {
      const done = runBusAuditor(f.bb, f.config, f.meta, f.clients.orchestrator, f.ctx, {
        idleTimeoutMs: 10_000,
        maxTurns: 2,
        pollWaitMs: 30,
        signal: ctl.signal,
      });
      // opening control committed before any turn is valid
      await waitFor(
        () => f.bb.readEvents(f.meta.id).some((e) => e.type === "chat_started"),
        "opening committed"
      );

      // a's opening turn accepted
      await f.clients.a.publish("a-turn-1", encodeTurn(null, "a opens"));
      await waitFor(() => turns(f.bb, f.meta.id).length === 1, "a turn accepted");
      const aSeq = turns(f.bb, f.meta.id)[0].bus!.seq;

      // duplicate: same author + same in_reply_to -> ignored
      await f.clients.a.publish("a-turn-1b", encodeTurn(null, "a dup"));
      // spam burst: a keeps posting while b is the expected speaker
      await f.clients.a.publish("a-spam-1", encodeTurn(aSeq, "spam one"));
      await f.clients.a.publish("a-spam-2", encodeTurn(aSeq, "spam two"));
      await f.clients.a.publish("a-spam-3", encodeTurn(99, "spam three"));
      // b answers a's accepted turn
      await f.clients.b.publish("b-turn-1", encodeTurn(aSeq, "b answers"));

      const summary = await done; // maxTurns=2 -> expired
      expect(summary.end_reason).toBe("expired");

      const evs = f.bb.readEvents(f.meta.id);
      // everything relayed is a raw record: 1 opening + 6 posts + 1 chat_ended
      expect(raws(f.bb, f.meta.id)).toHaveLength(8);
      // only a's opening + b's reply are accepted turns
      const t = turns(f.bb, f.meta.id);
      expect(t.map((x) => x.actor)).toEqual(["a", "b"]);
      expect(t[0].bus!.msg_id).toBe("a-turn-1");
      expect(t[0].bus!.in_reply_to).toBeNull();
      expect(t[1].bus!.in_reply_to).toBe(aSeq);
      expect(t.every((x) => typeof x.bus!.payload_hash === "string")).toBe(true);
      // spam + dup stayed raw-only; only accepted turns drove counts
      expect(f.bb.readMeta(f.meta.id).chat!.total_turns).toBe(2);
      const ended = evs.find((e) => e.type === "chat_ended")!;
      expect(ended.bus!.reason).toBe("expired");
    } finally {
      ctl.abort();
      f.relay.stop();
    }
  }, T);

  test("scripted two-participant run: opening names first speaker, strict alternation, no t=0 deadlock", async () => {
    const f = await setupBus("t-two");
    const ctl = new AbortController();
    const mkParticipant = (id: "a" | "b", peer: "a" | "b") =>
      new ParticipantRuntime({
        busUrl: f.relay.url,
        channel: f.ctx.channel,
        epoch: f.ctx.epoch,
        token: f.tokens[id],
        secret: f.secret,
        agentId: id,
        peerId: peer,
        stateDir: join(f.dir, `p-${id}`),
        pollWaitMs: 30,
        replyTimeoutMs: 2_000,
        onTurn: async (ctx) => ({
          body: `[${id}] turn answering ${ctx.peerTurn ? `seq ${ctx.peerTurn.seq}` : "the opening"}`,
          // b aborts once both sides have spoken twice -> auditor ends it
          signal: ctx.transcript.length >= 3 ? "abort" : "continue",
        }),
      });
    try {
      const auditorDone = runBusAuditor(
        f.bb, f.config, f.meta, f.clients.orchestrator, f.ctx,
        { idleTimeoutMs: 10_000, pollWaitMs: 30, signal: ctl.signal }
      );
      const pa = mkParticipant("a", "b");
      const pb = mkParticipant("b", "a");
      const [sa, sb, summary] = await Promise.all([
        pa.run(ctl.signal),
        pb.run(ctl.signal),
        auditorDone,
      ]);
      expect(summary.end_reason).toBe("aborted");
      const t = turns(f.bb, f.meta.id);
      // strict alternation seeded by the opening control; no deadlock at t=0.
      // turns that raced the close can also be accepted (they're pre-close in
      // the log), so assert the prefix and the whole chain's invariants.
      expect(t.length).toBeGreaterThanOrEqual(4);
      expect(t.slice(0, 4).map((x) => x.actor)).toEqual(["a", "b", "a", "b"]);
      expect(t[0].bus!.in_reply_to).toBeNull();
      for (let i = 1; i < t.length; i++) {
        expect(t[i].actor).not.toBe(t[i - 1].actor);
        expect(t[i].bus!.in_reply_to).toBe(t[i - 1].bus!.seq);
      }
      // both participants observed the auditor-imposed end
      expect(sa.ended).toBe("aborted");
      expect(sb.ended).toBe("aborted");
    } finally {
      ctl.abort();
      f.relay.stop();
    }
  }, T);

  test("idle timeout: auditor publishes chat_ended{idle_timeout}; post-close turns are raw-only", async () => {
    const f = await setupBus("t-idle");
    try {
      const s1 = await runBusAuditor(f.bb, f.config, f.meta, f.clients.orchestrator, f.ctx, {
        idleTimeoutMs: 150,
        pollWaitMs: 30,
      });
      expect(s1.end_reason).toBe("idle_timeout");
      const ended = f.bb.readEvents(f.meta.id).find((e) => e.type === "chat_ended")!;
      expect(ended.bus!.reason).toBe("idle_timeout");
      expect(ended.body).toContain("auditor-imposed");
      // the terminal control is on the relay with its deterministic msg_id
      const ch = f.relay.channel(f.ctx.channel)!;
      const ctrl = ch.messages.find((m) => m.msg_id === ended.bus!.msg_id)!;
      expect(ctrl.author).toBe("orchestrator");
      expect(ctrl.seq).toBe(ended.bus!.seq);

      // a post-close turn lands after the end: raw only, never accepted
      await f.clients.a.publish("a-late", encodeTurn(null, "too late"));
      const s2 = await runBusAuditor(f.bb, f.config, f.meta, f.clients.orchestrator, f.ctx, {
        idleTimeoutMs: 150,
        pollWaitMs: 30,
      });
      expect(s2.end_reason).toBe("idle_timeout");
      const evs = f.bb.readEvents(f.meta.id);
      expect(evs.filter((e) => e.type === "chat_ended")).toHaveLength(1);
      expect(turns(f.bb, f.meta.id)).toHaveLength(0);
      const lateRaw = raws(f.bb, f.meta.id).find((e) => e.bus!.msg_id === "a-late");
      expect(lateRaw).toBeDefined();
    } finally {
      f.relay.stop();
    }
  }, T);

  test("sender retry after simulated relay loss: same msg_id appends exactly once", async () => {
    const f = await setupBus("t-retry");
    const ctl = new AbortController();
    // first POST commits server-side but the response is "lost"
    let dropped = false;
    const flakyFetch: FetchFn = (async (url: any, init: any) => {
      const res = await fetch(url, init);
      if (!dropped && init?.method === "POST" && String(url).includes("/messages")) {
        dropped = true;
        throw new Error("simulated response loss");
      }
      return res;
    }) as FetchFn;
    try {
      // auditor publishes the opening control so a is expected to speak
      const ctlAud = runBusAuditor(
        f.bb, f.config, f.meta, f.clients.orchestrator, f.ctx,
        { idleTimeoutMs: 10_000, pollWaitMs: 30, signal: ctl.signal }
      );
      const pa = new ParticipantRuntime({
        busUrl: f.relay.url, channel: f.ctx.channel, epoch: f.ctx.epoch,
        token: f.tokens.a, secret: f.secret, agentId: "a", peerId: "b",
        stateDir: join(f.dir, "p-a"), pollWaitMs: 30, replyTimeoutMs: 60_000,
        fetchFn: flakyFetch,
        onTurn: async () => ({ body: "opening turn from a" }),
      });
      const running = pa.run(ctl.signal);
      // the outbox retries the same msg_id; relay dedupe -> single append
      await waitFor(() => turns(f.bb, f.meta.id).length === 1, "auditor accepts turn");
      // once the participant observes its own turn it stops waking for it and
      // the (transiently re-queued, deduped) outbox entry drains
      await waitFor(
        () => pa.transcript.some((t) => t.author === "a") && pa.outboxSize === 0,
        "own turn observed, outbox drained"
      );
      const msgs = f.relay.channel(f.ctx.channel)!.messages;
      expect(msgs.filter((m) => m.msg_id === "a@e-test1:re0")).toHaveLength(1);
      expect(dropped).toBe(true);
      ctl.abort();
      await running;
      await ctlAud;
    } finally {
      ctl.abort();
      f.relay.stop();
    }
  }, T);

  test("crash recovery: auditor restarts on derived cursor; participant replay collapses on seen-set", async () => {
    const f = await setupBus("t-crash");
    const ctl1 = new AbortController();
    try {
      // --- run 1: opening + a's turn committed, then "crash" (abort) ---
      const aud1 = runBusAuditor(
        f.bb, f.config, f.meta, f.clients.orchestrator, f.ctx,
        { idleTimeoutMs: 10_000, pollWaitMs: 30, signal: ctl1.signal }
      );
      await waitFor(
        () => f.bb.readEvents(f.meta.id).some((e) => e.type === "chat_started"),
        "opening committed"
      );
      await f.clients.a.publish("a@e-test1:re0", encodeTurn(null, "a turn one"));
      await waitFor(() => turns(f.bb, f.meta.id).length === 1, "a turn committed");
      const aSeq = turns(f.bb, f.meta.id)[0].bus!.seq;
      ctl1.abort();
      await aud1;
      const rawsBefore = raws(f.bb, f.meta.id).length;

      // --- auditor restart: cursor = max committed seq; no dupes, no misses ---
      const ctl2 = new AbortController();
      const aud2 = runBusAuditor(
        f.bb, f.config, f.meta, f.clients.orchestrator, f.ctx,
        { idleTimeoutMs: 10_000, pollWaitMs: 30, signal: ctl2.signal }
      );
      await f.clients.b.publish("b@e-test1:re2", encodeTurn(aSeq, "b replies"));
      await waitFor(() => turns(f.bb, f.meta.id).length === 2, "b turn committed");
      ctl2.abort();
      await aud2;

      const ch = f.relay.channel(f.ctx.channel)!;
      const all = raws(f.bb, f.meta.id);
      // every relayed msg has exactly one raw record; nothing missed
      expect(all).toHaveLength(ch.messages.length);
      expect(new Set(all.map((e) => e.bus!.seq)).size).toBe(all.length);
      expect(turns(f.bb, f.meta.id).map((t) => t.actor)).toEqual(["a", "b"]);
      expect(rawsBefore).toBeLessThan(all.length);

      // --- participant replay: cursor rewound, seen-set collapses dups ---
      const stateDir = join(f.dir, "p-b");
      let calls = 0;
      const pb1 = new ParticipantRuntime({
        busUrl: f.relay.url, channel: f.ctx.channel, epoch: f.ctx.epoch,
        token: f.tokens.b, secret: f.secret, agentId: "b", peerId: "a",
        stateDir, pollWaitMs: 30, replyTimeoutMs: 60_000,
        onTurn: async () => { calls++; return { body: "b says" }; },
      });
      const ctlB = new AbortController();
      const runB = pb1.run(ctlB.signal);
      await waitFor(() => pb1.cursor >= ch.messages.length, "participant catches up");
      ctlB.abort();
      await runB;
      expect(calls).toBe(0); // b's turn was already published; a's turn was answered

      // rewind the durable cursor: replay collapses on the seen-msg_id set
      const statePath = join(stateDir, "bus-participant.json");
      const st = JSON.parse(readFileSync(statePath, "utf8"));
      st.cursor = 0;
      writeFileSync(statePath, JSON.stringify(st));
      const pb2 = new ParticipantRuntime({
        busUrl: f.relay.url, channel: f.ctx.channel, epoch: f.ctx.epoch,
        token: f.tokens.b, secret: f.secret, agentId: "b", peerId: "a",
        stateDir, pollWaitMs: 30, replyTimeoutMs: 60_000,
        onTurn: async () => { calls++; return { body: "b says" }; },
      });
      const ctlB2 = new AbortController();
      const runB2 = pb2.run(ctlB2.signal);
      await waitFor(() => pb2.cursor >= ch.messages.length, "replay catches up");
      ctlB2.abort();
      await runB2;
      expect(calls).toBe(0); // replay produced no duplicate effects
      // and nothing new was appended under b's authorship
      expect(ch.messages.filter((m) => m.author === "b")).toHaveLength(1);
    } finally {
      ctl1.abort();
      f.relay.stop();
    }
  }, T);

  test("control redelivery: restart re-publishes committed chat_ended with a single effect", async () => {
    const f = await setupBus("t-redeliver");
    try {
      const s1 = await runBusAuditor(f.bb, f.config, f.meta, f.clients.orchestrator, f.ctx, {
        idleTimeoutMs: 120,
        pollWaitMs: 30,
      });
      expect(s1.end_reason).toBe("idle_timeout");
      const msgId = endedMsgId(f.ctx.epoch, 0, "idle_timeout");

      // auditor restart: committed terminal control is re-published; relay
      // dedupe collapses it — exactly one copy on the log, one committed event
      const s2 = await runBusAuditor(f.bb, f.config, f.meta, f.clients.orchestrator, f.ctx, {
        idleTimeoutMs: 120,
        pollWaitMs: 30,
      });
      expect(s2.end_reason).toBe("idle_timeout");
      const msgs = f.relay.channel(f.ctx.channel)!.messages;
      expect(msgs.filter((m) => m.msg_id === msgId)).toHaveLength(1);
      const evs = f.bb.readEvents(f.meta.id);
      expect(evs.filter((e) => e.type === "chat_ended")).toHaveLength(1);
    } finally {
      f.relay.stop();
    }
  }, T);
});

describe("bus client resilience", () => {
  test("null response body degrades to BusError, not TypeError", async () => {
    // Regression: a proxy/dropped connection can hand poll() a non-OK
    // response whose body parses as JSON null. readBody must normalize it
    // to {} so the rejection path reads body.error safely.
    const nullBodyFetch = (async () =>
      new Response("null", { status: 502, headers: { "content-type": "application/json" } })
    ) as FetchFn;
    const client = new BusClient({
      busUrl: "https://relay.invalid", channel: "chat-x",
      token: "t", secret: "00".repeat(32), fetchFn: nullBodyFetch,
    });
    const err = await client.poll(0, 10).then(
      () => null,
      (e) => e
    );
    expect(err).toBeInstanceOf(BusError);
    expect((err as BusError).message).toMatch(/poll rejected: 502/);
  });
});

describe("bus config", () => {
  test("kind=bus validates bus_url + token_env and rejects [agents.command]", async () => {
    const base = {
      schema_version: 1,
      team: "t",
      roles: [{ name: "critic", instructions: "x" }],
    };
    const ok = validateConfig(
      {
        ...base,
        agents: [
          { id: "g", kind: "bus", role: "critic", bus_url: "https://relay.example.com", token_env: "TEAM_BUS_TOKEN_G" },
        ],
      },
      "/tmp/team.toml"
    );
    expect(ok.agents[0].kind).toBe("bus");
    expect(ok.agents[0].channel).toBeUndefined();

    expect(() =>
      validateConfig(
        { ...base, agents: [{ id: "g", kind: "bus", role: "critic", token_env: "X" }] },
        "/tmp/team.toml"
      )
    ).toThrow(/bus_url/);
    expect(() =>
      validateConfig(
        { ...base, agents: [{ id: "g", kind: "bus", role: "critic", bus_url: "https://x" }] },
        "/tmp/team.toml"
      )
    ).toThrow(/token_env/);
    expect(() =>
      validateConfig(
        {
          ...base,
          agents: [
            {
              id: "g", kind: "bus", role: "critic",
              bus_url: "https://x", token_env: "X",
              command: { executable: "true", args: [], stdin: "null" },
            },
          ],
        },
        "/tmp/team.toml"
      )
    ).toThrow(/must not have \[agents\.command\]/);
  });
});
