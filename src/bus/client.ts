// Bus client (v0.2): the wire protocol for participants and the auditor.
// Publish encrypts under the channel secret before POSTing — the relay only
// ever sees {msg_id, nonce, ct}. Retries are caller-owned (the participant
// outbox / the auditor's terminal re-publish); a stable msg_id plus relay
// dedupe means a retry is either a no-op (it landed) or the actual publish.

import type { RelayMessage } from "./protocol.ts";
import { decryptPayload, encryptPayload } from "./crypto.ts";

export class BusError extends Error {
  status: number;
  constructor(msg: string, status = 0) {
    super(msg);
    this.name = "BusError";
    this.status = status;
  }
}

export type FetchFn = typeof fetch;

/**
 * Parse a JSON response body defensively. res.json() can *resolve* to null
 * (a proxy or a dropped connection can hand us an empty/null body with a
 * non-OK status) — the catch above only covers rejections. Normalize
 * anything that isn't an object to {} so `body.error` never throws.
 */
async function readBody(res: Response): Promise<Record<string, unknown>> {
  const parsed: unknown = await res.json().catch(() => ({}));
  return typeof parsed === "object" && parsed !== null
    ? (parsed as Record<string, unknown>)
    : {};
}

export interface PublishAck {
  seq: number;
  msg_id: string;
  author: string;
  /** true when the relay already had this msg_id — no duplicate append */
  deduped: boolean;
}

export class BusClient {
  readonly busUrl: string;
  readonly channel: string;
  readonly token: string;
  readonly secret: string;
  private fetchFn: FetchFn;

  constructor(opts: {
    busUrl: string;
    channel: string;
    token: string;
    secret: string;
    fetchFn?: FetchFn;
  }) {
    this.busUrl = opts.busUrl.replace(/\/+$/, "");
    this.channel = opts.channel;
    this.token = opts.token;
    this.secret = opts.secret;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  private url(p: string): string {
    return `${this.busUrl}/c/${encodeURIComponent(this.channel)}${p}`;
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, "content-type": "application/json" };
  }

  /** Encrypt + POST one payload. Single attempt — callers own retry. */
  async publish(msgId: string, plaintext: string): Promise<PublishAck> {
    const env = encryptPayload(this.secret, this.channel, msgId, plaintext);
    let res: Response;
    try {
      res = await this.fetchFn(this.url("/messages"), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ msg_id: msgId, nonce: env.nonce, ct: env.ct }),
      });
    } catch (e) {
      throw new BusError(`publish failed: ${(e as Error).message}`);
    }
    const body = await readBody(res);
    if (!res.ok) throw new BusError(`publish rejected: ${body.error ?? res.status}`, res.status);
    return {
      seq: body.seq as number,
      msg_id: msgId,
      author: body.author as string,
      deduped: body.deduped === true,
    };
  }

  /** Long-poll for messages with seq > since. */
  async poll(
    since: number,
    waitMs: number
  ): Promise<{ messages: RelayMessage[]; latest: number }> {
    let res: Response;
    try {
      res = await this.fetchFn(
        this.url(`/messages?since=${since}&wait=${Math.max(0, Math.floor(waitMs))}`),
        { headers: this.headers() }
      );
    } catch (e) {
      throw new BusError(`poll failed: ${(e as Error).message}`);
    }
    const body = await readBody(res);
    if (!res.ok) throw new BusError(`poll rejected: ${body.error ?? res.status}`, res.status);
    return {
      messages: (body.messages ?? []) as RelayMessage[],
      latest: (body.latest as number) ?? since,
    };
  }

  /** Decrypt one relayed message under the channel secret. Throws on tamper. */
  decrypt(msg: RelayMessage): string {
    return decryptPayload(this.secret, this.channel, msg.msg_id, { nonce: msg.nonce, ct: msg.ct });
  }

  /** Decrypt persisted wire fields — used to re-validate committed records. */
  decryptFields(msgId: string, nonce: string, ct: string): string {
    return decryptPayload(this.secret, this.channel, msgId, { nonce, ct });
  }

  /** One auditor lease per channel; a second author is rejected (409). */
  async requestAuditorLease(): Promise<{ auditor: string }> {
    let res: Response;
    try {
      res = await this.fetchFn(this.url("/auditor"), {
        method: "POST",
        headers: this.headers(),
      });
    } catch (e) {
      throw new BusError(`lease request failed: ${(e as Error).message}`);
    }
    const body = await readBody(res);
    if (!res.ok) throw new BusError(`lease rejected: ${body.error ?? res.status}`, res.status);
    return { auditor: body.auditor as string };
  }
}

/** One declared seat: the stable, addressable slot a participant claims. */
export interface SeatSpec {
  seat_id: string;
  display_name?: string;
  role?: string;
}

/** Operator admin calls — the provisioning channel is `team chat` itself. */
export async function adminProvisionChannel(
  busUrl: string,
  adminToken: string,
  opts: {
    channel: string;
    epoch: string;
    tokens: Record<string, string>;
    /** optional seat list; the relay derives one seat per token when absent */
    seats?: SeatSpec[];
  }
): Promise<void> {
  const res = await fetch(`${busUrl.replace(/\/+$/, "")}/admin/channels`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      channel: opts.channel,
      epoch: opts.epoch,
      tokens: opts.tokens,
      ...(opts.seats !== undefined ? { seats: opts.seats } : {}),
    }),
  });
  const body = await readBody(res);
  if (!res.ok) throw new BusError(`provisioning rejected: ${body.error ?? res.status}`, res.status);
}

export async function adminRevokeToken(
  busUrl: string,
  adminToken: string,
  channel: string,
  author: string
): Promise<void> {
  const res = await fetch(
    `${busUrl.replace(/\/+$/, "")}/admin/channels/${encodeURIComponent(channel)}/tokens/${encodeURIComponent(author)}`,
    { method: "DELETE", headers: { authorization: `Bearer ${adminToken}` } }
  );
  const body = await readBody(res);
  if (!res.ok) throw new BusError(`revoke rejected: ${body.error ?? res.status}`, res.status);
}

export interface MintedClaim {
  claim_id: string;
  expires_at: string;
}

/**
 * Mint a one-time onboarding claim for a participant (admin-only). The
 * channel secret travels with the mint request — the relay otherwise never
 * holds it — and is handed to the participant exactly once on redemption.
 * `token` is the participant's raw bearer token: the relay persists only
 * token hashes, so a claim minted after a relay restart must carry it
 * (same-process mints fall back to the relay's provisioning-time copy;
 * the provisioner always knows the tokens and should pass this).
 */
export async function adminMintClaim(
  busUrl: string,
  adminToken: string,
  channel: string,
  participant: string,
  channelSecret: string,
  ttlMs = 3_600_000,
  token?: string
): Promise<MintedClaim> {
  const res = await fetch(
    `${busUrl.replace(/\/+$/, "")}/admin/channels/${encodeURIComponent(channel)}/claims`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        participant,
        channel_secret: channelSecret,
        ttl_ms: ttlMs,
        ...(token !== undefined ? { token } : {}),
      }),
    }
  );
  const body = await readBody(res);
  if (!res.ok) throw new BusError(`claim mint rejected: ${body.error ?? res.status}`, res.status);
  if (typeof body.claim_id !== "string" || typeof body.expires_at !== "string") {
    throw new BusError("claim mint returned a malformed response", res.status);
  }
  return { claim_id: body.claim_id, expires_at: body.expires_at };
}

export interface ClaimBundle {
  participant: string;
  /** the channel's attested participant list (the auditor's "orchestrator"
   *  author excluded); `participant` is always an entry when attested.
   *  Empty when the relay predates attestation. */
  participants: string[];
  /** participants minus the redeemer — the provisioned peer id(s) */
  peers: string[];
  token: string;
  channel_secret: string;
  channel: string;
  epoch: string;
  /** false when the relay did not carry the participant attestation, so
   *  `participants`/`peers` are empty and the peer id must come from
   *  provisioning knowledge instead of the claim. */
  attested: boolean;
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/**
 * Redeem a one-time claim URL. Single-use: a second fetch gets 410, an
 * expired or unknown claim gets 404/410. The caller should persist the
 * bundle to a 0600 file and never paste it into chat.
 */
export async function fetchClaim(claimUrl: string): Promise<ClaimBundle> {
  const res = await fetch(claimUrl);
  const body = await readBody(res);
  if (!res.ok) throw new BusError(`claim fetch rejected: ${body.error ?? res.status}`, res.status);
  const { participant, participants, peers, token, channel_secret, channel, epoch } = body;
  // Credentials are mandatory; the attestation is not. An older relay omits
  // participants/peers, and rejecting that bundle throws *after* the relay
  // burned the claim — a valid one-time URL destroyed over a field we can do
  // without. Degrade instead: mark it unattested and let the caller supply
  // the peer id from provisioning knowledge.
  if (
    typeof participant !== "string" ||
    typeof token !== "string" ||
    typeof channel_secret !== "string" ||
    typeof channel !== "string" ||
    typeof epoch !== "string"
  ) {
    throw new BusError("claim returned a malformed bundle", res.status);
  }
  const attested = isStringArray(participants) && isStringArray(peers);
  if (attested && (!participants!.includes(participant) || peers!.includes(participant))) {
    throw new BusError("claim attestation contradicts the redeemer", res.status);
  }
  return {
    participant,
    participants: attested ? participants! : [],
    peers: attested ? peers! : [],
    token,
    channel_secret,
    channel,
    epoch,
    attested,
  };
}
