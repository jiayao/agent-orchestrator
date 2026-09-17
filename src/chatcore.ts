// Chat core (v0.1/v0.2): the pure pairwise-chat state machine, extracted so
// every transport consumes the same rule. A normalized stream of accepted
// turns in, answers out: who speaks next, whether the chat should end, how
// many turns were substantive, and what transcript fits a prompt budget.
//
// Transports below this: runChat feeds it committed "turn" events; the bus
// auditor feeds it validated relay messages (bus_record verdict "turn");
// ParticipantRuntime.wakeup reads the same expectedActor via TurnValidator.
// The rule itself: strict alternation seeded by a first speaker; signals
// continue|pass|propose_close|abort; the peer always gets one closing turn
// after a propose_close; expired vs agreed vs aborted are honest reasons.

import type { ChatEndReason, ChatSignal } from "./types.ts";

export const CHARS_PER_TOKEN = 4;

/** Estimated tokens for a string (chars/4). */
export function estTokens(s: string): number {
  return Math.ceil(s.length / CHARS_PER_TOKEN);
}

/** One accepted turn, normalized across transports. */
export interface AcceptedTurn {
  /** position in the authoritative log: event seq (local) or relay seq (bus) */
  seq: number;
  actor: string;
  /** seq of the peer turn this answers; null for the opening turn */
  in_reply_to: number | null;
  body: string;
  signal: ChatSignal;
  /** turn committed from a malformed/absent result envelope (local path) */
  malformed?: boolean;
  /** stable id for transcript rendering (event_id; bus turns use seq-<n>) */
  id?: string;
}

export function peerOf(participants: [string, string], actor: string): string {
  return actor === participants[0] ? participants[1] : participants[0];
}

/**
 * Who speaks next: the first speaker when no turns are committed, else the
 * peer of the last accepted turn's author. TurnValidator.expected is the
 * incremental form of this fold over the bus path.
 */
export function expectedActor(
  turns: AcceptedTurn[],
  participants: [string, string],
  firstSpeaker: string
): string {
  const last = turns[turns.length - 1];
  return last ? peerOf(participants, last.actor) : firstSpeaker;
}

/** Accepted turns that count toward max_turns — "pass" yields for free. */
export function substantiveCount(turns: AcceptedTurn[]): number {
  return turns.filter((t) => t.signal !== "pass").length;
}

/** The last committed turn proposed a close; the next turn is the closing one. */
export function closePending(turns: AcceptedTurn[]): boolean {
  return turns[turns.length - 1]?.signal === "propose_close";
}

/** A propose_close was followed by the peer's closing turn. */
export function closingTurnCommitted(turns: AcceptedTurn[]): boolean {
  return turns.length >= 2 && turns[turns.length - 2].signal === "propose_close";
}

export interface ChatEnd {
  reason: ChatEndReason;
  detail: string;
}

/**
 * The end-condition rule over the accepted-turn stream, evaluated after each
 * accepted turn. Order matters: abort wins immediately; a completed
 * propose_close handshake agrees; max_turns expires only when no close is
 * pending (a pending proposal always earns the peer its closing turn).
 */
export function endCondition(turns: AcceptedTurn[], maxTurns: number): ChatEnd | null {  const last = turns[turns.length - 1];
  const prev = turns[turns.length - 2];
  if (last?.signal === "abort") {
    return { reason: "aborted", detail: `abort signaled by ${last.actor}` };
  }
  if (prev?.signal === "propose_close") {
    return {
      reason: "agreed",
      detail: `close proposed by ${prev.actor}; closing turn by ${last.actor}`,
    };
  }
  if (substantiveCount(turns) >= maxTurns && last?.signal !== "propose_close") {
    return { reason: "expired", detail: `max_turns=${maxTurns} reached` };
  }
  return null;
}

/**
 * Scan a (possibly replayed) accepted-turn stream for a completed close
 * handshake: propose_close followed by the peer's turn. The live loop uses
 * endCondition on the tail; this is for an auditor that missed the live
 * moment (e.g. it was down) — a later turn must not erase the agreement.
 * Returns the handshake, or null when no close was completed.
 */
export function findCompletedHandshake(
  turns: AcceptedTurn[]
): { proposer: string; closer: string; seq: number } | null {
  for (let i = 0; i < turns.length - 1; i++) {
    const prop = turns[i];
    if (prop.signal !== "propose_close") continue;
    const next = turns[i + 1];
    if (next.actor !== prop.actor && next.signal !== "abort") {
      return { proposer: prop.actor, closer: next.actor, seq: next.seq };
    }
  }
  return null;
}

export interface TranscriptSlice {
  /** rendered kept turns, oldest first */
  kept: string[];
  /** contiguous oldest turn range dropped for budget */
  omitted: { first: string; last: string; count: number } | null;
}

/**
 * Render the accepted-turn transcript bounded by a token budget: oldest whole
 * turns are dropped first, and the dropped range is reported so callers can
 * log what the agent actually saw. Turn ids are stable (event_id locally,
 * seq-<n> on the bus).
 */
export function transcriptFor(turns: AcceptedTurn[], availTokens: number): TranscriptSlice {
  const idOf = (t: AcceptedTurn) => t.id ?? `seq-${t.seq}`;
  const rendered = turns.map(
    (t) =>
      `[${idOf(t)}] ${t.actor} (signal=${t.signal}${t.malformed ? " malformed" : ""})\n${t.body}`
  );
  let avail = Math.max(0, availTokens);
  const kept: string[] = [];
  let drop = 0;
  for (let i = rendered.length - 1; i >= 0; i--) {
    const cost = estTokens(rendered[i]);
    if (cost > avail) {
      drop = i + 1;
      break;
    }
    avail -= cost;
    kept.unshift(rendered[i]);
  }
  const omitted =
    drop > 0 ? { first: idOf(turns[0]), last: idOf(turns[drop - 1]), count: drop } : null;
  return { kept, omitted };
}
