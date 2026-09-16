// Bus crypto (v0.2): message bodies are AEAD-encrypted under the shared
// channel secret — AES-256-GCM, random 96-bit nonce, AAD binds channel+msg_id
// so ciphertexts cannot be replayed across channels or under a different
// msg_id. The relay stores {nonce, ct} and never sees plaintext.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export class BusCryptoError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "BusCryptoError";
  }
}

export interface WireEnvelope {
  /** base64, 12-byte nonce */
  nonce: string;
  /** base64, ciphertext || 16-byte GCM tag */
  ct: string;
}

/** 32-byte channel secret, hex-encoded for printing in connection instructions. */
export function newChannelSecret(): string {
  return randomBytes(32).toString("hex");
}

/** Bearer token for one participant on one channel. */
export function newToken(): string {
  return randomBytes(24).toString("hex");
}

/** Random channel id / epoch fragment. */
export function newId(prefix: string): string {
  return `${prefix}${randomBytes(6).toString("hex")}`;
}

function secretKey(secretHex: string): Buffer {
  const key = Buffer.from(secretHex, "hex");
  if (key.length !== 32) throw new BusCryptoError("channel secret must be 32 bytes hex-encoded");
  return key;
}

function aad(channel: string, msgId: string): Buffer {
  return Buffer.from(`${channel}:${msgId}`, "utf8");
}

/** Encrypt a UTF-8 payload string under the channel secret. */
export function encryptPayload(
  secretHex: string,
  channel: string,
  msgId: string,
  plaintext: string
): WireEnvelope {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey(secretHex), nonce);
  cipher.setAAD(aad(channel, msgId));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    nonce: nonce.toString("base64"),
    ct: Buffer.concat([ct, tag]).toString("base64"),
  };
}

/** Decrypt a wire envelope. Throws BusCryptoError on any tamper/wrong key. */
export function decryptPayload(
  secretHex: string,
  channel: string,
  msgId: string,
  env: WireEnvelope
): string {
  try {
    const nonce = Buffer.from(env.nonce, "base64");
    const all = Buffer.from(env.ct, "base64");
    if (nonce.length !== 12 || all.length < 17) {
      throw new BusCryptoError("malformed envelope");
    }
    const ct = all.subarray(0, all.length - 16);
    const tag = all.subarray(all.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", secretKey(secretHex), nonce);
    decipher.setAAD(aad(channel, msgId));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch (e) {
    if (e instanceof BusCryptoError) throw e;
    throw new BusCryptoError("envelope authentication failed");
  }
}

/** sha256 hex of a string — payload_hash for accepted turns. */
export function hashPayload(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
