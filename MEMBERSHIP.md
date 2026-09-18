# Membership changes, not "roster authority"

Status: design note (no code). Date: 2026-09-17.

This note follows the seats slice (PR #1), which made the live membership
table trustworthy — seats are now stable, addressable, and refillable. It
answers the question that slice deliberately deferred: what happens to the
*other* membership record, the frozen roster, when membership actually
changes.

Both halves of this note were reviewed with Moss over a bus channel before
being written up. Where the two of us diverged, the call is marked.

## The problem: two sources of truth that agree only at t=0

A channel now has two records of who belongs.

1. **The roster.** Carried on the opening `chat_started` control as
   `roster: [{id, display_name}]`. Frozen at provision.
2. **The token/seat table.** The live cryptographic record. Changes when a
   participant is revoked (seat vacated) or re-minted (seat refilled).

These agree at `t=0` and diverge at exactly the moment membership changes —
which is the moment they matter. PR #1 made the second record durable and
therefore trustworthy. It did not touch the first, on purpose.

The concrete failure to design against: A is revoked mid-channel. A's token
is dead, so A cannot publish. But the frozen roster still names A, so a peer
— or a UI reading the transcript — still believes A is expected to speak.
Conversely, if A re-mints and refills the seat, the roster never learns A is
back. Membership *truth* lives in the token table; membership *story* lives
in the roster; nothing reconciles them.

## Non-goals

- **No change to authentication.** The token/seat table stays the sole
  authority on who may publish. This note adds no new auth path.
- **No group channels.** Still exactly two speakers. Seats do not make N>2
  turn-taking work, and this note does not either.
- **No live roster.** The opening roster is not re-published or mutated.

## The three objects and their roles

| Object | Role | Mutability | Load-bearing? |
|---|---|---|---|
| `chat_started.roster` | Cast list at open | Frozen per epoch | **No** — display only |
| token / seat table | Sole membership authority | Live | **Yes** — auth + validation |
| `membership_changed` (new) | Wire truth about joins/leaves | Append-only events | **No** — expectations + display |

The naming matters. "Roster-as-membership-authority" is a **misnomer**: the
roster must never become load-bearing for "who may speak." The honest name
for this work is **membership-change events**. [call — Moss; agreed.]

### Why the roster stays a frozen snapshot

The alternative — re-publishing the roster on every change — fails two ways.
Either it becomes a live second authority, which clients will eventually
*trust by accident* (the exact failure we are trying to prevent), or it
produces a stream of near-identical `chat_started`-shaped controls that
clients will mishandle. Snapshot-plus-separate-event is the right shape.

## The `membership_changed` control

Optional to **emit** (the auditor publishes it when membership actually
changes) but mandatory to **understand** once present. A peer that ignores
it keeps a lying display; a peer that folds it stays honest. For two-speaker
chat the common case is still "never fires" — that is fine. Design for the
rare case once, rather than never.

Shape sketch (not a PR):

```jsonc
{
  "v": 1,
  "type": "control",
  "control": "membership_changed",
  "channel": "chat-...",
  "epoch": "e-...",
  "at_seq": 17,                    // channel seq this change folds at
  "change": "revoked" | "refilled" | "renamed",
  "seat_id": "a",
  "participant_id": "a",           // omitted for a rename of a label only
  "display_name": "mini-moss",     // optional
  "reason": "operator revoked"     // optional, free text
}
```

**`at_seq` is load-bearing. [call — Juno.]** Without it, a peer replaying
the log and a peer that saw the event live can fold it at different points
and disagree — a late joiner would apply a revoke to the wrong turn
boundary. With `at_seq`, folding is deterministic and identical to the
guarantee `chat_ended` already has via `TurnValidator.replayCommitted`.

**Folding rules.** A peer folds `membership_changed` into:

- local "expected speakers" for liveness/idle purposes, and
- any human-facing display of who is present.

It must **never** fold it into `TurnValidator`'s auth or alternation rules.
That is the whole discipline: expectations and display only.

## The audit: does anything read the roster today?

Moss's sharpest question was whether turn-taking or idle logic already
reads the frozen roster — which would be a soft hole (stuck channels,
spoofed presence) even with publish auth intact. Checked in code, not
asserted:

- **Turn-taking** keys on `TurnValidator.participants` (`protocol.ts`), a
  `[string, string]` built from the provisioning/claim bundle — token-derived.
  `validator.expected` gates who may speak; the roster never enters it.
- **Roster reads are presentation-only**, in exactly two places: stored on
  `chat_started`, and used to resolve `peerDisplayName` for display. The
  field's own comment says "never used for validation."
- **Idle / termination** is wall-clock plus substantive turn count. No roster
  read.

**Conclusion: the soft hole does not exist today.** But it is one
`roster.find(...)` away from existing. The guard should therefore be a
**test that fails if validation ever consults the roster** — not a comment
that can rot. This note recommends that test land with the control.

## Adjacent finding: whose clock bounds a turn?

Observed while testing this discussion on a live channel (the channel
aborted). A turn's deadline is not one number — each party holds its own,
and the **shortest** one decides the outcome:

| Clock | Typical | Owner |
|---|---|---|
| peer operator's reply deadline | ~10 min | the human at the keyboard |
| local turn handler (`file-turn`) | 25 min | the agent's runtime |
| auditor idle timer | hours | the auditor |

On a channel between an agent and an **operator-mediated** peer, the
binding deadline is the human's. When that human is silent, their runtime
signals `abort`, and the abort is indistinguishable from a genuine
withdrawal. The same channel earlier survived ~70 minutes of "no reply"
passes when the *agent* side was the slow one.

**Recommendation:** any turn-taking/idle design must state whose clock
bounds a turn, and a channel with an operator-mediated participant needs a
deadline sized for a human. This is arguably its own design note.

## Adjacent finding: claim redemption was destructible by GET

Redemption was `GET /c/<channel>/claim/<id>`, and the handler deleted the
claim **before checking expiry** — so any GET burned it. HTTP defines GET as
safe and idempotent, so link previews, mail URL-sandboxes, AV scanners, and
browser prefetchers all issue one while behaving correctly. The design
guaranteed a lost claim the moment a claim URL touched a chat or mail
pipeline; a chat link preview consumed one during this session.

Fixed separately (PR #2): redemption is `POST`, symmetric with minting, and
a `GET` on the claim path is non-destructive (405, claim intact).

Honest limit: a claim is a bearer capability and chat is a leaky medium
regardless of verb — history, sync, backups. POST removes the *accidental*
burn class; it does not make chat safe for credentials. A successor /
mailbox convention remains the real answer for hands-off handoff.

## Open questions

- Should `membership_changed` be emitted by the auditor only, or may an
  operator publish it? (Auditor-only keeps a single writer; operator-published
  would let a human force an expectation update without a channel restart.)
- Does a `renamed` change belong on this control at all, or is a label change
  a display concern that should not ride the wire?
- When a revoke leaves a channel with one live speaker, should the auditor
  publish `membership_changed` *and* a `chat_ended{...}`, or is the channel
  simply stuck until re-mint? (Overlapping with max_turns/idle.)
