# team — pairwise chat for agents that can't reach each other

Two agents on different machines hold a structured conversation. Neither
accepts inbound connections; both dial out to a relay. An orchestrator
provisions the channel, audits the turn-taking, and calls the end. That is
the product.

The motivating setup: a personal agent on your laptop talking to a remote
agent on another computer — a chief-of-staff bot syncing with its principal's
assistant, two specialists negotiating a plan — with no shared network, no
open ports, and no copy-paste between windows.

## How a chat runs

```sh
team bus-serve --port 8787
team chat --agents grok,juno --topic "sync on this week's staff pulse"
```

`team chat` with two `kind = "bus"` agents provisions a channel: a random
channel id and epoch, one bearer token per participant (plus the auditor's
`orchestrator` token), and a shared channel secret. It registers the channel
on the relay over the admin API, writes secrets to
`.team/tasks/<id>/bus.secret.json` (mode 0600), prints connection
instructions per side, and starts the auditor.

Each side runs the same symmetric participant protocol — nothing about
either agent is special:

- `GET /c/<channel>/messages?since=<seq>&wait=<ms>` — long-poll subscribe, bearer auth.
- `POST /c/<channel>/messages` — publish `{msg_id, nonce, ct}`; the payload is AEAD-encrypted under the channel secret before it leaves the machine.
- Speak only when the deterministic rule says it's your turn: the auditor's opening control names the first speaker, every turn carries `in_reply_to` (the seq of the peer turn it answers), and after an accepted turn only the other side's turn is valid.

Turns carry a signal inside the `TEAM_RESULT_V1` envelope: `continue`,
`pass` (yield without a substantive turn), `propose_close` (the peer gets
one closing turn, then the chat ends `agreed`), `abort`. End reasons are
honest: `agreed | aborted | expired | idle_timeout | cancelled` — hitting
`max_turns` ends `expired`, never `completed`.

The auditor is not a relay and not a participant. It holds one lease per
channel, commits `bus_raw` records for everything relayed and `turn` events
only for accepted turns, and owns termination: `chat_ended` is always
published by the auditor, with deterministic control ids so a restarted
auditor's re-publish is a harmless duplicate. Its cursor is the max
committed relay seq in `events.jsonl` — there is no cursor file to lose.

## Trust model

The relay is trusted operator infrastructure you run yourself (the
reference deployment is Fly) — trusted the way any server you operate is
trusted, not trusted to be honest under attack. The threat model is crash
faults and network observers, not a Byzantine relay. Message bodies are
AEAD-encrypted (AES-256-GCM, AAD `"<channel>:<msg_id>"`), so the relay
stores ciphertext and observes metadata: message sizes, timing, source IPs,
which tokens authenticate. It attests authorship from the bearer token,
assigns sequence numbers, and enforces the single auditor lease. Anyone
holding the channel secret reads every message; anyone holding a
participant token writes as that participant.

Relay endpoints (bearer auth; `POST /admin/*` takes the admin token):

- `POST /admin/channels` — provision `{channel, epoch, tokens: {author: token}, seats?}`; requires an `orchestrator` author. `seats` is an optional ordered list of `{seat_id, display_name?, role?}`; absent = one seat per token author (minus the reserved `orchestrator`). Every seat must name an author that has a token, or provisioning is refused — a seat with no credential is neither reachable nor mintable.
- `DELETE /admin/channels/<channel>/tokens/<author>` — revoke a participant. This **vacates** the seat: the live token row is deleted but the seat row survives with `state: "vacant"`, so the seat_id stays addressable and can be refilled. (Deleting the row would make the seat unmintable — the exact case seats exist for.)
- `POST /admin/channels/<channel>/claims` — mint a single-use onboarding claim `{participant, channel_secret, ttl_ms?, token?}` (admin-only; the relay holds the secret in memory only until redeem/expiry). `token` is the participant's raw bearer token — required when minting after a relay restart (the relay persists token *hashes*, not raw tokens, so it can no longer re-derive them; the provisioner always knows them) **and required to refill a vacant seat** (a vacated seat has no live token by design, so the presented token is rebound to it).
- `GET /c/<channel>/claim/<id>` — redeem a claim once: returns `{participant, participants, peers, token, channel_secret, channel, epoch, seat_id, seat_state}`, then the claim is dead (second fetch 410, expired 410). `seat_state` is `"vacant"` when the claim refilled a revoked seat, so a re-joining participant can tell it walked into an existing slot rather than a fresh one. `peers` is provisioning's attestation of the peer id — `team join --from-claim-url` persists the bundle to `bus.credentials.json` (0600), and the participant runtime aborts loudly if a wire turn arrives authored by anyone else.
- `POST /c/<channel>/messages` — publish; a retried `msg_id` returns the original `seq` (`deduped: true`) and never appends twice.
- `GET /c/<channel>/messages?since=<seq>&wait=<ms>` — long-poll; returns `{messages, latest}`.
- `POST /c/<channel>/auditor` — take the auditor lease; one per channel, a second author gets 409.

## Seats

A **seat** is a channel's stable, addressable slot. Provisioning declares a
seat list (default: one seat per speaking agent); a claim populates a seat; a
revocation vacates it. The seat_id survives a revoke, so the same slot can be
refilled without inventing a new identity.

This is the difference the relay used to collapse. Revoking a token deleted
the row, and mint validated against the token table — so a revoked participant
was not merely unclaimable but *unmintable* (`400 no such participant`).
Seats split "this credential is dead" from "this slot never existed": the
token row goes, the seat row stays `vacant`, and re-minting with a fresh token
rebinds it. That re-mint rides the same raw-token path a post-restart mint
already uses, so the two share one code path rather than two.

Seats are per-channel and durable: they persist in `relay.sqlite` alongside
the token hashes, and a store written before seats existed derives them from
its live tokens on boot (the reserved `orchestrator` author is never a seat).

Note the deliberate limit: seats do **not** make N-party turn-taking work.
The chat layer still requires exactly two *speakers*; a channel declaring an
extra seat is holding an open slot for a later join or refill, not running a
three-way conversation.

`bin/provision.ts --seats a,b,reviewer` declares the list explicitly. A seat
that names no configured `[[agents]]` entry is refused, and so is a seat list
that omits a speaking agent.

## Relay durability and the Fly deployment

`team bus-serve --data-dir <dir>` makes the relay durable: channels,
SHA-256 token hashes (never raw tokens), and the per-channel message log
live in a single SQLite file (`<dir>/relay.sqlite`, WAL mode,
`synchronous=FULL`). A restart or redeploy then looks like a transient
disconnect — a participant's next poll resumes from its cursor against the
intact log instead of 404ing, and a restarted auditor re-acquires its lease
(boot always starts unheld) and resumes from its own committed cursor.

Deliberately *not* persisted: unredeemed one-time claims die on restart
(re-mint them — mints after a restart take the participant's `token` in the
request body), in-flight long-poll waiters drop (clients reconnect), and
the auditor lease always starts unheld — the single-auditor discipline is
unchanged, so a stale auditor process elsewhere holding a stale lease
belief is an operator error, same as today.

The Dockerfile's default command already serves with `--data-dir /data` and
`fly.toml` mounts a volume at `/data`. One-time operator step:

```sh
fly volumes create relay_data --region lax --size 1
fly scale count 1   # still required — one writer owns each channel log
fly deploy
```

Keep it to one machine: SQLite makes the log durable, not multi-writer —
two machines on separate volumes are still two separate logs (a fork).

## Configure a bus agent

```toml
[[agents]]
id = "grok"
kind = "bus"
bus_url = "https://relay.example.com"   # the relay this agent can reach
token_env = "TEAM_BUS_TOKEN_GROK"       # env var holding this agent's bearer token
```

Two more kinds exist for agents on the orchestrator's own machine: `cli`
(a spawned subprocess — see below) and `console` (the orchestrator prints
the transcript and blocks for a live operator reply, with a wall-clock
timeout; needs a TTY). If both agents are reachable, skip the bus: `cli`
and `console` chats relay turns directly with no relay involved.

## Also in the box: bounded team review

The same binary runs structured multi-agent review when the job isn't a
dialogue: `team workshop` hands an artifact to a team of CLI agents for a
critique round and a cross-review round, `team arbitrate` records your
pick, `team verdict` records whether the decision held up, and `team export`
writes a deterministic bundle. State lives in `.team/tasks/<task-id>/`
next to your `team.toml` — `events.jsonl` (append-only source of truth),
`view.md` (rendered for humans), `runs/` (per-run request, prompt, stdout,
stderr, result), `decision.md`.

## Install and configure

Requires [Bun](https://bun.sh) ≥ 1.3.

```sh
bun run dev -- <command>      # run from source, e.g. bun run dev -- doctor
bun run build                # writes ./team
./team doctor
```

```sh
team init          # writes team.toml + echo-agent.ts + example.md
team doctor        # validate config, probe binaries, print resolved argv
```

Agents are spawned as fresh processes with structured argv — no shell
interpolation. Two transport profiles:

**stdin-pipe** (e.g. `omp`): the composed prompt is written to stdin.
Keep `timeout_ms` under the CLI's practical ceiling (~110s for omp).

```toml
[[agents]]
id = "kimi"
adapter = "omp"
model = "fireworks/kimi-k3"
role = "critic"
cost_per_run_usd = 0.05
[agents.command]
executable = "omp"
args = ["-p", "--no-session"]
stdin = "prompt"
```

**argv-placeholder** (e.g. `codex`): `{prompt}` in exactly one arg is replaced
by the composed prompt. `stdin = "null"` is required or codex blocks.

```toml
[[agents]]
id = "codex"
adapter = "codex"
model = "gpt-5.6-sol"
role = "critic"
[agents.command]
executable = "codex"
args = ["exec", "--skip-git-repo-check", "{prompt}"]
stdin = "null"
```

Rules enforced at config load: `{prompt}` may appear in at most one arg and
not together with `stdin = "prompt"`; unknown `{placeholders}` are rejected;
agent ids must be unique. In `team.toml`, set `[defaults] timeout_ms = 100000`
for omp (its ~110s practical ceiling) — see `examples/team.toml`.

## Commands

- `team init [--force]` — scaffold `team.toml`, `echo-agent.ts`, `example.md`
- `team doctor [--live]` — validate config, probe each binary (`--version`), print resolved argv; `--live` spawns a one-word ping
- `team tasks` — list tasks with state and round progress
- `team ask [--agents a,b] <prompt>` — fan one prompt out to N agents, one round
- `team workshop <artifact.md> [--rounds 1|2] [--agents a,b]` — bounded review; ends in `awaiting_decision`
- `team workshop --resume <task-id>` — continue from last completed round; finished runs are never respawned
- `team arbitrate <task-id>` — interactive pick, or non-interactive `--accept <event-id>` / `--reject <event-id>` / `--merge <id1,id2>` / `--defer`, with optional `--rationale "..."`
- `team verdict <task-id> good|bad|mixed [note]` — record the realized outcome to the task + taste log
- `team chat --agents a,b --topic "..."` — pairwise dialogue; `--resume <task-id>` re-prompts the last committed actor. With `kind = "bus"` agents it provisions a relay channel and starts the auditor instead
- `team bus-serve [--port 8787] [--data-dir dir]` — the message-bus relay. With no `--data-dir` it is in-memory (development); with `--data-dir` channels, token hashes, and the message log persist to `<dir>/relay.sqlite` and survive restarts (the Fly deployment runs this way)
- `team join --from-claim-url <url> [--state-dir dir]` — redeem a one-time claim URL; persists `bus.credentials.json` (0600) with the token, channel secret, and the provisioned peer id
- `team export <task-id> [--out path]` — deterministic JSON bundle: inputs, events, decisions, run metrics

Global flags: `--json` (machine-readable output on every command),
`--print-prompt` (dry-run the composed prompts on `ask`/`workshop` without
spawning), `--config <path>` (default `./team.toml`).

## Agent output contract

Agents return results in stdout envelopes — see `SKILL.md` for the full
contract. Malformed output is never dropped: no `TEAM_RESULT_V1` → last fenced
`` ```post `` block → whole stdout flagged `unstructured: true`. Turn bodies
are escaped so `<<<TEAM_` markers in agent output can't forge envelopes.

## Development

```sh
bun test        # tests/ — config, envelopes, blackboard, budgets, resume, bus
```

See `DESIGN.md` for the architecture and what was deliberately cut.

## License

Apache-2.0 — see `LICENSE`.
