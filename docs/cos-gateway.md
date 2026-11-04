# CoS OpenAI-compatible gateway

The gateway is compiled into the CoS main process (`src/main/openai-gateway/`) and
serves an OpenAI-compatible surface on `0.0.0.0:8793` (env `PORT`). It talks to CoS
in-process through `internals.ts`, never through the loopback control API. This page
records the wire contract; the code and `test/cos-gateway/` are the authority.

- `GET /health` — open, no key; process liveness for deploy tooling.
- `GET /v1/status` — sign-in evidence and catalog state.
- `GET /v1/handles` — per-handle status, readiness evidence and catalog facts.
- `GET /v1/models` — the account-observed catalog as an OpenAI model list.
- `GET /v1/conversations` — read-only page of this instance's conversations.
- `GET /v1/conversations/{id}/turns` — read-only page of one conversation's turns.
- `POST /v1/conversations/{id}/turns/{turnId}/stop` — interrupt an in-flight turn.
- `GET /v1/errors` — the published failure contract a pool in front decides on.
- `POST /v1/chat/completions` — one CoS turn, answered whole (JSON) or streamed (SSE).

Every `/v1/*` route needs `Authorization: Bearer $GATEWAY_API_KEY`. With the key
unset the server still starts and refuses `/v1/*` with `503` (fail closed).

## Completion request

`messages`, optional `model`, `reasoning_effort`, `include_system`, and `stream`.
The conversation is folded from `messages` (plus `x-cos-session` when the caller
names a session); a repeated conversation re-attaches to a turn that is still
running instead of sending a second message.

Only the literal JSON boolean `stream: true` selects SSE. Any other value
(`"yes"`, `1`, absent) answers the whole JSON completion, so an existing caller
cannot change behavior by accident.

## Tool and function calls are UNSUPPORTED

CoS keeps model execution in ChatGPT's own conversation, and no CoS source
contract verifies a tool-call round trip. Tool/function calls are therefore
documented as **unsupported**, not simulated: a non-empty `tools` or `functions`
array, or a `tool_choice`/`function_call` other than absent, `null` or `"none"`,
answers `400 tools_unsupported`. An empty `tools: []` is accepted (it means the
caller sent no tools), and a present non-array is `400 invalid_body`. The check
runs right after JSON parsing, before handle identity, readiness or the catalog,
so the same answer never depends on which account a request names. A client must
never believe a tool call was honored and then act on a hallucinated invocation.

## Listing (read-only)

`GET /v1/conversations` and `GET /v1/conversations/{id}/turns` read what this
instance already recorded in the H-043 state store. They never resolve a CoS
session, send a message, open a browser or mutate state; there is deliberately no
browser-action endpoint. The one mutating turn route is the stop below; it
interrupts only this process's follow and never drives the browser. The
conversation id is the stored conversation key (URL-encoded
in the turn route), and timestamps are epoch seconds.

A conversation page lists `id`, `object: "conversation"`, `session`,
`sent_users`, `turn_seq`, `updated_at` and `in_flight` (`turn_id` +
`started_at`, or `null`). A turn page lists `id`, `object: "turn"`,
`conversation`, `seq`, `session`, `native_turn_id`, `state`, `started_at`,
`finished_at`, `attempts` and `last_error`.

Both are keyset-paginated, never offset: conversations are ordered by
conversation key, turns by `(seq, started_at, turn_id)`. `limit` defaults to 20
for conversations (max 100) and 50 for turns (max 200); anything else is
`400 invalid_body`. `next_cursor` is opaque and `null` on the last page; a cursor
this gateway did not issue is `400 invalid_cursor` rather than a silent restart.
Unknown query parameters are ignored.

Scope matches `POST /v1/chat/completions`: a handle-scoped instance publishes only
`cos:<handle>:` conversations, and a single-account instance only keys with no
handle prefix. A conversation outside the scope is a `404 not_found` for the turn
route, indistinguishable from a missing one, so a listing can never enumerate
another account's conversations.

## Stopping a turn

`POST /v1/conversations/{id}/turns/{turnId}/stop` interrupts an in-flight turn
and records the terminal `stopped` state. It is the only mutating store route
besides a completion, and it never asks CoS to stop anything: it ends this
process's follow, and the ChatGPT conversation keeps the answer CoS is recording.

- **in flight** — signals the follower (the streaming or whole-answer request
  waiting on that turn), records `state: "stopped"` on the turn row, mirrors the
  outbox row to `cancelled`, clears the in-flight slot and consumes the
  sequence. The follower aborts at its next poll: a stream ends with one
  `data: {"error": {"code": "turn_stopped", …}}` frame and **without** `[DONE]`,
  and a whole-answer request answers `409 turn_stopped`. The stop is checked
  before every read and again before the answer is committed, so an answer that
  became readable after the stop cannot revive the turn.
- **already terminal** — a no-op returning the recorded turn. A repeated stop
  never rewrites the state and never consumes another sequence.

The response is the turn view (`object: "turn"`, `state`, `started_at`,
`finished_at`, …) plus `changed`: `true` when this call stopped the turn,
`false` when it was already terminal.

Scope and errors match the turn listing: a conversation outside this instance's
scope is never revealed. A key whose prefix names another handle this deployment
defines is a deliberate cross-account attempt (`409 cross_handle_session`); any
other foreign or unknown key, an unknown conversation and an unknown turn id in a
known conversation are all `404 not_found`. The route needs the same
`Authorization: Bearer $GATEWAY_API_KEY` as every other `/v1/*` route.

The request following the turn holds the per-conversation lock for its whole
lifetime, so the stop takes no lock: it is one synchronous turn of the event
loop (signal, slot clear, record, persist, wake), and cannot interleave with the
turn it stops. Consuming the sequence also means an identical completion body
after a stop derives a fresh deterministic turn id: it is the next turn, never a
replay or a resumed stopped one.

SEALED has no representation inside this gateway. The SCPM router/provider
enforces it in front, and this route inherits that decision rather than growing a
local flag.

## Per-handle status (`/v1/handles`)

`GET /v1/handles` publishes `object: "list"`, `processing_attested: false` and one
`object: "handle"` row per registry handle. In single-account mode the list is
empty (there is no handle to report).

The local handle carries `handle`, `status`, `ready`, `reason`, the raw
`evidence` it was computed from (`signed_in`, `browser_running`,
`extension_fresh`; `null` when never observed), and a `catalog` block
(`state`, `observed_at`, `age_seconds`, `models` — base ids only, and empty while
the catalog is not ready). Readiness comes from the same live browser evidence
the completions gate uses:

| Status | Meaning |
| --- | --- |
| `ready` | Every live signal is positively true. |
| `not_ready` | One live signal is positively false. |
| `unknown` | A signal was never observed. Unknown is NOT ready. |
| `disabled` | Operator-disabled. |

Another handle is not observable from this process, so its row is
`status: "unknown"`, `ready: false`, all-null evidence, `catalog: null`, and no
account detail at all. No status value here attests that a request was processed
locally; `processing_attested` is always `false`.

## Published failure contract (`/v1/errors`)

`GET /v1/errors` answers `object: "list"`, `contract_version: 1` and one row per
`(code, status)` pair the gateway can answer: `code`, `status`, `class`
(`throttled`, `handle_unavailable`, `terminal`), `may_failover`, `advice` and
`retry_after`. It is derived from both the enforced code→status ledger
(`GATEWAY_ERRORS`) and the failover classifier, so a published row cannot disagree
with either. `advice` is `wait` (429, honor `Retry-After`), `failover` (another
handle may serve it), `reattach` (504, the turn is still running) or `none`; only
a 429 carries `retry_after: true`. `chat_error` publishes two rows (429 and 502)
because a pool's move differs between them. The contract is additive: a new code
is a new ledger row, and `contract_version` changes only if the row shape does.

## Model cards

`GET /v1/models` keeps its OpenAI shape and adds a `capabilities` object per
model: `context_window`, `max_output_tokens`, `reasoning_efforts` and
`tool_calls`. Only values CoS observed are published — the two token figures stay
`null` (unknown, never an estimate), `reasoning_efforts` is what the picker
offered, and `tool_calls` is `false` until a CoS source contract verifies tool
calls.

## Streaming contract (`stream: true`)

Headers, written before the first frame:

```
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

Frames, in order:

1. one `chat.completion.chunk` with `delta: {"role":"assistant","content":""}`;
2. one `chat.completion.chunk` per answer revision, `delta.content` carrying only
   the text this stream has not sent yet. CoS records an answer as revisions under
   one `messageId` (`state: 'streaming'` → `'final'`); a revision that rewrites
   earlier text reports only the suffix, so text is never duplicated or retracted;
3. one `chat.completion.chunk` with an empty delta and `finish_reason: "stop"`;
4. `data: [DONE]`.

Every chunk of one answer shares the same `id`, `created` and `model`.

A failure after the first byte cannot be a status code any more. It is sent as one
`data: {"error": …}` frame (the same error object the JSON path uses) and the
stream ends **without** `[DONE]`, which an OpenAI client treats as a failed stream.

While a streamed turn records nothing (CoS can think for minutes), the gateway
sends an SSE comment frame every `STREAM_HEARTBEAT_SECONDS` (default 15; `0`
disables). Clients ignore comments; proxies see a live socket.

### Cancellation and re-attachment

A client disconnect is detected from the response socket, not from a timeout.
It stops the follower within one poll and:

- leaves the persisted in-flight turn marker exactly as a `504` does (store
  outcome `'timeout'`, re-attachable);
- does **not** call `finishTurn` and never asks CoS to stop the turn. The turn
  belongs to the ChatGPT conversation; stopping it would break re-attachment and
  throw away the answer that is being recorded anyway. An explicit
  `POST .../turns/{turnId}/stop` is the deliberate opposite (see **Stopping a
  turn**): it is a terminal operator choice, not a disconnect.

The next request for the same conversation re-attaches by input id, so the
message is never sent twice and no answer is lost. This is the same path a
timed-out JSON request uses (`cc5aa19` coverage in `test/cos-gateway/turns.test.ts`).

Backpressure is honored: when the socket refuses a write the writer waits for
`drain` before the next frame, so a slow reader bounds this process's buffer
instead of letting an unbounded answer queue in memory.

### Parity with the JSON path

For one completed turn, concatenating the content deltas of a streamed answer
equals the `choices[0].message.content` of the same request answered whole. The
offline suite asserts this on the same recorded revisions.

## Proxy forwarding (SCPM / LiteLLM)

Direct gateway streaming is proven offline (`test/cos-gateway/server.test.ts`,
`test/cos-gateway/stream.test.ts`).

Forwarding of SSE through SCPM's LiteLLM `cos/*` routes is **UNSUPPORTED-by-proxy**
as of this change: it has not been verified, because proving it needs the live
proxy and a live CoS turn. The `no-transform`/`X-Accel-Buffering` headers are sent
so a well-behaved proxy can stream, but that is an intent, not evidence. Until a
live check lands, treat `cos/*` through SCPM as JSON-only and call the gateway
directly for streaming. If the proxy buffers, the stream still completes; it just
arrives in one burst instead of incrementally.

## Per-handle deployment (several accounts)

One CoS process is one ChatGPT account: its browser profile, userData, keyring
and its two ports belong to that account. A **handle** is the operator's alias
for one such instance. Several accounts are several instances joined only by a
handle registry — never by a shared browser profile, userData directory or
keyring, because all three carry the account's cookies.

With no handle configuration (`GATEWAY_HANDLES` and `GATEWAY_HANDLES_FILE` both
unset) the gateway behaves exactly as the single-account descriptions above.

### Registry

`GATEWAY_HANDLES` holds the document inline; `GATEWAY_HANDLES_FILE` names a file
with the same document (preferred at deploy time). Both accept an array or
`{ "handles": [ … ] }`:

```json
{ "handles": [
  { "handle": "work",
    "instance": { "apiPort": 18801, "vncPort": 18811 },
    "browserProfile": "/srv/cos/work/profile",
    "userData": "/srv/cos/work/userdata",
    "keyring": "/srv/cos/work/keyring",
    "account": "work@example.invalid",
    "models": [], "enabled": true, "order": 0 } ] }
```

`handle` is lowercase DNS-ish, 2–32 characters, no leading digit. `models` is a
list of base model ids (empty means whatever that account's own catalog offers);
`order` is the pool order; `enabled: false` disables a handle without removing
it. `account` is the operator-facing label and never leaves the process.

The document is **validated, never repaired**. A rejected registry answers every
`/v1/*` route `503 handle_registry_invalid` and logs the reason once at startup
(the log may name account-bearing paths; the HTTP body never does). Rejected:
a malformed or repeated handle name, a port outside 1–65535, the same API and
VNC port, and any two handles sharing a `browserProfile`, `userData`, `keyring`,
`account` label, or any port (the port space is shared, so one instance's API
port may not equal another's VNC port either). Shared-path comparison ignores
case and duplicated/trailing slashes, so two directories differing only by case
are refused rather than assumed distinct.

`GATEWAY_HANDLE` names the handle the running instance serves. Setting
`GATEWAY_HANDLES` without it is refused (fail closed) instead of guessing. An
unknown or disabled name is refused the same way.

### Identity

A model is addressed as `<model>@cos-<handle>`; the marker is matched from the
END so a model id containing `@` survives, and an empty handle is malformed. An
instance serves exactly its own handle:

| Request | Answer |
| --- | --- |
| no identity, or this instance's handle | served here |
| unknown handle | `400 handle_unknown` |
| disabled handle | `403 handle_disabled` |
| another instance's handle | `400 handle_mismatch` (that instance is the only one that can reach that account) |

`/v1/models` publishes every catalog model in deployment form
(`<model>@cos-<handle>`), and `/v1/status` adds a `handle` block (alias and
readiness only, no account detail) plus a `deployment` map of
`<model>@cos-<handle>` entries. Authenticated responses carry `x-cos-handle` with
the serving alias. A request is admitted only when its handle is **ready**:

| Readiness | Meaning |
| --- | --- |
| `ready` | `signedIn`, `browserRunning` and `extensionFresh` are all positively true. |
| `not_ready` | One of them is positively false. |
| `unknown` | Any of them was never observed. Unknown is NOT ready. |
| `disabled` | Operator-disabled. |

A not-ready or unknown handle answers `503 handle_not_ready` and nothing is
admitted, so a turn never silently goes nowhere.

Conversation, session and retry keys are namespaced `cos:<handle>:<key>`, so a
turn of one account can never be re-attached from another. Adopting a session
recorded under a different handle is refused with `409 cross_handle_session`
(`TurnManager.ownerOfSession` plus the key prefix, checked independently).

### Pool failover (optional)

A pool is several handles offering the same base model. Failover is narrow on
purpose and is decided by `failover.ts` (`classifyFailure`, `planFailover`):

| Failure | Class | Pool move |
| --- | --- | --- |
| `429` | `throttled` | honor `Retry-After` and wait; never hop accounts |
| `503` availability (`shutting_down`, `queue_full`, `models_unknown`, `models_not_ready`, `gateway_unconfigured`, `handle_registry_invalid`, `handle_not_ready`, `handle_unavailable`) | `handle_unavailable` | next ready handle may serve it |
| `504` | `terminal` | the turn is still running there; re-attach, do not duplicate |
| anything else | `terminal` | no move |

A handle already attempted is never tried twice for one request, so a pool
cannot loop; with no ready handle left the plan is `stop` with the reason.

### Proven offline vs needs a live second account

Proven offline, with synthetic fixtures only: registry validation and every
isolation refusal, identity parsing/resolution (including the malformed,
unknown, disabled and foreign cases), readiness gating (unknown is not ready),
deployment-map/status projections with no account detail, handle-scoped keys,
cross-handle session denial, and every failover classification and pool move.
Single-account behavior is pinned by a test that runs a gateway with no handle
configuration.

**NOT proven: a live second account.** No second CoS instance, VNC session or
browser was started, and no account material exists in the repository. Serving
two real accounts at once needs an operator-gated live run (a separate consent:
a second account, its own browser profile/keyring, and two spare ports), and
that is the only way to confirm two real instances side by side. Until then,
read the multi-handle path as source-and-test evidence only.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8793` | Bind port (`0` = ephemeral). |
| `GATEWAY_API_KEY` | unset | Bearer key; unset means `/v1/*` answers `503`. |
| `TURN_TIMEOUT_SECONDS` | `600` | Whole-turn wait before a timeout error. |
| `GATEWAY_INCLUDE_SYSTEM` | on | `0`/`false` drops system messages from the folded turn. |
| `STREAM_HEARTBEAT_SECONDS` | `15` | SSE comment interval; `0` disables. |
| `GATEWAY_HANDLES` | unset | Inline handle registry JSON (array or `{handles:[…]}`). |
| `GATEWAY_HANDLES_FILE` | unset | Path to the same document (preferred at deploy time). |
| `GATEWAY_HANDLE` | unset | The handle THIS instance serves; required with a registry. |

## Proven offline vs needs live verification

Proven offline: chunk shape and order, suffix-only revisions, JSON/SSE parity,
mid-stream disconnect and re-attach, a streamed timeout followed by a re-attach,
pre-stream failures still answering JSON, non-boolean `stream` staying JSON,
writer ordering/backpressure/disconnect, heartbeat on and off.

Also proven offline, with synthetic fixtures: the `/v1/errors` contract (one row
per `(code, status)`, agreement with the ledger and the classifier), cursor
round-trips and refusals, page limits and 404s, chunked keyset paging over many
rows, handle-scoped listing with cross-handle isolation on one state directory,
`/v1/handles` readiness/catalog facts with no account detail, unknown-is-not-ready,
the `tools_unsupported` refusals, and the stop route (mid-flight interruption on
both answer paths, the recorded-once terminal row, and an identical resend
becoming a new turn). `/health`, `/v1/models` and `/v1/chat/completions` keep
compatibility coverage alongside them.

The H-044 offline acceptance matrix (`test/cos-gateway/http-matrix.test.ts`)
drives the failure, restart and session-isolation behavior over real local HTTP
against fake-CoS:

- every published failure envelope: `429` with a usable `Retry-After` (and the
  wait advice), both `chat_error` shapes, the post-admission `502`s
  (`turn_ended_without_answer`, `not_delivered`), the `503`s
  (`shutting_down` even for `stream: true`, `models_not_ready`/`models_unknown`)
  and `504 turn_timeout` with the reattach advice;
- stop: a mid-flight stream ends with a `turn_stopped` error frame and no
  `[DONE]`, a whole-answer request answers `409 turn_stopped`, and a late answer
  never revives the turn. The store is read back after the gateway stops to
  prove the turn row is `stopped` and the outbox row `cancelled` exactly once,
  the in-flight slot is clear, the sequence was consumed, and a repeated stop or
  an identical resend changes nothing (the resend is a new turn). A terminal,
  unknown, malformed or key-less stop answers the contract envelope, and a
  cross-handle key is `409 cross_handle_session` without touching the turn. The
  manager test also covers `settleLeftover` resolving a stopped leftover;
- duplicate handling: a retry of an in-flight turn re-attaches by turn id and
  returns the recorded result without a second send, both after a `504` and
  when the anchor landed after the turn end (the `cc5aa19` keyed follow), while
  a concurrent duplicate is `429 session_busy`. The negative is pinned too:
  because the idempotency key is the deterministic turn id over
  `(conversation, seq, text, model, effort)`, an identical body after the turn
  settled is the NEXT turn, not a cached answer;
- restart: a turn in flight across a gateway restart resumes from the SQLite
  store (the slot, outbox and turn rows are read on disk and must agree) and
  answers without a second send; a turn that finished while the gateway was
  down is settled before the next turn, and the old turn is kept;
- two-handle isolation: a shared browser profile, userData, keyring, account or
  port fails closed with `503 handle_registry_invalid` and no path detail; each
  handle's readiness comes from its own browser evidence (unknown is not ready);
  and on one shared state directory a handle can neither re-attach, list nor
  adopt the other handle's conversation.

**NOT proven offline: the live acceptance half, which remains operator-gated.**
That half is a Playwright smoke of the real CoS UI inside Xvfb plus the
operator-run `acceptance-cos.mjs` against a disposable account and a real
browser turn. Until an operator runs it, read the failure/restart/isolation
behavior above as source-and-test evidence only, never as a live deployment
proof.

Needs live verification: SCPM/LiteLLM forwarding (above), a real ChatGPT turn
streaming through the embedded gateway, disconnect latency against a real
browser turn, and the operator-gated live half of H-044 described just above.
The listing routes read only local state, so they need no live CoS turn;
`/v1/handles` reports live browser evidence, which a real deployment supplies.
