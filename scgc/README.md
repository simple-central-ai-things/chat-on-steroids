# CoS gateway — OpenAI-compatible API compiled into Chat On Steroids

OpenAI-compatible API server compiled into this fork of Chat On Steroids
(CoS), the desktop automation app for ChatGPT. The gateway module
(`src/main/openai-gateway/`), its offline tests (`test/scgc-gateway/`) and
the deploy surface (this `scgc/` directory) all live as commits on the
gateway branch `scgc/v2.1.49-gateway`; `main` is the untouched upstream
tree.

## What

The CoS gateway is the OpenAI-compatible face of a ChatGPT membership that runs through
Chat On Steroids (CoS). Instead of a sidecar service talking to CoS's
loopback control API, the gateway is a TypeScript module compiled directly
into CoS's Electron main process (`src/main/openai-gateway/`). When the app
starts, the gateway binds `0.0.0.0:8793`; when the app shuts down, the
gateway releases the port. There is no separate process, no endpoint
discovery, no loopback token.

SCPM's LiteLLM proxy consumes this gateway as an OpenAI-compatible source.
Models are served with PLAIN ids (`gpt-5.1`, not `cos/gpt-5.1`) so LiteLLM's
canonicalization merges them with the other sources.

## Why

- The ChatGPT membership models have no first-party API. CoS drives them
  through a real browser session; the gateway exposes that session through the
  standard `chat/completions` contract, so any OpenAI client — LiteLLM,
  SDKs, agents — can use it.
- In-process beats sidecar here. The gateway calls CoS's internal functions
  directly and shares CoS's durable outbox, so a retry of the same logical
  turn replays the existing outbox row instead of double-sending a message,
  and the conversation-key → session mapping survives restarts because it
  lives under CoS's own userData.
- Code and deploy surface in one repo: an upgrade is one branch
  (`scgc/<tag>-gateway`), not a sync between two repositories.

## Layout

```
scgc/                        # this directory — the deploy surface
  Dockerfile                 # builds this repo at COS_BRANCH (the scgc/* gateway branch)
  xstartup                   # the VNC desktop session (dbus, keyring, electron)
  entrypoint.sh              # starts Xvnc, then execs xstartup as PID 1
  browser-watch.sh           # 30s firefox/ChatGPT-tab state watchdog (xstartup launches it)
  docker-compose.yml         # deploy TEMPLATE (placeholders, never a live copy)
  .env.example               # template for gateway.env
  README.md / AGENTS.md      # these contracts and the agent rules for this surface
  mcp/                       # the MCP server as an installable Python package
    pyproject.toml           #   PEP 621 metadata; console script `scgc-mcp`
    scgc_mcp/                #   stdio transport, tools dispatch, hub-side key handling
      server.py, __init__.py, __main__.py
      helpers/               #   bundled helper scripts (shipped as package data)
        cos-sync-join.sh     #   self-service: onboard THIS machine to the hub
        cos-share.sh         #   share one local directory (hub peer only)
        st-*.py              #   argv-safe syncthing config helpers (local + hub)

src/main/openai-gateway/     # the module compiled into CoS's main process
  fold.ts                  # OpenAI message list → what CoS should receive
  catalog.ts               # CoS catalog → /v1/models; model + effort validation
  errors.ts                # the failure-semantics contract (status per failure)
  turns.ts                 # conversation mapping, deterministic input ids,
                           # turn orchestration over the CosInternals boundary
  openai-server.ts         # HTTP server: auth, /health, /v1/models,
                           # /v1/chat/completions
  internals.ts             # binds CosInternals to the real CoS exports (CoS-only)
  wire.ts                  # start/stop singletons called from src/main/index.ts
src/main/index.ts            # bootstrap wiring: import + start next to the control
                             # API + stop in the shutdown/drain array
test/scgc-gateway/           # node:test suite, offline (CoS internals stubbed),
                             # under its own NodeNext tsconfig
.github/workflows/scgc-gateway-tests.yml  # the full pipeline, branch-scoped
```

Only `internals.ts` and `wire.ts` import CoS modules; everything else is
dependency-free. The branch CI typechecks the pure modules and the tests
standalone, then typechecks the whole app tree, which covers the two
CoS-bound files against CoS's real types. That app-tree typecheck is the
acceptance test for any change that touches CoS internals. The branch CI
also runs a `deploy-guard` job that verifies the Dockerfile builds this
repo's current branch and that the module, tests and wiring are present.

## Upstream pin (important)

- CoS version: **v2.1.49**, carried by the branch `scgc/v2.1.49-gateway`,
  pinned by `COS_BRANCH` in `scgc/Dockerfile`.
- The pin is enforced twice: the Dockerfile asserts the module and test
  pipeline exist on the cloned branch, and the branch-scoped
  `scgc-gateway-tests` workflow typechecks the app tree before anyone bumps
  `COS_BRANCH`. Upgrading is a deliberate step: cut a new
  `scgc/<tag>-gateway` branch from the new upstream tag carrying the same
  delta, audit `internals.ts` against the new source, make the branch CI
  green, then bump `COS_BRANCH` in `scgc/Dockerfile`.

## Installing the MCP server (any machine)

The `scgc/mcp` package is dependency-free (Python stdlib only) and bundles
its helper scripts, so one install line gives any machine the full
syncthing + gateway toolset:

```sh
# pipx or uv (isolated, recommended)
pipx install "git+https://github.com/simple-central-ai-things/chat-on-steroids.git@scgc/v2.1.49-gateway#subdirectory=scgc/mcp"
uv tool install "git+https://github.com/simple-central-ai-things/chat-on-steroids.git@scgc/v2.1.49-gateway#subdirectory=scgc/mcp"
# or plain pip
pip install "scgc-mcp @ git+https://github.com/simple-central-ai-things/chat-on-steroids.git@scgc/v2.1.49-gateway#subdirectory=scgc/mcp"
```

The install provides the `scgc-mcp` console script (also runnable as
`python3 -m scgc_mcp`). Register it as a local MCP command in the harness of
your choice:

```json
{
  "type": "local",
  "command": ["scgc-mcp"],
  "environment": {
    "SCGC_HUB_SSH": "docker@<hub-host>",
    "SCGC_GATEWAY_URL": "http://<hub-host>:8793"
  }
}
```

Both env vars are optional (defaults match the live hub). Publishing the
package to the PyPI index itself is a one-step owner action
(`uv build && twine upload dist/*` with an API token); the git URL above is
the canonical install source until then.

## Contracts

### Endpoints (port 8793, in-process)

| Route | Auth | Behavior |
|---|---|---|
| `GET /health` | none | `{ok, protocol: "cos-embedded-1", authenticated}` — open for deploy tooling |
| `GET /v1/models` | bearer | OpenAI model list from CoS's picker catalog, plain ids; 503 until the catalog is ready |
| `POST /v1/chat/completions` | bearer | runs one CoS turn and answers with the full result; `stream` is ignored |

`Authorization: Bearer $GATEWAY_API_KEY` is required on every `/v1/*` route.
Without `GATEWAY_API_KEY` the server still starts but fails closed: every
`/v1/*` call returns 503 `gateway_unconfigured`.

### Message folding

ChatGPT has no system role and keeps its own history, so the gateway sends
only the delta CoS does not already have:

- the **first turn of a new chat** carries the request's system messages as a
  `[Context for this conversation]` prefix (`include_system`, default on),
  followed by the user text;
- **every later turn** sends only the newest user message.

The conversation key is a sha256 over everything up to and including the
first user turn — the system context and the opener. Including the system
message keeps two callers with the same opener but different context in
separate CoS sessions; **true per-principal isolation requires the
`X-CoS-Session` header**, because LiteLLM does not forward caller identity
and the derived key only separates conversations by their message prefix.

### Failure semantics (SCPM's failover relies on these — do not change)

| Status | When |
|---|---|
| 400 | invalid body/messages, unknown model, unavailable `reasoning_effort`, invalid JSON |
| 409 | `id_conflict`: a retry whose payload no longer matches the recorded outbox row |
| 429 + Retry-After | the session is busy with an in-flight turn; CoS reports busy / would-interrupt; a `chat_error` event carrying a `retryAt` deadline |
| 502 | the chat is unusable (`no_chat`, `chat_blocked`), a turn ended without an answer, an input row that never got delivered |
| 503 | CoS is shutting down, the outbox queue is full, the model catalog is not ready, the gateway is unconfigured |
| 504 | the turn did not finish within `TURN_TIMEOUT_SECONDS` (default 600); the turn keeps running in CoS and a later request re-attaches to it by input id instead of double-sending |

Retries are idempotent by construction: each logical turn's input id is a
deterministic UUIDv5 over `key|seq|text|model|effort`, where `seq` is a
per-conversation turn sequence persisted with the in-flight marker. A retry
of the in-flight turn re-derives the same id and re-attaches to the existing
outbox row (after a 504 or a restart) instead of double-sending; two
legitimate identical messages in one conversation get consecutive sequences
and distinct ids.

### Environment (`gateway.env`)

| Variable | Default | Meaning |
|---|---|---|
| `GATEWAY_API_KEY` | — | bearer key for `/v1/*`; fail-closed 503 when unset |
| `PORT` | 8793 | listen port (0 = ephemeral, used by tests) |
| `TURN_TIMEOUT_SECONDS` | 600 | 504 deadline; the turn keeps running past it |
| `GATEWAY_INCLUDE_SYSTEM` | 1 | fold the system message into the first turn (0 = off) |

## Deploy

`scgc/Dockerfile` builds this repo from source at the gateway branch
(`COS_BRANCH`, default `scgc/v2.1.49-gateway`): clone → assert the module and
test pipeline are present → `npm ci` → `npm run build` (electron-vite). The
branch carries the module and the bootstrap wiring as commits, so there is
no in-build patching; a missing branch or a missing module fails the clone/
assert step loudly. The upgrade guard is the branch-scoped
`scgc-gateway-tests` workflow, which typechecks the app tree (covering the
two CoS-bound files) before anyone bumps `COS_BRANCH`.

The container runs TigerVNC: `scgc/entrypoint.sh` starts `Xvnc :1` in the
background (1920x1080, VncAuth from the mounted passwd file, all interfaces
so the published port works), waits for the display, then execs `xstartup`
as PID 1. `xstartup` is a `dbus-run-session` session — private dbus bus for
the app's lifetime, gnome-keyring seeded NON-interactively from the mounted
passphrase (a GUI "choose keyring password" prompt stalls the session on
first run otherwise), openbox, and the CoS build as the session leader, so a
crash stops the container and compose restarts it. (CMD must not be
`vncserver` directly: it daemonizes and Docker kills the container.) The
gateway starts with the app and answers on 8793.

On the deploy host — the live compose file runs from the deploy-directory
root, so its build context is that directory (the Dockerfile lives in the
`scgc/` subdirectory of it):

```sh
git clone --branch scgc/v2.1.49-gateway --depth 1 \
  https://github.com/simple-central-ai-things/chat-on-steroids.git <deploy-dir>/scgc-src
mkdir -p <deploy-dir>/scgc
cp <deploy-dir>/scgc-src/scgc/{Dockerfile,xstartup,entrypoint.sh,browser-watch.sh} <deploy-dir>/scgc/
cp <deploy-dir>/scgc-src/scgc/docker-compose.yml <deploy-dir>/docker-compose.yml
cd <deploy-dir>
vncpasswd > vnc-passwd                    # VNC password file
printf '%s' 'passphrase' > keyring-passphrase && chmod 600 keyring-passphrase
cp scgc/.env.example gateway.env          # set GATEWAY_API_KEY
mkdir userdata
docker compose up -d --build
```

Recommended host-only addition: a `.dockerignore` at the deploy-directory
root excluding the data volumes (`userdata/`, `workspace/`, `shared/`,
`keyrings/`, `gateway.env`, `vnc-passwd`, …) so the build context stays
small and session data never crosses to the Docker daemon. Nothing in it is
baked into the image either way — the Dockerfile only `COPY`s the three
scripts — but a multi-gigabyte context slows every rebuild.

Then point LiteLLM at `http://<host>:8793` with `GATEWAY_API_KEY`; see the
SCPM repo for the `cos/*` deployment.

The VNC display (`5902`) is how you walk the CoS setup wizard on first run —
connect a VNC client to `<deploy-host>:5902` with the `vncpasswd` you set.

### Upgrading CoS

Cut a new `scgc/<tag>-gateway` branch from the new upstream tag carrying the
same delta (the `src/main/openai-gateway/` module, the wiring in
`src/main/index.ts`, `test/scgc-gateway/`, this `scgc/` surface), fix
`internals.ts` if any internal signature changed, and let the branch CI go
green — the app-tree typecheck against the real CoS types is the acceptance
test. Then bump `COS_BRANCH` in `scgc/Dockerfile`.

## Folder sharing (agents on any machine)

The container sees shared working directories at `/home/cos/workspace`
(the default syncthing folder) and `/home/cos/shared/<slug>/` (anything
registered with `cos-share.sh`). Point CoS's setup "Folder" step at
`/home/cos/workspace`.

The helpers ship inside the `scgc/mcp` package
(`scgc/mcp/scgc_mcp/helpers/`) and are dispatched by the MCP tools, so
agents normally never call them directly:

- `syncthing_share_folder {path}` — register one local directory as a live,
  bidirectional syncthing sync that lands under the container's
  `/home/cos/shared/<slug>/`. 60s fallback rescan covers Docker bind-mount
  writes that miss inotify. (Direct form:
  `bash scgc/mcp/scgc_mcp/helpers/cos-share.sh <dir>`.)
- `syncthing_join_hub {name, folder}` — self-service onboarding for a
  **new machine**: it ensures syncthing is installed and running locally,
  adds this machine to the hub's syncthing config over SSH (the hub API
  password never leaves the hub), accepts the default folder locally, and
  verifies the sync end to end with a marker file. (Direct form:
  `bash scgc/mcp/scgc_mcp/helpers/cos-sync-join.sh --hub <ssh-target> --name
  <label> [--folder <path>]`.)

The hub is the always-on deploy host; syncthing relays/global discovery let
a laptop join from anywhere, not just the LAN.

## Scaling & multi-user

One CoS container = one ChatGPT membership = one in-process gateway.

- **Auth/tenancy is LiteLLM's job.** Users authenticate to LiteLLM with
  their own virtual keys and budgets; none of them ever hold
  `GATEWAY_API_KEY`. The gateway stays single-key and does not need
  per-user auth.
- **The hard ceiling is the ChatGPT account's quota** (5-hour/weekly
  window). N users share one window until it exhausts; CoS then returns
  `chat_error`+`retryAt`, which the gateway maps to 429+Retry-After.
- **CoS serializes sends app-wide** (409 busy, ≤4 pending); the gateway
  maps that to 429 so LiteLLM's retry/failover policy absorbs it.
- **To scale throughput and quota, run more CoS instances** — each with its
  own ChatGPT account and its own gateway port (8793, 8794, …) — and
  register each as separate `cos/*` deployments in LiteLLM. LiteLLM already
  round-robins and fails over across them. The gateway code does not
  change.
- Known limitation: two callers with an identical conversation key share
  one CoS session (LiteLLM does not forward caller identity to the
  gateway). Rare in practice; override with `X-CoS-Session` if needed.

## Security

- Bearer auth on 8793 is the only credential on the port; the key never
  appears in logs or responses.
- The gateway talks in-process — the loopback control API stays disabled.
- Fail-closed: without `GATEWAY_API_KEY` the gateway refuses all `/v1/*`.
- `vnc-passwd`, `keyring-passphrase` and `gateway.env` are host-side
  material, never committed (gitignored).
- The container runs as the non-root `cos` user (uid 1000); CoS's userData
  is a volume, so the membership session survives container rebuilds.
- VNC (`5902`) is password-protected (VncAuth) but has no TLS transport; it
  is reachable on the deploy host's LAN interfaces. For a laptop joining
  from outside the trusted LAN, front it with an SSH tunnel
  (`ssh -N -L 5902:127.0.0.1:5902 <deploy-host>`) and bind the compose port
  to `127.0.0.1` so raw LAN VNC is not exposed.
