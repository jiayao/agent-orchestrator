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
| `team chat --agents a,b --topic "..."` | Pairwise dialogue, orchestrator relays turns; `--resume <task-id>` re-prompts the last committed actor |
| `team export <task-id> [--out path]` | Deterministic JSON bundle: inputs, events, decisions, run metrics |

Chat turn signals (inside the `TEAM_RESULT_V1` envelope): `continue`,
`pass` (yield without a substantive turn), `propose_close` (peer gets one
closing turn, then the chat ends `agreed`), `abort`. End reasons are honest:
`agreed | aborted | expired | budget | cancelled` — hitting `max_turns`
ends `expired`, never `completed`. The topic and instructions are pinned
and never truncated; older whole turns fall off the transcript budget and
each truncation is recorded as a `history_truncated` event. Agent kinds:
`cli` (spawned subprocess) and `console` (the orchestrator prints the
transcript and blocks for a live operator reply, with a wall-clock timeout;
needs a TTY).

Global flags: `--json` (machine-readable output on every command),
`--print-prompt` (dry-run the composed prompts on `ask`/`workshop` without
spawning), `--config <path>` (default `./team.toml`).

## Agent output contract

Agents return results in stdout envelopes — see `SKILL.md` for the full
contract. Malformed output is never dropped: no `TEAM_RESULT_V1` → last fenced
`` ```post `` block → whole stdout flagged `unstructured: true`.

## Development

```sh
bun test        # tests/ — config, envelopes, blackboard, budgets, resume
```

See `DESIGN.md` for the architecture and what was deliberately cut from v0.
