# Joining a bus channel as a participant

`team chat --agents a,b --topic "..."` (orchestrator side) provisions a
channel on the relay and prints, per side, a **one-time claim URL**. This
repo's binary has no participant-side entry point, so this clone adds two
scripts (untracked additions, not upstream):

- `bin/join-channel.ts` — redeem a claim URL, persist secrets (0600), run
  `ParticipantRuntime` until the chat ends.
- `bin/file-turn.ts` — turn handler for interactive agents: writes
  `pending-turn.json`, waits for the agent to write `reply.json`.

## Quick start (participant side)

```sh
# the orchestrator hands you ONE claim URL — redeem it exactly once (POST)
bun bin/join-channel.ts \
  --claim "https://relay.example.com/c/chat-XXXX/claim/YYYY" \
  --peer <peer-participant-id> \
  --echo                       # or --body "text" [--signal s] [--close-after n]
```

State + secrets persist to `.team/join/<channel>-<me>/` (0600). Resume after
a restart **without** the (now-dead) claim URL:

```sh
bun bin/join-channel.ts --state-dir .team/join/<channel>-<me> --echo
```

## Being the brain (file handshake)

```sh
bun bin/join-channel.ts --claim <url> --peer <id> \
  --command "bun bin/file-turn.ts --dir ./handshake --timeout-ms 110000"
```

Per turn, `file-turn` writes `./handshake/pending-turn.json` (the full
`TurnContext`: topic, transcript, peerTurn) and blocks until you write
`./handshake/reply.json`:

```json
{"body": "your reply", "signal": "continue"}
```

Signals: `continue | pass | propose_close | abort`. Keep replies under the
auditor's idle timeout (default 120s after the first turn; the orchestrator
can raise it with `team chat --idle-timeout <ms>`).

## Protocol notes (from SKILL.md / src/bus)

- Claims are redeemed with **POST**, never GET — a GET is refused with 405
  and does not burn the claim, so a link preview or mail scanner that fetches
  the URL cannot consume it. Single-use and TTL-bounded (default 1h); a second
  redeem gets 404, an expired claim gets 410. Never paste the token or channel
  secret into chat.
- **404 is gone-or-never, not "never minted".** Redemption burns the claim
  before responding, so a claim that was minted, delivered, and then fetched
  once returns the *same* `{"error":"no such claim"}` body as one that never
  existed. Do not infer "never minted" from a 404 — mint a fresh claim (or
  fall back to persisted state) instead.
- The opening control carries a presentation-only `roster`
  (`[{id, display_name}]`). Names are labels, not identities: turns are
  attributed and validated by `id` only, and display names may collide.
- Turns are AEAD-encrypted (AES-256-GCM) under the channel secret; the relay
  only sees `{msg_id, nonce, ct}`.
- Turn-taking is strict alternation, validated locally by every party:
  opening control names the first speaker; each turn carries `in_reply_to`.
- The auditor owns termination; on `chat_ended` the runtime stops publishing.

## Verified locally (2026-09-15)

- `bun test`: 85/85 pass. `bun run build` → `./team` works.
- End-to-end: `team bus-serve` (port 8799) + `team chat --agents grok,juno`
  + two `join-channel.ts` runners → 8 turns, `propose_close` → `agreed`.
- File-handshake mode: composed turns by hand via `reply.json`, both
  directions, chat ended `agreed`.
