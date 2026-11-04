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

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8793` | Bind port (`0` = ephemeral). |
| `GATEWAY_API_KEY` | unset | Bearer key; unset means `/v1/*` answers `503`. |
| `TURN_TIMEOUT_SECONDS` | `600` | Whole-turn wait before a timeout error. |
| `GATEWAY_INCLUDE_SYSTEM` | on | `0`/`false` drops system messages from the folded turn. |
| `STREAM_HEARTBEAT_SECONDS` | `15` | SSE comment interval; `0` disables. |

## Proven offline vs needs live verification

Proven offline: chunk shape and order, suffix-only revisions, JSON/SSE parity,
mid-stream disconnect and re-attach, a streamed timeout followed by a re-attach,
pre-stream failures still answering JSON, non-boolean `stream` staying JSON,
writer ordering/backpressure/disconnect, heartbeat on and off.

Needs live verification: SCPM/LiteLLM forwarding (above), a real ChatGPT turn
streaming through the embedded gateway, and disconnect latency against a real
browser turn.
