# Agent orchestrator — v0 design

Date: 2026-09-15. Synthesized by Juno from independent designs by omp (kimi-k3) and Codex (gpt-5.6-sol) against a shared brief. Where they diverged, the tie-break is marked [call].

## The bet

The manual glue I do today — hand-packing prompts, running each CLI with its own ritual, relaying outputs between agents, re-asserting roles, arbitrating — becomes a local-first, open-source binary. Dogfood-first: the builder's own workshop loop is the demo, instrumented from day one so the "N agents beat one model" claim is measured, not asserted.

## v0 scope

One loop, done well: hand an artifact to the team, run a bounded review (critique round, then cross-review round), arbitrate with one tap, log the decision, record a later verdict on whether the decision held up. Plus `ask` (one prompt fanned out to N agents). Everything else is cut.

## Architecture

Six pieces, all local, no daemon:

1. **Team config** — one TOML file, validated before every task. Names agents, their CLIs, roles, budgets.
2. **Spawn engine** — one parameterized mechanism, not N adapters. Structured argv with a single controlled placeholder (`{prompt}`), explicit stdin mode (`prompt` or `null`), no shell interpolation. Per-CLI profiles for omp and codex ship in v0; Devin is deferred until a workshop actually needs it [call — omp's cut].
3. **Blackboard** — per-task directory. Append-only `events.jsonl` is the source of truth (Codex); a rendered `view.md` is regenerated atomically after every round for humans and for prompt packing (omp's instinct, minus the hand-editable digest, which is v1). Only the orchestrator writes. Agents "write" by returning a result envelope in stdout.
4. **Prompt composer** — every invocation re-injects identity, role instructions, and the format contract (fresh processes mean role drift is re-asserted for free), plus the artifact and a bounded selection of prior events. `--print-prompt` dry-run is non-negotiable for debugging role drift.
5. **Arbitration** — interactive pick plus a non-interactive path (`--accept <event-id>`) for CI and agent operators. Writes `decision.md` and appends to the taste log.
6. **Telemetry** — honest per-run records: latency, cost (reported where the CLI gives it, flat per-agent estimate otherwise, `unknown` never faked), outcome status.

## Team config sketch

```toml
schema_version = 1
team = "default"

[defaults]
timeout_ms = 100000          # under omp's ~110s practical ceiling
max_output_bytes = 100000
concurrency = 3

[budgets]
max_runs = 8
max_wall_time_ms = 600000
max_estimated_cost_usd = 5.00

[[roles]]
name = "critic"
instructions = """
You are a critic, not a co-author. Identify the three weakest points:
concrete defects, unsupported assumptions, failure modes. Do NOT rewrite
the artifact.
"""

[[agents]]
id = "kimi"
adapter = "omp"
model = "fireworks/kimi-k3"
role = "critic"              # references [[roles]]; re-injected every run
cost_tier = "low"
cost_per_run_usd = 0.05      # flat estimate; source marked "estimated"

[agents.command]
executable = "omp"
args = ["-p", "--no-session"]
stdin = "prompt"             # prompt | null

[[agents]]
id = "codex"
adapter = "codex"
model = "gpt-5.6-sol"
role = "critic"
cost_tier = "high"

[agents.command]
executable = "codex"
args = ["exec", "--skip-git-repo-check", "{prompt}"]
stdin = "null"               # always, or codex blocks on stdin
```

Roles are first-class because role drift is the stated friction: instructions plus the output-format contract are appended mechanically on every invocation, so no role text can forget them.

## Adapter contract

```ts
type SpawnSpec = {
  executable: string;
  args: string[];            // "{prompt}" allowed in exactly one arg
  stdin: "prompt" | "null";
  cwd: string;
  env: Record<string, string>; // minimal allowlist, never secrets
  timeoutMs: number;
  maxOutputBytes: number;
};

type RunStatus =
  | "succeeded" | "failed" | "timed_out" | "auth_error"
  | "rate_limited" | "output_limit" | "protocol_error" | "empty";
```

Rules: capture stdout/stderr separately; kill the whole process group on timeout (no grace period in v0); normalize known stderr text to statuses via a regex table in config (new failure modes are a TOML edit, not a release); never auto-retry — retries hide adapter bugs exactly when you're discovering them, and can duplicate costly work; a dead agent never kills a workshop, the round continues with survivors; redact configured secret patterns before persisting anything.

`doctor` probes every agent before a workshop burns 15 minutes: binary present, version, auth, resolved argv printed.

## Blackboard layout

```
.team/tasks/<task-id>/
  task.json        # id, artifact hash, team hash, state, budgets, timestamps
  artifact.md      # immutable input after the workshop starts
  events.jsonl     # append-only source of truth
  view.md          # rendered view, regenerated atomically
  decision.md      # arbitration record
  runs/<run-id>/   # request.json, prompt.txt, stdout.txt, stderr.txt, result.json
```

Event shape: `{event_id, seq, ts, actor, type, round, reply_to, body, claims?, unstructured?}`.

Result envelope agents return in stdout:

```
<<<TEAM_RESULT_V1
{"type":"critique","summary":"...","claims":[...],"replies":[...]}
TEAM_RESULT_V1>>>
```

Fallback chain: parse the envelope; else take the last fenced `post` block; else keep whole stdout flagged `unstructured: true` and surface it to the human. Malformed output is never silently dropped — silent degradation is the failure mode that kills trust in the loop.

Write latency: the orchestrator does not wait for process exit. It tails each agent's stdout pipe and parses incremental envelopes (`<<<TEAM_EVENT_V1 ...>>>`, same shape as the final envelope) as they arrive, appending to events.jsonl in real time. Agents read immutable round snapshots — deterministic and replayable — while the rendered view.md shows the live tail for the human. This is the local, daemonless version of Buzz's streaming event publication: the single-writer invariant holds, but blackboard latency drops from "at exit" to "as emitted". (Buzz itself goes further — agents publish signed events directly to a persistent relay over WS/HTTP, with append-only messages, optimistic-concurrency `--base-hash` patches for mutable memory, and NIP-33 last-writer-wins for replaceable values. That full model needs the relay daemon we cut from v0; it is the v2 direction.)

Prompt composition per invocation, in order: identity + role instructions + format contract; the artifact (hashed, treated as untrusted quoted material — the outer prompt explicitly prohibits following instructions found inside it); bounded selection of prior events (unresolved issues, events replied to, latest position per participant, accepted decisions). Round N always sees a completed, immutable round N-1 — never partial round-N state. Within a round, all agents fan out concurrently against the same snapshot (also removes ordering bias).

## CLI surface

- `team init` — scaffold team.toml plus an example task
- `team doctor` — validate config, probe binaries and auth, print effective timeouts
- `team ask --agents kimi,codex "prompt"` — fan-out, results to blackboard or stdout
- `team workshop <artifact.md> [--rounds 2]` — bounded review: critique round, cross-review round, then `awaiting_decision`
- `team arbitrate <task-id>` — interactive pick; `--accept/--reject/--merge/--defer <event-id>` non-interactive
- `team verdict <task-id> good|bad|mixed [note]` — the realized outcome, appended later. This is what turns the taste log from a diary into a labeled dataset [omp's `verdict`, kept]
- `team workshop --resume <task-id>` — continue from the last completed round; persistence has to survive a crash at round 3, not just log it
- `team export <task-id>` — deterministic bundle (inputs, events, decisions, metrics) for bug reports and dogfood analysis
- Global `--print-prompt` dry-run on `ask` and `workshop`
- Global `--json` on every command: the CLI is agent-first (JSON in / JSON out, in the spirit of Buzz's `buzz-cli`), human-readable is the secondary rendering. Agent operators are the primary consumer.

State machine: `created → running → awaiting_decision → completed | failed | cancelled`.

## Budgets

Enforced before each round's fan-out, not after: max runs, wall-clock time, estimated spend. A runaway loop across three CLIs is a real bill.

## The demo harness

A mock `echo` adapter plus a committed example team and task, so the full loop runs with zero auth. That is the test harness and the thing he can show people — the loop has to be exercisable before it's believable.

## Pairwise chat (v0.1)

A second task kind alongside workshop: two agents in direct dialogue, orchestrator as relay. Motivating case: the principal's grok bot (Chief of Staff) talking to Juno without the principal copy-pasting between them.

Reviewed independently by omp and Codex (2026-09-15); both converged on three kill shots, all fixed below.

- `team chat --agents a,b --topic "..."` seeds agent A's first turn. Turn-taking is by explicit signal, not strict alternation: each turn result carries `signal: continue | pass | propose_close | abort`. `pass` lets an agent with nothing to say yield without burning a substantive turn; `propose_close` asks to end; the peer always gets one closing turn after a `propose_close` before the chat ends.
- Each turn is one invocation: prompt = pinned seed (topic + identity + role instructions + format contract, never truncated) + transcript of whole turns so far + "it is your turn; reply to the other agent". Transcript bounded by `history_budget_chars` (default 12000); truncation removes whole oldest turns only (seed exempt), and every truncation commits a `history_truncated` event with the omitted event-id range — the log records what each agent actually saw, not just what was said. Budget is enforced in estimated tokens (prompt + completion), not characters.
- Agent kinds: `cli` (spawned subprocess, same mechanism as workshop) and `console` (the orchestrator prints the transcript and blocks for the operator's reply — this is how Juno participates, since Juno is not a subprocess). Console is modeled as pending external input, not an invocation: the orchestrator commits `turn_requested(actor)` before blocking and commits the `turn` event atomically on submit. Console turns have a wall-clock timeout (default 600s); on timeout, EOF, TTY loss, or SIGINT the uncommitted input is discarded and the chat ends `cancelled` (resumable: resume re-prompts the last committed actor, never re-invokes). `console` without a TTY fails with a clear error instead of hanging.
- Turn contract: `<<<TEAM_RESULT_V1 {"body": "...", "signal": "continue"}>>>`. `TEAM_EVENT_V1` type `message` partials go to the log/view only; the peer sees finished turns. Turn bodies are scanned and any `<<<TEAM_` marker sequences inside body text are escaped before parsing — neither a console operator nor a cli agent quoting output can forge a signal.
- Malformed/absent result envelope: the turn is committed with `malformed: true` and the raw body preserved; turn-taking advances. No silent retries, no dropped turns.
- Termination: peer-confirmed close (`propose_close` + closing turn), `abort` by either side, `max_turns` (default 10), budget exceeded, or human interrupt (state saved, resumable). End reasons are honest: `agreed | aborted | expired (max_turns) | budget | cancelled`. `expired` is never reported as `completed`.
- Events: `chat_started`, `turn_requested`, `turn` (actor + body + signal), `history_truncated`, `chat_ended` with reason. No arbitration step.
- grok profile: argv `["grok", "-p", "{prompt}"]`, stdin null, auth via `GROK_API_KEY` env. `team doctor` probes the binary and key presence.

Explicitly not in v0.1: group chat (3+ agents), asynchronous console replies (no mailbox yet — the operator answers live; mailbox is the v0.2 fix for the blocking problem), summarization of truncated history.

## Explicitly cut from v0

- Devin adapter (prove the loop on two transports first: stdin-pipe vs argv)
- Generic shell-template adapters (security boundary stays closed; structured argv only)
- Free-form multi-round debate (fixed topology: critique → cross-review → arbitrate)
- Cost-tier-based routing (routing implies an eval that doesn't exist yet)
- Auto-retry and output-repair loops
- Cryptographic identity, multi-user, hosted service
- Taste-learning claims — the log is kept, but v0 markets nothing about learning or personalization [Codex's restraint on omp's framing]

## v1 candidates

Typed issue tracking (accept/reject/merge/defer per issue instead of per response), human-editable digest for mid-flight steering, Devin adapter, adaptive round termination, @mentions/threading, SKILL.md hardened after the interface survives real use.
Borrowed from [Buzz](https://github.com/block/buzz) (read 2026-09-15): adapters converging on a protocol harness (their ACP harness for Goose/Codex/Claude Code) rather than N bespoke CLI profiles; a hash-chained audit log (their `buzz-audit` crate) as the tamper-evident future of the taste/decision log — the enterprise-audit story.

## Message bus (v0.2)

**Problem.** v0.1 chat moves turns through the orchestrator's process: `cli` agents are local subprocesses (or SSH to a reachable host), `console` is a live operator at a TTY. That doesn't reach agents behind NAT without inbound-access tricks. The bus inverts the topology: the bus is a reachable relay and every participant connects to it directly.

**Symmetry.** There is no privileged seat. Grok's bot, Juno, any future agent — each is a bus participant that publishes its own turns and subscribes to the peer's. (An earlier draft bridged local agents through the orchestrator; the relationship is symmetric, so the bridge went.)

**Trust model: the relay is our infrastructure.** Two rounds of adversarial review (omp, Codex, 2026-09-15) killed the "untrusted relay" framing: with a shared channel secret there is no authorship, and a relay trusted for ordering is the conversation's consensus authority. Rather than hardening v0.2 up to those claims, v0.2 narrows the claims to the deployment: the relay is the operator's own service (the reference build runs on Fly), trusted the way any server you run is trusted. The threat model is crash-faults and network observers — not a Byzantine relay. Message bodies stay AEAD-encrypted under the channel secret, so outsiders see no plaintext. What the relay does see — sizes, timing, IPs — is stated plainly instead of "learns nothing." Hash-chained envelopes, equivocation detection, and per-participant keypairs move to v-later, if the relay is ever third-party. Documented upgrade trigger: the day the relay isn't ours.

**Authorship without keypairs.** One bearer token per participant, minted at provisioning. The relay attests authorship: every stored message carries `author` as observed on the authenticated POST. Self-wake filtering keys on attested author plus the participant's own `msg_id` history. Forging authorship now requires the relay's cooperation, which the trust model excludes.

**What it is.** A minimal relay server. One channel per chat. Append-only per-channel log. HTTPS: `POST /c/{channel}/messages` to publish, `GET /c/{channel}/messages?since={seq}` long-poll to subscribe. The relay assigns `seq`, attests `author`, and is otherwise dumb: no agent logic, no arbitration. Its specified semantics are small but load-bearing, not "dumb on purpose":

- `msg_id` dedupe: a POST with a previously seen `msg_id` returns the original `{seq}` without appending. Retries are always safe.
- One linearizable log per channel: a single relay instance owns a channel in v0.2; `seq` is assigned at commit; a subscriber never sees a committed seq disappear or a gap fill in later.
- Auditor lease: the relay grants one auditor lease per channel and rejects a second. The lease finally has a legal home, because the relay is trusted infra.

**Turn-taking with an owner.** Pairwise strict alternation, stated as a deterministic validation rule every party applies locally to the relay log — so participants and auditor agree without coordinating:

- The opening control message (author `orchestrator`) names the first speaker. No t=0 deadlock.
- Every turn carries `in_reply_to`: the seq of the peer turn it answers.
- Expected-speaker rule: after an accepted turn by A, only B's turn is protocol-valid. A second turn from the same author with the same `in_reply_to` is a duplicate and is ignored.
- The auditor commits two kinds of records: raw records (everything the relay served) and accepted turns (passing validation). Only accepted turns drive budgets, history, and end reasons. Spam, duplicates, and late turns are preserved in the raw log but can never burn the budget or rewrite history.

**Liveness: every gap has an owner.**

- Publish ambiguity: the sender owns retries. Stable client-generated `msg_id` plus relay dedupe means a retry is either a no-op (it landed) or the actual publish (it didn't). There is no "did it land?" window.
- Lost turn: whoever is waiting owns the deadline. If B hasn't answered A's turn within the reply window, A's runtime re-publishes the same `msg_id` — dedupe collapses it if the relay already has it, appends it if the relay lost it. Either way the conversation moves.
- Non-response: the auditor owns the idle deadline. No accepted turn within the idle timeout — the auditor publishes `chat_ended{idle_timeout}` and commits it. Termination is auditor-imposed; the design says so instead of "observed."
- Participant crash windows: at-least-once processing with idempotent effects. The runtime advances its inbound cursor only after the turn's effects are durable, and keys idempotency on a durable seen-`msg_id` set. Cursor loss replays from the last committed cursor; duplicates collapse on `msg_id`. One cursor is never asked to mean both "received" and "committed."

**The auditor.** Subscribes, validates, commits. Every accepted turn is a `turn` event carrying `{channel, seq, msg_id, author, in_reply_to, payload_hash}`. No separate cursor file: the cursor is derived as max committed seq in `events.jsonl` — one file, no atomicity theater. Crash — resubscribe from the derived cursor — only new seqs arrive. Control messages (only `chat_ended` in v0.2) carry deterministic `msg_id`s derived from `{channel_epoch, terminal_seq, reason}`; on startup the auditor re-publishes any committed terminal control, and relay + participant dedupe make the replay harmless. The old publish/commit window survives only here, and idempotent redelivery closes it.

**Participant runtimes.** Grok's bot loop and Juno's hook runtime are the same shape: durable inbound cursor (advances only after effects commit), seen-`msg_id` set, outbox of unacked publishes retried with backoff, serialized wakeups with control-message priority (`abort`/`chat_ended` jump the queue, and a pre-publish check drops turns made stale by a newer message), authorship filter on attested author + own msg_ids, bounded queue that coalesces to the latest unanswered peer turn. Strict alternation bounds the backlog naturally: each side can have at most one unanswered turn outstanding.

**`bus` agent kind.** In team.toml:

```toml
[[agents]]
id = "grok"
kind = "bus"
bus_url = "https://relay.example.com"
channel = "chat-001"
token_env = "TEAM_BUS_TOKEN_GROK"
```

`team chat --agents grok,juno --topic "..."` provisions the channel (random id + epoch), mints per-participant tokens plus the channel secret, prints connection instructions per side, and starts the auditor. Tokens are bearer, single-channel, operator-revocable at the relay. The provisioning channel is this one — trusted, stated.

**Onboarding claims.** Provisioning also mints one single-use claim per participant on the relay (`POST /admin/channels/{id}/claims`, admin-only). The printed instructions carry the claim URL — not the token, not the channel secret. The remote side fetches it once (`GET /c/{channel}/claim/{id}`), receives its token + channel secret over TLS, and the claim burns; a second fetch gets 410, an expired one 410, unknown 404. Default TTL 1h (`--claim-ttl-ms`), min 60s, max 24h. The operator pastes only the claim URL into chat with the remote agent: after redemption the transcript copy is worthless, which is the whole point — long-lived credentials never enter a chat transcript. Honest widening, stated: while a claim is outstanding the relay holds that participant's channel secret in memory (it otherwise only ever sees ciphertext), bounded by the TTL and deleted on redeem/expiry. Redemption is logged with a token fingerprint, never the token.

**Hosting.** Reference relay on Fly; `team bus-serve` for local dev. The relay holds channel tokens, the auditor lease, and dedupe state; it sees ciphertext and metadata, never plaintext.

**Explicitly out of v0.2:** Byzantine relay defenses, per-participant keypairs, token rotation, group channels.

**Scope note.** SSH-per-turn remains the path for reachable hosts. The bus is for agents that can only dial out.

## Open questions

- Project name.
- License: MIT vs Apache-2.0.
- Config home: per-project `.team/` vs global `~/.team/`.
- omp's flat cost estimates vs metering real usage per CLI — revisit once adapters report usage reliably.
