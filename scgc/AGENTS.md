# AGENTS.md — SCGC surface (gateway branch + deploy surface)

Project rules for agents working on the SCGC surface of this fork. The
repo-root AGENTS.md (the CoS product map) and the org-wide rules apply on
top of this file.

## What this surface is

SCGC compiles an OpenAI-compatible API server directly into Chat On
Steroids (CoS). Everything lives on this repo's `scgc/*` branches — `main`
is the untouched upstream tree and must never receive the gateway code:

- `src/main/openai-gateway/` — the module, wired into CoS's bootstrap in
  `src/main/index.ts`.
- `test/scgc-gateway/` — the offline node:test suite under its own
  NodeNext tsconfig (excluded from the app tsconfig + vitest).
- `scgc/` — the build/deploy surface (Dockerfile, VNC session files,
  compose template) and the agent tooling (`scgc/mcp`, the installable
  `scgc-mcp` Python package).

The Dockerfile clones the `COS_BRANCH` gateway branch and ships a
VNC-served desktop where the gateway answers on `0.0.0.0:8793` with bearer
auth, mapping OpenAI chat completions onto CoS sessions in-process — no
loopback control API, no separate service, no build-time patching. SCPM's
LiteLLM consumes it as a `cos/*` model source.

See `scgc/README.md` for the user-facing contracts (endpoints, env vars,
failure semantics, deploy, scaling, security). The source of truth for the
upstream contract is CoS's own source at the pinned version — the file:line
references live in `src/main/openai-gateway/internals.ts`.

## Upstream pin (important)

- CoS version: **v2.1.49**, carried by the branch
  `scgc/v2.1.49-gateway`, pinned by `COS_BRANCH` in `scgc/Dockerfile`.
- The pin is enforced twice: the Dockerfile asserts the module and test
  pipeline exist on the cloned branch, and the branch-scoped
  `scgc-gateway-tests` workflow typechecks the app tree (covering the two
  CoS-bound files against CoS's real exports), runs the offline suite and
  checks the deploy surface (`deploy-guard` job) before anyone bumps
  `COS_BRANCH`. Upgrading is a deliberate step: cut a new
  `scgc/<tag>-gateway` branch from the new upstream tag carrying the same
  delta, audit `internals.ts` against the new source, make the branch CI
  green, then bump `COS_BRANCH` here.
- The gateway runs inside the app process. If a task seems to need a
  loopback control API, endpoint.json discovery, or a separate gateway
  process, it is misreading the architecture.

## Build / test

The test pipeline runs on the `scgc/*` branch:

```sh
# in a checkout of this repo @ scgc/*
npx tsc --noEmit -p tsconfig.json                    # app tree (internals/wire)
npx tsc --noEmit -p test/scgc-gateway/tsconfig.json  # pure modules + tests
npx tsc -p test/scgc-gateway/tsconfig.build.json \
  && node --test test/scgc-gateway/.build/test/scgc-gateway/*.test.js
```

Tests are offline by design and must stay that way: no network, no secrets,
no Electron. The branch's `scgc-gateway-tests` workflow (Node 22) runs all
three steps plus the deploy-guard contract check.

The integration check is the Docker build: it clones the branch and builds
CoS. For a change that touches `internals.ts` or `wire.ts`, verify by
running the app-tree typecheck above against this checkout with deps
installed.

## Conventions

- English only in all tracked files; never log or return CoS content beyond
  ids and outcomes.
- The `CosInternals` boundary is load-bearing: new CoS capabilities are
  added there, never imported from the pure modules.
- Failure semantics are a contract (README table): 429 + Retry-After for
  busy/limits, 503 for CoS unavailable, 504 (turn keeps running) for turn
  timeouts, fail-closed without a key. Preserve the mapping when touching
  `errors.ts` — SCPM's failover relies on it.
- Retries must never double-send: input ids are derived UUIDv5 over key +
  per-conversation sequence + text; the sequence persists with the in-flight
  marker, a 504 keeps it so the retry re-attaches by id, and only
  `finishTurn` consumes a sequence. Any new send path goes through
  `TurnManager.planTurn` + `sendTurn`.
- The live host deploy (real compose values, keys, userdata) is never
  committed; `scgc/docker-compose.yml` is a placeholder template. The
  deploy-directory layout is documented in `scgc/README.md` (Deploy).
- Commit + push after every meaningful change; commit identity
  `user.email=hello@babico.name.tr`.

## Related repos

- **SCPM** (proxy-manager) — the LiteLLM proxy; consumes this gateway as an
  OpenAI-compatible source (`cos/*` deployments). When the endpoint shape or
  error mapping changes, update SCPM's AGENTS.md/README too.
- **SCAO** (orchestrator) — the policy control plane above the harnesses;
  nothing here implements policy or scheduling.
