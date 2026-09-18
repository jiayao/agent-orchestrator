// Relay durable store (v0.3): `team bus-serve --data-dir <dir>` persists the
// relay's recoverable state to a single SQLite file (bun:sqlite, WAL mode,
// synchronous=FULL — a committed message survives kill -9 and a machine
// restart; writes are human-paced so the fsync costs nothing).
//
// What is persisted — and what deliberately is not:
// - channels (id, epoch, created_at): persisted.
// - tokens: persisted as SHA-256 hashes, never raw. The relay only verifies
//   presented bearer tokens, so the hash is sufficient — and a stolen DB no
//   longer hands out working credentials. Consequence: after a restart the
//   relay cannot re-derive a raw token for a claim mint, so
//   POST /admin/channels/<ch>/claims accepts an optional "token" field; the
//   provisioner (which knows the tokens) supplies it.
// - the per-channel message log (seq, msg_id, author, ts, nonce, ct):
//   persisted. Bodies are AEAD ciphertext under the channel secret, so
//   ciphertext-at-rest is within the threat model.
// - one-time claims: NOT persisted. They are short-lived (TTL-bounded,
//   single-use); in-flight unredeemed claims die on restart and must be
//   re-minted.
// - the auditor lease: NOT persisted as held. Boot always starts with no
//   lease holder so a fresh auditor can acquire. The single-auditor
//   discipline is unchanged: a stale auditor process elsewhere holding a
//   stale lease belief is an operator error, same as today.
// - long-poll waiters: transient; clients reconnect on their own.
//
// Restart semantics: a durable relay restart looks like a transient
// disconnect to participants — their next poll resumes from their cursor
// against the intact log instead of dying on a 404.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export interface RelayStoredMessageRow {
  seq: number;
  msg_id: string;
  author: string;
  ts: string;
  nonce: string;
  ct: string;
}

export interface PersistedSeat {
  seat_id: string;
  display_name?: string;
  role?: string;
  /** "claimed" while a live token is bound to the seat; "vacant" after a
   *  revoke. Vacancy is a property of the SEAT, not the token — the seat_id
   *  survives revocation so a later join can reclaim it. */
  state: "claimed" | "vacant";
}

export interface PersistedChannel {
  id: string;
  epoch: string;
  created_at: string;
  /** sha256(token) hex -> author */
  tokens: Map<string, string>;
  /** seat_id -> seat record. Outlives token revocation (see vacateSeat). */
  seats: Map<string, PersistedSeat>;
  messages: RelayStoredMessageRow[];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  epoch TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  author TEXT NOT NULL,
  PRIMARY KEY (channel_id, token_hash)
);
CREATE TABLE IF NOT EXISTS seats (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  seat_id TEXT NOT NULL,
  display_name TEXT,
  role TEXT,
  state TEXT NOT NULL DEFAULT 'claimed',
  PRIMARY KEY (channel_id, seat_id)
);
CREATE TABLE IF NOT EXISTS messages (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  msg_id TEXT NOT NULL,
  author TEXT NOT NULL,
  ts TEXT NOT NULL,
  nonce TEXT NOT NULL,
  ct TEXT NOT NULL,
  PRIMARY KEY (channel_id, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS messages_msgid ON messages(channel_id, msg_id);
`;

export class RelayStore {
  readonly path: string;
  private db: Database;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.path = join(dataDir, "relay.sqlite");
    this.db = new Database(this.path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = FULL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA);
  }

  /** Provision a channel row plus its token-hash and seat rows, atomically. */
  createChannel(
    id: string,
    epoch: string,
    createdAt: string,
    tokens: Iterable<readonly [string, string]>,
    seats: Iterable<{ seat_id: string; display_name?: string; role?: string }> = []
  ): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare("INSERT INTO channels (id, epoch, created_at) VALUES (?, ?, ?)")
        .run(id, epoch, createdAt);
      const ins = this.db.prepare(
        "INSERT INTO tokens (channel_id, token_hash, author) VALUES (?, ?, ?)"
      );
      for (const [hash, author] of tokens) ins.run(id, hash, author);
      const insSeat = this.db.prepare(
        "INSERT INTO seats (channel_id, seat_id, display_name, role, state) " +
          "VALUES (?, ?, ?, ?, 'claimed')"
      );
      for (const s of seats) insSeat.run(id, s.seat_id, s.display_name ?? null, s.role ?? null);
    });
    tx();
  }

  /** Append one committed message. seq/msg_id uniqueness is enforced. */
  appendMessage(channelId: string, m: RelayStoredMessageRow): void {
    this.db
      .prepare(
        "INSERT INTO messages (channel_id, seq, msg_id, author, ts, nonce, ct) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(channelId, m.seq, m.msg_id, m.author, m.ts, m.nonce, m.ct);
  }

  /**
   * Vacate a seat: drop every live token bound to it but keep the seat row,
   * so the seat_id (and its display_name/role) survives revocation and a
   * later mint/join can reclaim it. This is the difference between "left"
   * and "was erased" that the old delete-only revoke collapsed.
   */
  vacateSeat(channelId: string, seatId: string): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM tokens WHERE channel_id = ? AND author = ?")
        .run(channelId, seatId);
      // Upsert, not UPDATE: a seat derived by the pre-seat migration may not
      // have a row yet, and an UPDATE against a missing row is a silent no-op
      // that loses the seat on the next boot.
      this.db
        .prepare(
          "INSERT INTO seats (channel_id, seat_id, state) VALUES (?, ?, 'vacant') " +
            "ON CONFLICT(channel_id, seat_id) DO UPDATE SET state = 'vacant'"
        )
        .run(channelId, seatId);
    });
    tx();
  }

  /**
   * Bind a (fresh) token hash to an existing seat and mark it claimed. Used
   * when re-minting for a vacant seat: the seat row already exists, so this
   * is an UPDATE + token INSERT rather than a provisioning-time create.
   */
  claimSeat(channelId: string, seatId: string, tokenHash: string): void {
    const tx = this.db.transaction(() => {
      // a seat may accumulate a replaced token; drop any prior row for it
      this.db
        .prepare("DELETE FROM tokens WHERE channel_id = ? AND author = ?")
        .run(channelId, seatId);
      this.db
        .prepare("INSERT INTO tokens (channel_id, token_hash, author) VALUES (?, ?, ?)")
        .run(channelId, tokenHash, seatId);
      this.db
        .prepare(
          "INSERT INTO seats (channel_id, seat_id, state) VALUES (?, ?, 'claimed') " +
            "ON CONFLICT(channel_id, seat_id) DO UPDATE SET state = 'claimed'"
        )
        .run(channelId, seatId);
    });
    tx();
  }

  /** Reload every channel with its token-hash map and ordered log. */
  loadChannels(): PersistedChannel[] {
    const channels = this.db
      .query("SELECT id, epoch, created_at FROM channels ORDER BY created_at")
      .all() as { id: string; epoch: string; created_at: string }[];
    const tokenRows = this.db
      .query("SELECT channel_id, token_hash, author FROM tokens")
      .all() as { channel_id: string; token_hash: string; author: string }[];
    const msgRows = this.db
      .query(
        "SELECT channel_id, seq, msg_id, author, ts, nonce, ct FROM messages " +
          "ORDER BY channel_id, seq"
      )
      .all() as ({
      channel_id: string;
    } & RelayStoredMessageRow)[];

    const seatRows = this.db
      .query("SELECT channel_id, seat_id, display_name, role, state FROM seats")
      .all() as {
      channel_id: string;
      seat_id: string;
      display_name: string | null;
      role: string | null;
      state: string;
    }[];

    const byChannel = new Map<string, PersistedChannel>();
    for (const c of channels) {
      byChannel.set(c.id, {
        id: c.id,
        epoch: c.epoch,
        created_at: c.created_at,
        tokens: new Map(),
        seats: new Map(),
        messages: [],
      });
    }
    for (const t of tokenRows) byChannel.get(t.channel_id)?.tokens.set(t.token_hash, t.author);
    for (const s of seatRows) {
      byChannel.get(s.channel_id)?.seats.set(s.seat_id, {
        seat_id: s.seat_id,
        ...(s.display_name !== null ? { display_name: s.display_name } : {}),
        ...(s.role !== null ? { role: s.role } : {}),
        state: s.state === "vacant" ? "vacant" : "claimed",
      });
    }
    // Migration: a store written before seats existed has no seat rows. Derive
    // them from live tokens (minus the reserved orchestrator author) so an
    // upgraded relay does not report an empty seat list for existing channels.
    // The derived rows are then PERSISTED: vacate/claim write `seats` rows, so
    // an in-memory-only migration would make those writes no-ops and lose the
    // seat on the next boot. INSERT OR IGNORE leaves existing rows untouched.
    const insDerivedSeat = this.db.prepare(
      "INSERT OR IGNORE INTO seats (channel_id, seat_id, display_name, role, state) " +
        "VALUES (?, ?, NULL, NULL, ?)"
    );
    for (const c of byChannel.values()) {
      if (c.seats.size === 0) {
        for (const author of c.tokens.values()) {
          if (author === "orchestrator") continue;
          c.seats.set(author, { seat_id: author, state: "claimed" });
        }
      }
      for (const s of c.seats.values()) insDerivedSeat.run(c.id, s.seat_id, s.state);
    }
    for (const m of msgRows) {
      byChannel.get(m.channel_id)?.messages.push({
        seq: m.seq,
        msg_id: m.msg_id,
        author: m.author,
        ts: m.ts,
        nonce: m.nonce,
        ct: m.ct,
      });
    }
    return [...byChannel.values()];
  }

  close(): void {
    this.db.close();
  }
}
