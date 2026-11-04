# CoS OpenAI-compatible gateway

The gateway is compiled into the CoS main process (`src/main/openai-gateway/`) and
serves an OpenAI-compatible surface on `0.0.0.0:8793` (env `PORT`). It talks to CoS
in-process through `internals.ts`, never through the loopback control API. This page
records the wire contract; the code and `test/cos-gateway/` are the authority.

- `GET /health` — open, no key; process liveness for deploy tooling.
- `GET /v1/status` — sign-in evidence and catalog state.
- `GET /v1/models` — the account-observed catalog as an OpenAI model list.
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
  throw away the answer that is being recorded anyway.

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

Needs live verification: SCPM/LiteLLM forwarding (above), a real ChatGPT turn
streaming through the embedded gateway, and disconnect latency against a real
browser turn.
