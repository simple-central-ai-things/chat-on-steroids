---
name: cos-gateway-dev
description: Developing the CoS OpenAI-compatible gateway inside the chat-on-steroids fork (branch cos/v2.1.49-gateway) — module map of src/main/openai-gateway/, the bootstrap wiring in src/main/index.ts, and the offline node:test pipeline (Node 22, tsc build, 187 tests). Covers the conventions that decide a change: the STRICT SQLite state store (H-043 DAO, deterministic UUIDv5 turn ids, byte-identical restart/rollback), the GATEWAY_ERRORS status ledger and its derived /v1/errors contract, per-handle isolation and readiness semantics (H-042), the SSE chat.completion.chunk / heartbeat / stop-turn contract, the fake-CoS offline matrix (H-044), SEALED staying upstream-only, and the cos/<tag>-gateway upgrade model. Use when writing or reviewing gateway code, adding a route or error code, changing handles, readiness, listing, turns, stop or streaming, fixing a failing test/cos-gateway case, or preparing an upstream-tag upgrade. Trigger words: CoS gateway development, chat-on-steroids, cos/v2.1.49-gateway, openai-gateway module, cos-gateway-tests, state store, GATEWAY_ERRORS, handles, SSE stop-turn, Node 22.
---

# CoS gateway — development (working ON the fork)

`chat-on-steroids` is a fork of Chat On Steroids. **`main` is the untouched
upstream tree**; the gateway software lives only on `cos/*` branches, today
`cos/v2.1.49-gateway`. Work there and never touch or push `main`.

The deploy surface is **not** in this repo — Dockerfile, compose, VNC session
files, browser watchdog and `cos-mcp` live in **simple-central-proxy-manager
(SCPM) under `cos/`**. Point at it; never duplicate or describe a live deploy
from here.

## Module map (`src/main/openai-gateway/`)

| File | Role |
| --- | --- |
| `wire.ts` | `startOpenAiGateway` / `stopOpenAiGateway`: reads env, opens the store, starts the HTTP server |
| `openai-server.ts` | The HTTP surface: routing, bearer gate, body bounds, `/v1/handles`, `/v1/models`, `/v1/conversations*`, stop, completions |
| `turns.ts` | `TurnManager`: conversation/seq derivation, `turnInputId`, admission, follow, re-attach, stop, timeout, `settleLeftover` |
| `handles.ts` | H-042 handle registry, `<model>@cos-<handle>` identity, readiness assessment, handle-scoped keys (pure, no CoS imports) |
| `catalog.ts` | Account-observed model catalog + `REASONING_EFFORTS` |
| `errors.ts` | `GATEWAY_ERRORS` code→status ledger, `GatewayError`, OpenAI error body, outbox refusal/`chat_error` mapping |
| `contract.ts` | H-045 `/v1/errors` — derived from `GATEWAY_ERRORS` + `failover.ts`, never hand-listed |
| `failover.ts` | `classifyFailure` / `planFailover` for a pool in front (SCPM) |
| `sse.ts` | SSE writer, `chat.completion.chunk` builders, `[DONE]`, heartbeat comment, backpressure |
| `listing.ts` | Read-only keyset-paginated conversation/turn listings and cursors |
| `fold.ts` | OpenAI `messages` → one folded turn |
| `state/store.ts` | H-043 STRICT SQLite DAO (`node:sqlite`), migration, shadow export, rollback |
| `state/schema.ts` | Versioned schema + row types |
| `state/legacy-json.ts` | Legacy `state.json` shape, `state.export.json` shadow, rollback projection |
| `internals.ts` | The seam to CoS itself (in-process: outbox, recorder events, catalog, policy) |

`wire.ts` is the only gateway file `src/main/index.ts` imports.

Bootstrap wiring is `src/main/index.ts`: one import at the top
(`import { startOpenAiGateway, stopOpenAiGateway } from './openai-gateway/wire.js'`)
and one non-awaited `startOpenAiGateway({ userData, log })` in the startup
sequence after the bridge and the optional control API, before the connector
auto-connect. It is fail-closed without `GATEWAY_API_KEY`, and a gateway start
failure is logged and never delays the window. State lives in
`<userData>/openai-gateway`; `stopOpenAiGateway()` is awaited in the same
admission/drain shutdown list as the control API, so the port is released
before the process drains.

Wire contract, env table and the proven-vs-live boundary are documented in
`docs/cos-gateway.md`; the code and `test/cos-gateway/` remain the authority.

## Build & test

The offline suite runs on **Node 22, not 24** (`.github/workflows/cos-gateway-tests.yml`
pins `node-version: 22`; the app tree itself ships Electron/Node 24, so the
gateway tests deliberately use the CI runtime):

```sh
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"

# 1. gateway suite (the `cos-gateway-tests` job): compile then run node:test
npx tsc -p test/cos-gateway/tsconfig.build.json
node --test "test/cos-gateway/.build/test/cos-gateway/*.test.js"   # 187 tests, ~1s, no network

# 2. the job's two typechecks
npx tsc --noEmit -p test/cos-gateway/tsconfig.json   # pure gateway modules + suite
npx tsc --noEmit -p tsconfig.json                    # app tree, covers internals.ts + wire.ts
```

`.build/` is the compiled suite output and is gitignored — never commit it.
The standalone config **excludes `internals.ts` and `wire.ts`** because they
import CoS modules; the app-tree typecheck is what covers those two, so run both
or a broken seam passes silently. The app config is also the stricter one — it
adds `noUnusedLocals`/`noUnusedParameters` over the same `test/cos-gateway/*.ts`
— so an unused local in a test fails only there.

## Suite layout (`test/cos-gateway/`)

Unit files per module (`handles.test.ts`, `state-store.test.ts`,
`state-migration.test.ts`, `turns.test.ts`, `errors.test.ts`, `contract.test.ts`,
`catalog.test.ts`, `fold.test.ts`, `listing.test.ts`, `failover.test.ts`,
`stream.test.ts`, `api.test.ts`, `server.test.ts`), plus the HTTP-level files:
`handles-server.test.ts` (per-handle routing/readiness end to end) and
`http-matrix.test.ts` (H-044 matrix). `tsconfig.json` is the typecheck-only
config; `tsconfig.build.json` extends it with `noEmit: false` and
`outDir: .build`.

### The fake-CoS matrix pattern

`test/cos-gateway/fake-cos.ts` implements `CosInternals` in memory: an outbox
map, per-session event arrays with a `from` cursor, a `onSessionChange`
listener and a catalog. Tests drive whole flows (admission → delivery →
`user_message` anchor → answer revisions → `turn_end`) through real local HTTP
against a real SQLite directory in a temp dir. Extend the matrix this way
rather than mocking the gateway's own modules: the point of H-044 is that the
published failure envelopes, stop, restart and per-handle isolation are proven
over the wire. Keep every fixture synthetic — no real account, chat or path.

## Conventions a change must respect

**STRICT SQLite state store (H-043).** `state/store.ts` is the only file that
imports `node:sqlite`, and it is a hand-written DAO — no ORM, no new
dependency. Tables are `STRICT`, parameters positional `?` only, one prepared
statement cache, `PRAGMA synchronous = FULL`, every mutation one transaction.
`turn_id` is the deterministic UUIDv5 `turnInputId(conversation, seq, text,
model, effort)` and is also the outbox row id; CoS's own native turn id is
evidence (`native_turn_id`), never the key. Every commit rewrites the
`state.export.json` shadow export, and `rollbackToLegacy()` writes the old
`state.json` shape back and retires the database files. The suite pins both
properties: two clean restarts reproduce identical committed state **and
identical shadow bytes**, and a rollback reimports losslessly.

**One error ledger.** Every new failure code is a new `GATEWAY_ERRORS` row in
`errors.ts` — additive, never a renumbering. `/v1/errors` (`contract.ts`) and
the failover classifier derive from that same row, so do not hand-write a code
in a handler, a test expectation or the contract. A code with two statuses
(`chat_error`) publishes one row per status.

**Handles (H-042).** One CoS process is one account; a handle is the operator's
alias for that instance. The registry is **validated, never repaired**: a
shared browser profile, userData, keyring, account label or port fails the
whole document closed (`503 handle_registry_invalid`) with no path detail in the
body. Readiness requires positive evidence on every live signal — `unknown` is
**not** ready and admits nothing. Keys are namespaced `cos:<handle>:<key>`, so
one account's conversation can never be re-attached, listed or adopted from
another: a key naming another defined handle is `409 cross_handle_session`;
any other foreign or unknown key is `404 not_found`. No route may leak another
handle's account detail.

**SSE contract (`sse.ts`).** Frames: one `chat.completion.chunk` with
`delta: {role: assistant, content: ""}`, then one chunk per answer revision
carrying **only the not-yet-sent suffix** (revisions rewrite earlier text;
never duplicate or retract), then an empty delta with `finish_reason: "stop"`,
then `data: [DONE]`. All chunks of one answer share `id`, `created`, `model`.
Only the literal JSON `stream: true` selects SSE. A failure after the first byte
is one `data: {"error": …}` frame and the stream ends **without** `[DONE]`.
While a turn records nothing, send an SSE comment every
`STREAM_HEARTBEAT_SECONDS` (default 15, `0` disables). A client disconnect is
detected from the socket, leaves the in-flight marker re-attachable and never
calls `finishTurn` or CoS stop.

**Stop-turn terminal states.** `POST /v1/conversations/{id}/turns/{turnId}/stop`
is a terminal operator choice: it signals the follower, records `state:
"stopped"`, mirrors the outbox row to `cancelled`, clears the in-flight slot and
consumes the sequence exactly once. The follower ends as one `turn_stopped`
error frame without `[DONE]`, or `409 turn_stopped` for a whole answer. A
repeated stop is a no-op returning `changed: false`; an identical completion
body after a stop is the **next** turn (fresh deterministic id), never a replay.

**SEALED is upstream-only.** The gateway has no SEALED flag or representation:
SCPM's router/provider enforces it in front. Do not add a local one.

**Source-only boundary.** Everything here is source plus offline proof. A live
ChatGPT turn, SCPM/LiteLLM SSE forwarding and the live half of the H-044 matrix
(the Playwright smoke in Xvfb and the operator-run `acceptance-cos.mjs`) stay
operator-gated in SCPM; do not describe them as verified from a branch commit.

## Upgrade model

An upgrade is a new branch, not a merge into `main`:

1. create `cos/<new-tag>-gateway` from the new upstream tag;
2. carry the **same delta** onto it (the gateway module, the `src/main/index.ts`
   bootstrap wiring, `docs/cos-gateway.md`, `test/cos-gateway/`,
   `.github/workflows/cos-gateway-tests.yml`);
3. bump `COS_BRANCH` in SCPM's `cos/Dockerfile` (`ARG COS_BRANCH=cos/<tag>-gateway`).

Keep the previous `cos/*` branch until the new one's offline suite is green.
Nothing in this repo builds, deploys, installs or publishes — that belongs to
SCPM `cos/`.

## Working rules

- Confirm the branch and a clean tree first (`git branch --show-current`,
  `git status --porcelain`); the tree is shared, so never reset, clean or
  reformat somebody else's work.
- English only in code, comments, docs and commit messages.
- Stage explicit paths only (`git add skills/…` — never a blanket stage of the
  whole tree); commit + push to the `cos/*` branch only. Never push `main`.
- No secrets, no host names, no LAN IPs, no deploy-host paths in this repo.
