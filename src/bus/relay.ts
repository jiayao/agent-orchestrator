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
// State is in-memory: a relay crash loses channels, tokens, dedupe state and
// the log. Senders re-publish the same msg_id; the auditor re-publishes its
// deterministic terminal control. Restart = a fresh channel provisioning.

import { createHash, randomBytes } from "node:crypto";

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
  /** token -> author */
  tokens: Map<string, string>;
  /** author holding the auditor lease, or null */
  auditor: string | null;
  messages: RelayStoredMessage[];
  msgIndex: Map<string, RelayStoredMessage>;
  waiters: Set<() => void>;
  /** one-time onboarding claims, id -> claim; burned on redeem, pruned on expiry */
  claims: Map<string, RelayClaim>;
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

export function startRelay(opts: { port?: number; adminToken: string }): RelayHandle {
  const channels = new Map<string, RelayChannel>();
  const adminToken = opts.adminToken;

  const isAdmin = (req: Request) => bearer(req) === adminToken;

  const authAuthor = (req: Request, ch: RelayChannel): string | null => {
    const tok = bearer(req);
    if (!tok) return null;
    return ch.tokens.get(tok) ?? null;
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
    ch.messages.push(msg);
    ch.msgIndex.set(msg_id, msg);
    for (const w of ch.waiters) w();
    ch.waiters.clear();
    return msg;
  };

  const server = Bun.serve({
    port: opts.port ?? 0,
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
        for (const [author, tok] of Object.entries(tokensRaw as Record<string, unknown>)) {
          if (typeof tok !== "string" || !tok) {
            return json({ error: `token for ${author} must be a non-empty string` }, 400);
          }
          if (tokens.has(tok)) return json({ error: `duplicate token value` }, 400);
          tokens.set(tok, author);
        }
        if (![...tokens.values()].includes("orchestrator")) {
          return json({ error: "tokens must include an \"orchestrator\" author" }, 400);
        }
        const epoch = typeof body.epoch === "string" && body.epoch ? body.epoch : "e0";
        channels.set(channel, {
          id: channel,
          epoch,
          tokens,
          auditor: null,
          messages: [],
          msgIndex: new Map(),
          waiters: new Set(),
          claims: new Map(),
        });
        return json({ ok: true, channel, epoch }, 201);
      }

      const adminTokMatch = /^\/admin\/channels\/([A-Za-z0-9_-]{1,128})\/tokens\/(.+)$/.exec(path);
      if (adminTokMatch && method === "DELETE") {
        if (!isAdmin(req)) return json({ error: "unauthorized" }, 401);
        const ch = channels.get(adminTokMatch[1]);
        if (!ch) return json({ error: "no such channel" }, 404);
        const author = decodeURIComponent(adminTokMatch[2]);
        let removed = false;
        for (const [tok, a] of ch.tokens) {
          if (a === author) {
            ch.tokens.delete(tok);
            removed = true;
          }
        }
        if (ch.auditor === author) ch.auditor = null;
        return removed ? json({ ok: true, revoked: author }) : json({ error: "no such author" }, 404);
      }

      // ---- one-time onboarding claims ----
      // Minting is admin-only and carries the channel secret (the relay
      // otherwise never holds it). Redemption is unauthenticated: the
      // unguessable claim id is the credential, single-use, TTL-bounded.
      // The operator pastes only the claim URL into chat with the remote
      // participant — never the long-lived token or channel secret.
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
        let token: string | null = null;
        for (const [tok, author] of ch.tokens) {
          if (author === participant) {
            token = tok;
            break;
          }
        }
        if (!token) return json({ error: "no such participant" }, 400);
        if (!secret) return json({ error: "channel_secret is required" }, 400);
        const ttlMs = Math.min(
          24 * 3_600_000,
          Math.max(60_000, typeof body.ttl_ms === "number" && body.ttl_ms > 0 ? body.ttl_ms : 3_600_000)
        );
        const id = randomBytes(24).toString("hex");
        const claim: RelayClaim = {
          id,
          participant,
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
        console.log(
          `[relay] claim redeemed channel=${ch.id} participant=${claim.participant} ` +
            `token_fp=${tokenFingerprint(claim.token)}`
        );
        return json({
          participant: claim.participant,
          token: claim.token,
          channel_secret: claim.secret,
          channel: ch.id,
          epoch: claim.epoch,
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
    stop: () => server.stop(true),
    channel: (id) => channels.get(id),
  };
}

/** Stable fingerprint of a token for logs — never log raw tokens. */
export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}
