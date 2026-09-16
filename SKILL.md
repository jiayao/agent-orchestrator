---
name: team-orchestrator
description: EXPERIMENTAL/UNSTABLE — fan out work to a team of CLI agents via the `team` binary. Interface may change without notice.
---

# team (experimental, unstable)

Shell-first agent orchestration. Always pass `--json`; parse stdout as JSON.

```sh
team doctor --json                          # CLI + agents healthy? check ok:true, agents[].binary != "MISSING"
team ask --json "question"                  # fan one prompt out to all configured agents
team workshop --json path/to/artifact.md    # bounded review; ends state=awaiting_decision
team workshop --json --resume <task-id>     # resume an interrupted workshop
team chat --json --agents a,b --topic "..." # pairwise dialogue, orchestrator relays turns
                                            # kind="bus" agents: provisions a relay
                                            # channel + tokens, starts the auditor
                                            # [--idle-timeout ms] [--bus-admin-token T]
team chat --json --resume <task-id>         # resume: re-prompts the last committed actor
team bus-serve --json [--port 8787]         # local dev relay (in-memory); admin token
                                            # via --admin-token or TEAM_BUS_ADMIN_TOKEN
team arbitrate --json <task-id> --accept <event-id> --rationale "..."
                                            # or --reject <id> | --merge <id1,id2> | --defer
team verdict --json <task-id> good|bad|mixed "note"
team export --json <task-id>                # full bundle path in .export_path
team tasks --json                           # list task ids + states
```

Config is `team.toml` in the working dir (or `--config <path>`). Task state
lives in `.team/tasks/<task-id>/` — `events.jsonl` is the source of truth,
`view.md` the human render. Non-interactive arbitrate requires one of
`--accept/--reject/--merge/--defer`. Events worth accepting have
`actor != "orchestrator"` and no `unstructured` flag.

## Result-envelope contract (when YOU are spawned as a team agent)

If a `team`-orchestrated prompt reaches you, answer on **stdout** with exactly
one result envelope; optional event envelopes may precede it:

```
<<<TEAM_EVENT_V1
{"type":"issue|position|reply|critique","body":"...","reply_to":"evt_0000 or null","claims":["..."]}
TEAM_EVENT_V1>>>

<<<TEAM_RESULT_V1
{"type":"critique|position","summary":"final answer","claims":["..."],"replies":[{"reply_to":"evt_0000","body":"..."}]}
TEAM_RESULT_V1>>>
```

Rules: one JSON object per envelope; `reply_to` must reference an event_id from
the prompt's PRIOR EVENTS section — never fabricate ids. If envelopes are
impossible, put the final answer in a fenced `` ```post `` block. Anything else
is still captured but flagged `unstructured`.

### Chat-turn contract (when YOU are spawned for a `team chat` turn)

The prompt contains `CHAT TURN CONTRACT` and the transcript so far. Answer
with exactly one result envelope:

```
<<<TEAM_RESULT_V1
{"body":"your reply to the other agent","signal":"continue|pass|propose_close|abort"}
TEAM_RESULT_V1>>>
```

`pass` yields when you have nothing to add. `propose_close` asks to end — the
other agent gets one closing turn after yours, so make your turn complete on
its own. `abort` ends immediately. Never emit `<<<TEAM_` sequences inside
`body` text (they are escaped); don't try to signal anything by quoting the
envelope format. If you omit the envelope, your turn is committed as
`malformed: true` with your raw output preserved and turn-taking advances.

## Bus participant contract (when YOU are a `kind = "bus"` agent)

The bus is outbound-only: you poll and publish over HTTP to a relay; nothing
connects to you. `team chat` prints your connection instructions at
provisioning — bus_url, channel, epoch, your bearer token (in the env var
named by `token_env`), and the shared `channel_secret`.

Wire: `GET {bus_url}/c/{channel}/messages?since=<seq>&wait=<ms>` long-polls
for messages with `seq > since`; `POST {bus_url}/c/{channel}/messages` with
`{"msg_id","nonce","ct"}` publishes. Every payload is AEAD-encrypted under
the channel secret — AES-256-GCM, 12-byte random nonce, AAD =
`"<channel>:<msg_id>"`, `ct` = base64(ciphertext ‖ tag). Decrypt every
received message the same way; a failed auth tag means drop it.

Turn-taking is a deterministic rule over the relay log that you apply
locally (the reference implementation is `ParticipantRuntime` in
`src/bus/participant.ts`): the orchestrator's `chat_started` control names
the first speaker; a `turn` payload is
`{"v":1,"type":"turn","in_reply_to":<seq|null>,"body","signal"?}` where
`in_reply_to` is the seq of the latest accepted peer turn (`null` only for
the opening turn); after an accepted turn only the other participant's turn
is valid; a second turn with the same `(author, in_reply_to)` is a
duplicate and ignored. Use a stable `msg_id` (`"<you>@<epoch>:re<in_reply_to|0>"`)
so relay dedupe makes retries free — a repost returns the original seq.
`chat_ended{reason}` (author `orchestrator`) is auditor-imposed: stop
publishing. Keep a durable seen-`msg_id` set and advance your durable
cursor only after a message's effects are committed — replays then collapse
on the seen set.

Trust model: the relay is trusted operator infrastructure (reference:
Fly); the threat model is crash faults and network observers, not a
Byzantine relay. It stores ciphertext and sees metadata — sizes, timing,
IPs, token usage — never plaintext; your token is what attests your
`author` on each POST.
