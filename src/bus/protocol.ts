// Bus protocol (v0.2): the decrypted payload shapes and the deterministic
// turn-taking validation rule every party applies locally to the relay log.
//
// Turn-taking: the opening control message (author "orchestrator") names the
// first speaker — no t=0 deadlock. Every turn carries in_reply_to = the
// channel seq of the peer turn it answers (null for the opening turn). After
// an accepted turn by A only B's turn is protocol-valid; a second turn from
// the same author with the same in_reply_to is a duplicate and is ignored.
// Only accepted turns drive budgets, history, and end reasons — everything
// else stays raw-only.

import type { ChatSignal, RosterEntry, TeamEvent } from "../types.ts";
import { isChatSignal } from "../chat.ts";
import { peerOf as corePeerOf } from "../chatcore.ts";

export interface TurnPayload {
  v: 1;
  type: "turn";
  /** channel seq of the peer turn this answers; null for the opening turn */
  in_reply_to: number | null;
  body: string;
  signal?: ChatSignal;
}

export interface ControlPayload {
  v: 1;
  type: "control";
  control: "chat_started" | "chat_ended";
  first_speaker?: string; // chat_started
  topic?: string; // chat_started
  /** presentation-only name roster; ids remain the authoritative identity */
  roster?: RosterEntry[]; // chat_started
  reason?: string; // chat_ended
  terminal_seq?: number; // chat_ended
}

export type BusPayload = TurnPayload | ControlPayload;

/** One message as served by the relay (author is relay-attested). */
export interface RelayMessage {
  seq: number;
  msg_id: string;
  author: string;
  ts: string;
  nonce: string;
  ct: string;
}

// ---- deterministic msg_ids ----

/** Opening control: one per channel epoch. */
export function openingMsgId(epoch: string): string {
  return `ctrl-${epoch}-open-chat_started`;
}

/** Terminal control: deterministic from {channel_epoch, terminal_seq, reason}. */
export function endedMsgId(epoch: string, terminalSeq: number, reason: string): string {
  return `ctrl-${epoch}-${terminalSeq}-chat_ended-${reason}`;
}

/** Participant turn replying to peer turn `inReplyTo` (null -> 0, the opening). */
export function turnMsgId(agentId: string, epoch: string, inReplyTo: number | null): string {
  return `${agentId}@${epoch}:re${inReplyTo ?? 0}`;
}

// ---- payload codec ----

export function encodeTurn(inReplyTo: number | null, body: string, signal?: ChatSignal): string {
  const p: TurnPayload = { v: 1, type: "turn", in_reply_to: inReplyTo, body };
  if (signal) p.signal = signal;
  return JSON.stringify(p);
}

export function encodeStarted(
  firstSpeaker: string,
  topic: string,
  roster?: RosterEntry[]
): string {
  const p: ControlPayload = {
    v: 1, type: "control", control: "chat_started",
    first_speaker: firstSpeaker, topic,
  };
  // Omit entirely when empty so the wire shape is unchanged for callers that
  // have no names to publish.
  if (roster && roster.length > 0) p.roster = roster;
  return JSON.stringify(p);
}

export function encodeEnded(reason: string, terminalSeq: number): string {
  const p: ControlPayload = {
    v: 1, type: "control", control: "chat_ended",
    reason, terminal_seq: terminalSeq,
  };
  return JSON.stringify(p);
}

/** Parse a decrypted payload; null on any malformed shape. */
export function decodePayload(text: string): BusPayload | null {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  if (j === null || typeof j !== "object" || Array.isArray(j)) return null;
  const o = j as Record<string, unknown>;
  if (o.v !== 1) return null;
  if (o.type === "turn") {
    if (typeof o.body !== "string") return null;
    if (o.in_reply_to !== null && typeof o.in_reply_to !== "number") return null;
    const p: TurnPayload = {
      v: 1, type: "turn",
      in_reply_to: o.in_reply_to as number | null,
      body: o.body,
    };
    if (o.signal !== undefined) {
      if (!isChatSignal(o.signal)) return null;
      p.signal = o.signal;
    }
    return p;
  }
  if (o.type === "control") {
    if (o.control !== "chat_started" && o.control !== "chat_ended") return null;
    const p: ControlPayload = { v: 1, type: "control", control: o.control };
    if (o.first_speaker !== undefined) {
      if (typeof o.first_speaker !== "string") return null;
      p.first_speaker = o.first_speaker;
    }
    if (o.topic !== undefined) {
      if (typeof o.topic !== "string") return null;
      p.topic = o.topic;
    }
    if (o.roster !== undefined) {
      // Display labels must degrade gracefully: a malformed roster entry is
      // dropped, never fatal. Returning null here would discard the whole
      // chat_started control (decode errors become bad_shape -> ignored),
      // which would wedge a channel over cosmetics.
      if (Array.isArray(o.roster)) {
        const roster: RosterEntry[] = [];
        for (const raw of o.roster) {
          if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
          const e = raw as Record<string, unknown>;
          if (typeof e.id !== "string" || e.id === "") continue;
          const entry: RosterEntry = { id: e.id };
          if (typeof e.display_name === "string" && e.display_name !== "") {
            entry.display_name = e.display_name;
          }
          roster.push(entry);
        }
        if (roster.length > 0) p.roster = roster;
      }
    }
    if (o.reason !== undefined) {
      if (typeof o.reason !== "string") return null;
      p.reason = o.reason;
    }
    if (o.terminal_seq !== undefined) {
      if (typeof o.terminal_seq !== "number") return null;
      p.terminal_seq = o.terminal_seq;
    }
    if (p.control === "chat_started" && !p.first_speaker) return null;
    if (p.control === "chat_ended" && (p.reason === undefined || p.terminal_seq === undefined)) {
      return null;
    }
    return p;
  }
  return null;
}

// ---- deterministic validation ----

export type IgnoreWhy =
  | "dup" // same author + same in_reply_to as an already-seen turn
  | "wrong_speaker" // author is not the expected speaker
  | "bad_reply_to" // in_reply_to != the latest accepted peer turn
  | "not_participant" // author is neither participant nor orchestrator-control
  | "not_orchestrator" // control message from a non-orchestrator author
  | "ended" // the chat already ended
  | "stale_ended" // chat_ended claims a terminal_seq behind accepted turns
  | "bad_shape"; // payload didn't decode

export type Validation =
  | { kind: "turn" }
  | { kind: "started"; firstSpeaker: string }
  | { kind: "ended"; reason: string; terminalSeq: number }
  | { kind: "ignore"; why: IgnoreWhy };

/**
 * Pairwise strict alternation as a deterministic rule over the relay log.
 * The auditor and both participants run the same validator, so all parties
 * agree on accepted turns without coordinating.
 */
export class TurnValidator {
  readonly participants: [string, string];
  /** author allowed to send control messages */
  readonly orchestrator = "orchestrator";
  firstSpeaker: string | null;
  /** the participant whose turn is valid next; null until chat_started */
  expected: string | null = null;
  /** channel seq of the latest accepted turn */
  lastAcceptedSeq: number | null = null;
  lastAcceptedAuthor: string | null = null;
  /** seen (author, in_reply_to) pairs for duplicate detection */
  private seenReplies = new Set<string>();
  ended: { reason: string; terminalSeq: number } | null = null;

  constructor(participants: [string, string], firstSpeaker: string | null = null) {
    this.participants = participants;
    this.firstSpeaker = firstSpeaker;
    this.expected = firstSpeaker;
  }

  peerOf(author: string): string {
    return corePeerOf(this.participants, author);
  }

  /**
   * Validate one relayed message. `payload` is the decrypted payload (null if
   * undecryptable/undecodable — counted as bad_shape).
   */
  ingest(msg: { seq: number; author: string }, payload: BusPayload | null): Validation {
    if (payload === null) return { kind: "ignore", why: "bad_shape" };

    if (payload.type === "control") {
      if (msg.author !== this.orchestrator) return { kind: "ignore", why: "not_orchestrator" };
      if (payload.control === "chat_started") {
        if (this.firstSpeaker !== null) return { kind: "ignore", why: "dup" };
        this.firstSpeaker = payload.first_speaker!;
        if (!this.participants.includes(this.firstSpeaker)) {
          this.firstSpeaker = this.participants[0];
        }
        if (this.lastAcceptedSeq === null) this.expected = this.firstSpeaker;
        return { kind: "started", firstSpeaker: this.firstSpeaker };
      }
      // chat_ended
      if (this.ended) return { kind: "ignore", why: "ended" };
      // Stale end: the control claims the chat ended at terminal_seq, but we
      // have already accepted turns beyond it. A decision made with incomplete
      // information (e.g. from a crashed auditor) must not override the turn
      // stream's ground truth.
      if (payload.terminal_seq! < (this.lastAcceptedSeq ?? 0)) {
        return { kind: "ignore", why: "stale_ended" };
      }
      this.ended = { reason: payload.reason!, terminalSeq: payload.terminal_seq! };
      return { kind: "ended", reason: this.ended.reason, terminalSeq: this.ended.terminalSeq };
    }

    // turn payload
    if (this.ended) return { kind: "ignore", why: "ended" };
    if (!this.participants.includes(msg.author)) return { kind: "ignore", why: "not_participant" };
    const key = `${msg.author}:${payload.in_reply_to ?? "null"}`;
    if (this.seenReplies.has(key)) return { kind: "ignore", why: "dup" };
    if (this.expected === null || msg.author !== this.expected) {
      return { kind: "ignore", why: "wrong_speaker" };
    }
    const expectedReplyTo = this.lastAcceptedSeq;
    if (payload.in_reply_to !== expectedReplyTo) return { kind: "ignore", why: "bad_reply_to" };
    this.seenReplies.add(key);
    this.lastAcceptedSeq = msg.seq;
    this.lastAcceptedAuthor = msg.author;
    this.expected = this.peerOf(msg.author);
    return { kind: "turn" };
  }

  /** Serialize validation state into durable participant state. */
  snapshot(): {
    firstSpeaker: string | null;
    expected: string | null;
    lastAcceptedSeq: number | null;
    lastAcceptedAuthor: string | null;
    seenReplies: string[];
    ended: { reason: string; terminalSeq: number } | null;
  } {
    return {
      firstSpeaker: this.firstSpeaker,
      expected: this.expected,
      lastAcceptedSeq: this.lastAcceptedSeq,
      lastAcceptedAuthor: this.lastAcceptedAuthor,
      seenReplies: [...this.seenReplies],
      ended: this.ended,
    };
  }

  /** Restore validation state persisted by snapshot(). */
  restore(snap: {
    firstSpeaker: string | null;
    expected: string | null;
    lastAcceptedSeq: number | null;
    lastAcceptedAuthor: string | null;
    seenReplies: string[];
    ended: { reason: string; terminalSeq: number } | null;
  }): void {
    this.firstSpeaker = snap.firstSpeaker;
    this.expected = snap.expected;
    this.lastAcceptedSeq = snap.lastAcceptedSeq;
    this.lastAcceptedAuthor = snap.lastAcceptedAuthor;
    this.seenReplies = new Set(snap.seenReplies);
    this.ended = snap.ended;
  }

  /**
   * Rebuild validator state by replaying committed records in order.
   * `bus_record` events carry the full wire envelope (nonce + ct), so the
   * replay re-decrypts and re-validates the actual relayed payload — the
   * verdict field on the record is information, not authority. `decrypt`
   * maps the wire fields back to the plaintext payload. Legacy materialized
   * events (pre-bus_record logs: turn/chat_started/chat_ended) are still
   * ingested so older task dirs remain resumable.
   */
  replayCommitted(
    events: TeamEvent[],
    decrypt?: (wire: { msg_id: string; nonce: string; ct: string }) => string | null
  ): void {
    for (const ev of events) {
      if (!ev.bus) continue;
      if (ev.type === "bus_record") {
        let payload: BusPayload | null = null;
        if (decrypt && ev.bus.nonce !== undefined && ev.bus.ct !== undefined) {
          const pt = decrypt({ msg_id: ev.bus.msg_id, nonce: ev.bus.nonce, ct: ev.bus.ct });
          if (pt !== null) payload = decodePayload(pt);
        }
        this.ingest(
          { seq: ev.bus.seq, author: ev.bus.author ?? ev.actor },
          payload
        );
        continue;
      }
      if (ev.type === "turn") {
        this.ingest(
          { seq: ev.bus.seq, author: ev.bus.author ?? ev.actor },
          {
            v: 1, type: "turn",
            in_reply_to: ev.bus.in_reply_to ?? null,
            body: ev.body,
            ...(ev.signal ? { signal: ev.signal } : {}),
          }
        );
      } else if (ev.type === "chat_started" && ev.bus.control !== undefined) {
        this.ingest(
          { seq: ev.bus.seq, author: "orchestrator" },
          { v: 1, type: "control", control: "chat_started", first_speaker: ev.bus.first_speaker }
        );
      } else if (ev.type === "chat_ended" && ev.bus.reason !== undefined) {
        this.ingest(
          { seq: ev.bus.seq, author: "orchestrator" },
          {
            v: 1, type: "control", control: "chat_ended",
            reason: ev.bus.reason, terminal_seq: ev.bus.terminal_seq ?? 0,
          }
        );
      }
    }
  }
}

/** The auditor cursor: max committed relay seq in events.jsonl. One file, no
 *  separate cursor state. */
export function deriveCursor(events: TeamEvent[]): number {
  let cur = 0;
  for (const ev of events) {
    if (ev.bus && ev.bus.seq > cur) cur = ev.bus.seq;
  }
  return cur;
}
