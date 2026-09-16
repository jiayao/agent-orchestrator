# team — local-first agent orchestration (v0)

One binary that hands an artifact to a team of CLI agents, runs a bounded
review (critique round → cross-review round), lets you arbitrate the result,
and records a verdict on whether the decision held up. No daemon, no server —
state lives in `.team/tasks/<task-id>/` next to your `team.toml`.

## Install

Requires [Bun](https://bun.sh) ≥ 1.3.

```sh
# run from source
bun run dev -- <command>          # e.g. bun run dev -- doctor

# or build the compiled binary
bun run build                     # writes ./team
./team doctor
```

## Configure

```sh
team init          # writes team.toml + echo-agent.ts + example.md
team doctor        # validate config, probe binaries, print resolved argv
```

`team.toml` defines agents, their spawn profile, roles, and budgets. The
scaffolded file (see `examples/team.toml`) ships with two mock `echo` agents
that need zero auth — the demo harness and the test fixture.

## Try it end to end (mock agents)

```sh
team init                          # in a scratch dir
team doctor
team workshop example.md           # 2 rounds: critique → cross-review
team tasks                         # find the task id
team arbitrate <task-id> --accept <event-id> --rationale "best critique"
team verdict <task-id> good "held up in review"
team export <task-id>              # deterministic bundle → .team/tasks/<id>/export.json
```

Every artifact lives under `.team/tasks/<task-id>/`: `events.jsonl`
(append-only source of truth), `view.md` (rendered for humans), `runs/`
(per-run request, prompt, stdout, stderr, result), `decision.md`.

## Configure real agents

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

| Command | What it does |
|---|---|
| `team init [--force]` | Scaffold `team.toml`, `echo-agent.ts`, `example.md` |
| `team doctor [--live]` | Validate config, probe each binary (`--version`), print resolved argv; `--live` spawns a one-word ping |
| `team tasks` | List tasks with state and round progress |
| `team ask [--agents a,b] <prompt>` | Fan one prompt out to N agents, one round |
| `team workshop <artifact.md> [--rounds 1\|2] [--agents a,b]` | Bounded review; ends in `awaiting_decision` |
| `team workshop --resume <task-id>` | Continue from last completed round; finished runs are never respawned |
| `team arbitrate <task-id>` | Interactive pick, or non-interactive `--accept <event-id>` / `--reject <event-id>` / `--merge <id1,id2>` / `--defer`, with optional `--rationale "..."` |
| `team verdict <task-id> good\|bad\|mixed [note]` | Record the realized outcome to the task + taste log |
| `team chat --agents a,b --topic "..."` | Pairwise dialogue, orchestrator relays turns; `--resume <task-id>` re-prompts the last committed actor. With `kind = "bus"` agents it provisions a relay channel and starts the auditor instead |
| `team bus-serve [--port 8787]` | Local in-memory message-bus relay for development (`team chat` against `kind = "bus"` agents) |
| `team export <task-id> [--out path]` | Deterministic JSON bundle: inputs, events, decisions, run metrics |

Chat turn signals (inside the `TEAM_RESULT_V1` envelope): `continue`,
`pass` (yield without a substantive turn), `propose_close` (peer gets one
closing turn, then the chat ends `agreed`), `abort`. End reasons are honest:
`agreed | aborted | expired | budget | cancelled` — hitting `max_turns`
ends `expired`, never `completed`. The topic and instructions are pinned
and never truncated; older whole turns fall off the transcript budget and
each truncation is recorded as a `history_truncated` event. Agent kinds:
`cli` (spawned subprocess), `console` (the orchestrator prints the
transcript and blocks for a live operator reply, with a wall-clock timeout;
needs a TTY), and `bus` (a peer on an outbound-only message bus — see
"Message bus (v0.2)" below).

Global flags: `--json` (machine-readable output on every command),
`--print-prompt` (dry-run the composed prompts on `ask`/`workshop` without
spawning), `--config <path>` (default `./team.toml`).

## Message bus (v0.2)

The bus is for agents that cannot accept inbound connections: every party —
both participants and the auditor — only ever makes outbound requests to a
relay. `team chat --agents a,b` with two `kind = "bus"` agents provisions a
channel, prints connection instructions per side, and runs the auditor.

Agent config:

```toml
[[agents]]
id = "grok"
kind = "bus"
bus_url = "https://relay.example.com"   # the relay this agent can reach
channel = "chat-001"                    # optional pinned channel
token_env = "TEAM_BUS_TOKEN_GROK"       # env var holding this agent's bearer token
```

Development relay:

```sh
team bus-serve --port 8787              # in-memory; restart loses everything
export TEAM_BUS_ADMIN_TOKEN=...         # printed once if not provided
team chat --agents grok,juno --topic "..." --idle-timeout 120000
```

Provisioning mints a random channel id and epoch, one bearer token per
participant (plus the auditor's `orchestrator` token), and the shared
channel secret; registers the channel over the relay's admin API; writes
secrets to `.team/tasks/<id>/bus.secret.json` (mode 0600, never in
`meta.json`); and prints per-side connection instructions — everything a
participant needs to talk on the wire.

Relay endpoints (bearer auth; `POST /admin/*` takes the admin token):

- `POST /admin/channels` — provision `{channel, epoch, tokens: {author: token}}`; requires an `orchestrator` author.
- `DELETE /admin/channels/<channel>/tokens/<author>` — revoke a participant.
- `POST /c/<channel>/messages` — publish `{msg_id, nonce, ct}`; `author` is attested from the token. Retried `msg_id` returns the original `seq` (`deduped: true`) and never appends twice.
- `GET /c/<channel>/messages?since=<seq>&wait=<ms>` — long-poll; returns `{messages, latest}` with `seq` greater than `since`.
- `POST /c/<channel>/auditor` — take the auditor lease; one per channel, a second author gets 409.

On the wire, `ct` is the turn payload AEAD-encrypted under the channel
secret (AES-256-GCM, random nonce, AAD `"<channel>:<msg_id>"`). Turn-taking
is a deterministic rule every party applies to the log: the auditor's
opening control names the first speaker, each turn carries `in_reply_to`
(the seq of the peer turn it answers), and after an accepted turn only the
other participant's turn is valid — duplicates collapse on
`(author, in_reply_to)`. The auditor commits `bus_raw` records for
everything relayed and `turn` events only for accepted turns; only accepted
turns drive budgets, history, and end reasons. The auditor owns the idle
deadline and imposes termination — `chat_ended` is always published by the
auditor, with control msg_ids deterministic from
`{channel_epoch, terminal_seq, reason}` so a restarted auditor's re-publish
is a harmless duplicate. There is no cursor file: the auditor's cursor is
the max committed relay seq in `events.jsonl`.

Trust model: the relay is trusted operator infrastructure you run yourself
(the reference deployment is Fly) — trusted the way any server you operate
is trusted, not trusted to be honest under attack. The threat model is
crash faults and network observers, not a Byzantine relay. Message bodies
are AEAD-encrypted under the channel secret, so the relay stores ciphertext
and observes metadata — message sizes, timing, source IPs, which tokens
authenticate — while it attests authorship, assigns sequence numbers, and
enforces the single auditor lease. Anyone holding the channel secret reads
every message on the channel; anyone holding a participant token writes as
that participant.

## Agent output contract

Agents return results in stdout envelopes — see `SKILL.md` for the full
contract. Malformed output is never dropped: no `TEAM_RESULT_V1` → last fenced
`` ```post `` block → whole stdout flagged `unstructured: true`.

## Development

```sh
bun test        # tests/ — config, envelopes, blackboard, budgets, resume
```

See `DESIGN.md` for the architecture and what was deliberately cut from v0.
