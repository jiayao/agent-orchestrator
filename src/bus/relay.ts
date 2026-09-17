// Message bus relay (v0.2): `team bus-serve`. A minimal HTTPS-capable relay —
// this local build serves plain HTTP for dev. The relay is the operator's own
// infrastructure (reference deployment: Fly), trusted the way any server you
// run is trusted: the threat model is crash-faults and network observers, not
// a Byzantine relay. Bodies are AEAD ciphertext under the channel secret; the
// relay sees sizes, timing, and IPs — stated plainly, not "learns nothing".
//
// One deliberate widening: one-time claim URLs (see below) let a remote
// participant fetch its bearer token + the channel secret without the
// operator pasting long-lived secrets into a chat transcript. While a claim
// is outstanding the relay holds that participant's channel secret in
// memory — bounded by the claim TTL (default 1h) and deleted on redemption
// or expiry. The relay never sees message plaintext; claims only move the
// secret the participant was going to receive anyway.
//
// Load-bearing semantics (all tested):
// - msg_id dedupe: a POST with a previously seen msg_id returns the original
//   {seq} without appending — retries are always safe.
// - One linearizable log per channel: a single relay instance owns a channel;
//   seq is assigned at commit; a committed seq never disappears or backfills.
// - Auditor lease: one auditor lease per channel; a second author is rejected.
// - Authorship: one bearer token per participant, minted at provisioning;
//   `author` is attested as observed on the authenticated POST.
//
// State: by default everything is in-memory (dev mode) — a relay crash loses
// channels, tokens, dedupe state and the log, and restart = a fresh channel
// provisioning. With `team bus-serve --data-dir <dir>` the recoverable state
// is durable (see store.ts): channels, SHA-256 token hashes, and the
// per-channel message log reload on boot, so a restart looks like a
// transient disconnect — participants resume from their cursor against the
// intact log. Still deliberately transient: unredeemed claims die on
// restart, long-poll waiters are dropped, and the auditor lease always
// boots unheld so a fresh auditor can acquire (a stale auditor process
// elsewhere is an operator error, same as today).

import { createHash, randomBytes } from "node:crypto";
import { RelayStore } from "./store.ts";

const CHANNEL_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_POST_BYTES = 64 * 1024;
const MAX_WAIT_MS = 30_000;

export interface RelayStoredMessage {
  seq: number;
  msg_id: string;
  author: string;
  ts: string;
  nonce: string;
  ct: string;
}

export interface RelayClaim {
  id: string;
  participant: string;
  /** the seat this claim populates. Equal to `participant` today, but kept
   *  separate so a claim can address a seat independently of the redeemer's
   *  id — the addressing model seats exist to enable. */
  seat_id?: string;
  token: string;
  /** channel secret, hex — held only until redemption or expiry */
  secret: string;
  epoch: string;
  /** Date.now() ms after which the claim is dead */
  expiresAt: number;
}

export interface RelayChannel {
  id: string;
  epoch: string;
  created_at: string;
  /** sha256(token) hex -> author — raw tokens are never persisted */
  tokens: Map<string, string>;
  /** author -> raw token, in-memory only: populated at provisioning so a
   *  claim mint can hand the participant its token; empty after a restart
   *  (the mint endpoint then requires "token" in the request body) */
  rawTokens: Map<string, string>;
  /** author holding the auditor lease, or null — never persisted as held */
  auditor: string | null;
  messages: RelayStoredMessage[];
  msgIndex: Map<string, RelayStoredMessage>;
  waiters: Set<() => void>;
  /** one-time onboarding claims, id -> claim; burned on redeem, pruned on
   *  expiry, never persisted — unredeemed claims die on restart */
  claims: Map<string, RelayClaim>;
  /** seat_id -> seat record. A seat is the stable, addressable slot; a
   *  revoke vacates it (state "vacant") instead of erasing it, so the
   *  seat_id survives and a later join can reclaim it. */
  seats: Map<string, RelaySeat>;
}

export interface RelaySeat {
  seat_id: string;
  /** presentation-only label; belongs to the seat record, not the token */
  display_name?: string;
  role?: string;
  state: "claimed" | "vacant";
}

export interface RelayHandle {
  port: number;
  url: string;
  adminToken: string;
  stop(): void;
  /** test introspection */
  channel(id: string): RelayChannel | undefined;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function bearer(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/.exec(h);
  return m ? m[1].trim() : null;
}

/** Full SHA-256 of a bearer token — the durable identity of a credential. */
function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function startRelay(opts: {
  port?: number;
  adminToken: string;
  /** directory for the durable SQLite store; absent = in-memory (dev) */
  dataDir?: string;
}): RelayHandle {
  const channels = new Map<string, RelayChannel>();
  const adminToken = opts.adminToken;
  const store = opts.dataDir ? new RelayStore(opts.dataDir) : null;

  // Durable boot: rebuild every channel from the store. Transient state is
  // reconstructed empty — no lease holder (a fresh auditor acquires), no
  // claims, no waiters, no raw tokens.
  for (const p of store?.loadChannels() ?? []) {
    const ch: RelayChannel = {
      id: p.id,
      epoch: p.epoch,
      created_at: p.created_at,
      tokens: p.tokens,
      rawTokens: new Map(),
      auditor: null,
      messages: p.messages,
      msgIndex: new Map(p.messages.map((m) => [m.msg_id, m])),
      waiters: new Set(),
      claims: new Map(),
      seats: new Map(p.seats),
    };
    channels.set(ch.id, ch);
  }

  const isAdmin = (req: Request) => bearer(req) === adminToken;

  const authAuthor = (req: Request, ch: RelayChannel): string | null => {
    const tok = bearer(req);
    if (!tok) return null;
    return ch.tokens.get(tokenHash(tok)) ?? null;
  };

  const append = (ch: RelayChannel, msg_id: string, author: string, nonce: string, ct: string) => {
    const msg: RelayStoredMessage = {
      seq: ch.messages.length + 1,
      msg_id,
      author,
      ts: new Date().toISOString(),
      nonce,
      ct,
    };
    // commit to the store first: a failed write must not produce a seq the
    // log claims is committed — the client retries and lands a clean append
    store?.appendMessage(ch.id, msg);
    ch.messages.push(msg);
    ch.msgIndex.set(msg_id, msg);
    for (const w of ch.waiters) w();
    ch.waiters.clear();
    return msg;
  };

  const server = Bun.serve({
    port: opts.port ?? 0,
    // Long-poll requests block up to MAX_WAIT_MS (30s) by design. Bun's
    // default idle timeout is 10s, which would kill every poll longer than
    // that mid-flight (the client sees a 502, not a timeout). Keep this
    // comfortably above MAX_WAIT_MS.
    idleTimeout: 60,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;

      if (path === "/healthz") return json({ ok: true });

      // ---- admin API ----
      if (path === "/admin/channels" && method === "POST") {
        if (!isAdmin(req)) return json({ error: "unauthorized" }, 401);
        let body: Record<string, unknown>;
        try {
          body = (await req.json()) as Record<string, unknown>;
        } catch {
          return json({ error: "invalid JSON body" }, 400);
        }
        const channel = typeof body.channel === "string" ? body.channel : "";
        if (!CHANNEL_RE.test(channel)) return json({ error: "invalid channel id" }, 400);
        if (channels.has(channel)) return json({ error: "channel exists" }, 409);
        const tokensRaw = body.tokens;
        if (tokensRaw === null || typeof tokensRaw !== "object" || Array.isArray(tokensRaw)) {
          return json({ error: "tokens must be an object {author: token}" }, 400);
        }
        const tokens = new Map<string, string>();
        const rawTokens = new Map<string, string>();
        for (const [author, tok] of Object.entries(tokensRaw as Record<string, unknown>)) {
          if (typeof tok !== "string" || !tok) {
            return json({ error: `token for ${author} must be a non-empty string` }, 400);
          }
          const hash = tokenHash(tok);
          if (tokens.has(hash)) return json({ error: `duplicate token value` }, 400);
          tokens.set(hash, author);
          rawTokens.set(author, tok);
        }
        if (![...tokens.values()].includes("orchestrator")) {
          return json({ error: "tokens must include an \"orchestrator\" author" }, 400);
        }
        const epoch = typeof body.epoch === "string" && body.epoch ? body.epoch : "e0";
        const createdAt = new Date().toISOString();
        // Optional seat list. Absent = derive one seat per participant from
        // the tokens (minus the reserved orchestrator), which keeps every
        // pre-seat caller working unchanged.
        const seats = new Map<string, RelaySeat>();
        const seatsRaw = body.seats;
        if (seatsRaw !== undefined) {
          if (!Array.isArray(seatsRaw)) return json({ error: "seats must be an array" }, 400);
          for (const entry of seatsRaw) {
            if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
              return json({ error: "each seat must be an object" }, 400);
            }
            const s = entry as Record<string, unknown>;
            const seatId = typeof s.seat_id === "string" ? s.seat_id : "";
            if (!seatId) return json({ error: "each seat needs a seat_id" }, 400);
            if (seats.has(seatId)) return json({ error: `duplicate seat ${seatId}` }, 400);
            seats.set(seatId, {
              seat_id: seatId,
              ...(typeof s.display_name === "string" && s.display_name
                ? { display_name: s.display_name }
                : {}),
              ...(typeof s.role === "string" && s.role ? { role: s.role } : {}),
              state: "claimed",
            });
          }
          // every seat must be backed by a token, or it is neither reachable
          // nor mintable — catch the mismatch at provision, not at join
          for (const seatId of seats.keys()) {
            if (!rawTokens.has(seatId)) {
              return json({ error: `seat ${seatId} has no token` }, 400);
            }
          }
        } else {
          for (const author of tokens.values()) {
            if (author === "orchestrator") continue;
            seats.set(author, { seat_id: author, state: "claimed" });
          }
        }
        // durable commit before the channel goes live — a failed write must
        // not produce a channel the relay will lose on restart
        store?.createChannel(channel, epoch, createdAt, tokens, [...seats.values()]);
        channels.set(channel, {
          id: channel,
          epoch,
          created_at: createdAt,
          tokens,
          rawTokens,
          auditor: null,
          messages: [],
          msgIndex: new Map(),
          waiters: new Set(),
          claims: new Map(),
          seats,
        });
        return json({ ok: true, channel, epoch }, 201);
      }

      const adminTokMatch = /^\/admin\/channels\/([A-Za-z0-9_-]{1,128})\/tokens\/(.+)$/.exec(path);
      if (adminTokMatch && method === "DELETE") {
        if (!isAdmin(req)) return json({ error: "unauthorized" }, 401);
        const ch = channels.get(adminTokMatch[1]);
        if (!ch) return json({ error: "no such channel" }, 404);
        const author = decodeURIComponent(adminTokMatch[2]);
        if (![...ch.tokens.values()].includes(author)) {
          return json({ error: "no such author" }, 404);
        }
        store?.deleteAuthorTokens(ch.id, author);
        for (const [hash, a] of ch.tokens) {
          if (a === author) ch.tokens.delete(hash);
        }
        ch.rawTokens.delete(author);
        if (ch.auditor === author) ch.auditor = null;
        return json({ ok: true, revoked: author });
      }

      // ---- one-time onboarding claims ----
      // Minting is admin-only and carries the channel secret (the relay
      // otherwise never holds it). Redemption is unauthenticated: the
      // unguessable claim id is the credential, single-use, TTL-bounded.
      // The operator pastes only the claim URL into chat with the remote
      // participant — never the long-lived token or channel secret.
      // Claims are in-memory only: an unredeemed claim dies on restart.
      // Minting needs the participant's raw token — after a restart it must
      // come in the request body ("token"), since only hashes persist.
      const claimMintMatch = /^\/admin\/channels\/([A-Za-z0-9_-]{1,128})\/claims$/.exec(path);
      if (claimMintMatch && method === "POST") {
        if (!isAdmin(req)) return json({ error: "unauthorized" }, 401);
        const ch = channels.get(claimMintMatch[1]);
        if (!ch) return json({ error: "no such channel" }, 404);
        let body: Record<string, unknown>;
        try {
          body = (await req.json()) as Record<string, unknown>;
        } catch {
          return json({ error: "invalid JSON body" }, 400);
        }
        const participant = typeof body.participant === "string" ? body.participant : "";
        const secret = typeof body.channel_secret === "string" ? body.channel_secret : "";
        // The claim hands the participant its raw bearer token — but the
        // durable store keeps only token hashes, so after a restart the raw
        // token must travel with the mint request ("token" field; the
        // provisioner knows it). Same-process mints fall back to the
        // provisioning-time in-memory copy. Either way the token's hash must
        // check out against the channel's registered hashes.
        const presented = typeof body.token === "string" && body.token ? body.token : null;
        const token = presented ?? ch.rawTokens.get(participant) ?? null;
        if (!token) {
          if (![...ch.tokens.values()].includes(participant)) {
            return json({ error: "no such participant" }, 400);
          }
          return json(
            {
              error:
                "participant token unavailable — raw tokens are not persisted; " +
                'resubmit with the participant\'s "token" in the request body',
            },
            400
          );
        }
        if (ch.tokens.get(tokenHash(token)) !== participant) {
          return json({ error: "token does not match participant" }, 400);
        }
        if (!secret) return json({ error: "channel_secret is required" }, 400);
        const ttlMs = Math.min(
          24 * 3_600_000,
          Math.max(60_000, typeof body.ttl_ms === "number" && body.ttl_ms > 0 ? body.ttl_ms : 3_600_000)
        );
        const id = randomBytes(24).toString("hex");
        const claim: RelayClaim = {
          id,
          participant,
          seat_id: participant,
          token,
          secret,
          epoch: ch.epoch,
          expiresAt: Date.now() + ttlMs,
        };
        ch.claims.set(id, claim);
        return json(
          { ok: true, claim_id: id, expires_at: new Date(claim.expiresAt).toISOString() },
          201
        );
      }

      // ---- channel API ----
      const msgMatch = /^\/c\/([A-Za-z0-9_-]{1,128})\/messages$/.exec(path);
      if (msgMatch) {
        const ch = channels.get(msgMatch[1]);
        if (!ch) return json({ error: "no such channel" }, 404);
        const author = isAdmin(req) ? "operator" : authAuthor(req, ch);
        if (!author) return json({ error: "unauthorized" }, 401);

        if (method === "POST") {
          const len = Number(req.headers.get("content-length") ?? 0);
          if (len > MAX_POST_BYTES) return json({ error: "message too large" }, 413);
          let body: Record<string, unknown>;
          try {
            const text = await req.text();
            if (text.length > MAX_POST_BYTES) return json({ error: "message too large" }, 413);
            body = JSON.parse(text) as Record<string, unknown>;
          } catch {
            return json({ error: "invalid JSON body" }, 400);
          }
          const msg_id = body.msg_id;
          const nonce = body.nonce;
          const ct = body.ct;
          if (typeof msg_id !== "string" || !msg_id || msg_id.length > 256) {
            return json({ error: "msg_id must be a non-empty string" }, 400);
          }
          if (typeof nonce !== "string" || typeof ct !== "string") {
            return json({ error: "nonce and ct must be base64 strings" }, 400);
          }
          // msg_id dedupe: retry of a committed message returns the original seq.
          const prior = ch.msgIndex.get(msg_id);
          if (prior) {
            return json({ seq: prior.seq, msg_id, author: prior.author, deduped: true });
          }
          // seq assigned at commit; the check+append above is synchronous.
          const msg = append(ch, msg_id, author, nonce, ct);
          return json({ seq: msg.seq, msg_id, author, deduped: false }, 201);
        }

        if (method === "GET") {
          const since = Math.max(0, Number(url.searchParams.get("since") ?? 0) || 0);
          const waitMs = Math.min(
            MAX_WAIT_MS,
            Math.max(0, Number(url.searchParams.get("wait") ?? "25000") || 0)
          );
          const deadline = Date.now() + waitMs;
          let msgs = ch.messages.filter((m) => m.seq > since);
          while (!msgs.length && Date.now() < deadline) {
            await new Promise<void>((res) => {
              const t = setTimeout(res, Math.max(1, Math.min(200, deadline - Date.now())));
              const w = () => {
                clearTimeout(t);
                res();
              };
              ch.waiters.add(w);
            });
            msgs = ch.messages.filter((m) => m.seq > since);
          }
          return json({ messages: msgs, latest: ch.messages.length });
        }

        return json({ error: "method not allowed" }, 405);
      }

      const leaseMatch = /^\/c\/([A-Za-z0-9_-]{1,128})\/auditor$/.exec(path);
      if (leaseMatch && method === "POST") {
        const ch = channels.get(leaseMatch[1]);
        if (!ch) return json({ error: "no such channel" }, 404);
        const author = isAdmin(req) ? "operator" : authAuthor(req, ch);
        if (!author) return json({ error: "unauthorized" }, 401);
        // one auditor lease per channel; re-request by the same author is
        // idempotent so an auditor restart can re-acquire its own lease.
        if (ch.auditor === null || ch.auditor === author) {
          ch.auditor = author;
          return json({ ok: true, channel: ch.id, auditor: author });
        }
        return json({ error: `auditor lease held by ${ch.auditor}` }, 409);
      }

      // Claim redemption: unauthenticated, single-use. Burn the claim before
      // responding so a concurrent double-fetch cannot both succeed.
      // The response also attests the channel's participant list — the
      // redeemer learns its peer id from provisioning instead of inferring
      // it from the first peer turn (participants = token authors minus the
      // reserved "orchestrator" auditor author).
      const claimMatch = /^\/c\/([A-Za-z0-9_-]{1,128})\/claim\/([A-Za-z0-9_-]{1,128})$/.exec(path);
      if (claimMatch && method === "GET") {
        const ch = channels.get(claimMatch[1]);
        if (!ch) return json({ error: "no such channel" }, 404);
        const claim = ch.claims.get(claimMatch[2]);
        if (!claim) return json({ error: "no such claim" }, 404);
        ch.claims.delete(claim.id);
        if (Date.now() >= claim.expiresAt) {
          return json({ error: "claim expired" }, 410);
        }
        const participants = [...ch.tokens.values()].filter((a) => a !== "orchestrator");
        console.log(
          `[relay] claim redeemed channel=${ch.id} participant=${claim.participant} ` +
            `token_fp=${tokenFingerprint(claim.token)}`
        );
        return json({
          participant: claim.participant,
          participants,
          peers: participants.filter((a) => a !== claim.participant),
          token: claim.token,
          channel_secret: claim.secret,
          channel: ch.id,
          epoch: claim.epoch,
          // seat binding: which stable slot this claim populated, so the
          // redeemer addresses the seat, not a one-off participant name
          seat_id: claim.seat_id ?? claim.participant,
          seat_state: "claimed",
        });
      }

      return json({ error: "not found" }, 404);
    },
  });

  const port = server.port ?? opts.port ?? 0;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    adminToken,
    stop: () => {
      server.stop(true);
      store?.close();
    },
    channel: (id) => channels.get(id),
  };
}

/** Stable fingerprint of a token for logs — never log raw tokens. */
export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}
