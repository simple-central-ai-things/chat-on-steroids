/**
 * The OpenAI-compatible gateway, compiled into CoS's main process.
 *
 * Listens on 0.0.0.0:PORT (default 8793) once the app has bootstrapped its
 * stores; the wire-openai-server.patch hook starts it alongside the local
 * control API and stops it in the admission/drain shutdown phase. It talks
 * to CoS in-process through CosInternals (internals.ts), never over the
 * loopback control API.
 *
 * Auth: bearer GATEWAY_API_KEY on every /v1/* route. With the key unset the
 * server still starts but refuses /v1/* with 503 (fail-closed); /health
 * stays open so the deploy tooling can see the process is up.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  openAiModels,
  resolveModelChoice,
  REASONING_EFFORTS,
  type ChatModelCatalog,
  type ReasoningEffort
} from './catalog.js';
import {
  assessReadiness,
  buildDeploymentMap,
  handleOfConversationKey,
  HandleRegistry,
  HandleRegistryError,
  publicHandleView,
  resolveIdentity,
  scopedConversationKey,
  SERVED_BY_HEADER,
  servedByValue,
  type Handle,
  type HandleReadiness,
  type ServedIdentity
} from './handles.js';
import { conversationKey, normalizeMessages, FoldError, type NormalizedMessage } from './fold.js';
import {
  errorBody,
  gatewayError,
  isReasoningEffort,
  mapTurnTimeout,
  type GatewayErrorData,
  GatewayError
} from './errors.js';
import { ERROR_CONTRACT, ERROR_CONTRACT_VERSION } from './contract.js';
import {
  conversationInScope,
  listConversations,
  listTurns,
  turnView,
  type TurnView
} from './listing.js';
import {
  completionId,
  SessionBusy,
  TurnDetached,
  TurnError,
  TurnManager,
  TurnStopped,
  TurnTimeout,
  type CosInternals,
  type SessionInfo,
  type TurnManagerOptions,
  type TurnPlan
} from './turns.js';
import { completionChunk, SseWriter, STREAM_DONE } from './sse.js';

export const PROTOCOL = 'cos-embedded-1';
const MAX_BODY_BYTES = 1_000_000;

export interface GatewayConfig {
  port: number;
  apiKey: string | null;
  turnTimeoutSeconds: number;
  includeSystem: boolean;
  /** SSE comment interval while a streamed turn records nothing; 0 disables. */
  streamHeartbeatMs: number;
  /**
   * The handle this instance serves, when the deployment configures handles.
   * null is the single-account mode: bare model ids, no handle identity.
   */
  serving: HandleServing | null;
  /**
   * Why the handle configuration was rejected. Never sent to a client (it can
   * spell out account paths); it is logged at startup and every /v1/* request
   * answers a generic 503 until the deploy config is fixed.
   */
  handleError: string | null;
}

/** The validated registry plus the one handle this process owns. */
export interface HandleServing {
  registry: HandleRegistry;
  local: Handle;
}

/**
 * Read and validate the handle deployment from the environment.
 *
 *   GATEWAY_HANDLES       inline JSON handle list (array or { handles: [...] })
 *   GATEWAY_HANDLES_FILE  path to the same document (preferred at deploy time)
 *   GATEWAY_HANDLE        the handle THIS instance serves
 *
 * No handle config at all keeps the single-account behavior byte for byte.
 * A config that does not validate, or one that names no/local-serving handle,
 * is reported as `handleError` and the gateway refuses to serve: starting a
 * half-configured handle is worse than starting none.
 */
function handleServingFromEnv(env: NodeJS.ProcessEnv): { serving: HandleServing | null; error: string | null } {
  const inline = (env.GATEWAY_HANDLES ?? '').trim();
  const file = (env.GATEWAY_HANDLES_FILE ?? '').trim();
  if (inline === '' && file === '') return { serving: null, error: null };
  let raw: unknown;
  try {
    const document = inline !== '' ? inline : readFileSync(file, 'utf8');
    raw = JSON.parse(document) as unknown;
  } catch (error) {
    return { serving: null, error: `the handle registry could not be read: ${describe(error)}` };
  }
  let registry: HandleRegistry;
  try {
    registry = HandleRegistry.parse(raw);
  } catch (error) {
    return {
      serving: null,
      error: error instanceof HandleRegistryError ? error.message : `the handle registry is invalid: ${describe(error)}`
    };
  }
  const name = (env.GATEWAY_HANDLE ?? '').trim();
  if (name === '') {
    return { serving: null, error: 'GATEWAY_HANDLE must name the handle this instance serves' };
  }
  try {
    return { serving: { registry, local: registry.local(name) }, error: null };
  } catch (error) {
    return { serving: null, error: describe(error) };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function gatewayConfigFromEnv(env: NodeJS.ProcessEnv): GatewayConfig {
  const apiKey = env.GATEWAY_API_KEY;
  const portRaw = env.PORT;
  const port = portRaw !== undefined && portRaw !== '' ? Number.parseInt(portRaw, 10) : 8793;
  const timeoutRaw = env.TURN_TIMEOUT_SECONDS;
  const turnTimeoutSeconds =
    timeoutRaw !== undefined && timeoutRaw !== '' ? Number.parseInt(timeoutRaw, 10) : 600;
  const heartbeatRaw = env.STREAM_HEARTBEAT_SECONDS;
  const heartbeatSeconds =
    heartbeatRaw !== undefined && heartbeatRaw !== '' ? Number.parseInt(heartbeatRaw, 10) : 15;
  const handles = handleServingFromEnv(env);
  return {
    port: Number.isSafeInteger(port) && port >= 0 && port < 65536 ? port : 8793,
    apiKey: apiKey !== undefined && apiKey.length > 0 ? apiKey : null,
    turnTimeoutSeconds: Number.isSafeInteger(turnTimeoutSeconds) && turnTimeoutSeconds > 0
      ? turnTimeoutSeconds
      : 600,
    includeSystem: env.GATEWAY_INCLUDE_SYSTEM !== '0' && env.GATEWAY_INCLUDE_SYSTEM !== 'false',
    streamHeartbeatMs: Number.isSafeInteger(heartbeatSeconds) && heartbeatSeconds > 0
      ? heartbeatSeconds * 1000
      : 0,
    serving: handles.serving,
    handleError: handles.error
  };
}

export interface OpenAiServer {
  /** The port the server actually bound (0 in config means ephemeral). */
  port: number;
  stop(): Promise<void>;
  manager: TurnManager;
}

/**
 * Start the gateway inside the app process. Must run after the session
 * store is initialized (initSessionStore in index.ts) and before the
 * admission/drain shutdown phase.
 */
/**
 * Create the gateway and bind it on 0.0.0.0:config.port. Rejects on a bind
 * failure so a moved port never leaves a dead listener pretending to work.
 */
export function startOpenAiServer(
  internals: CosInternals,
  config: GatewayConfig,
  options: { stateDir: string; log?: (line: string) => void; managerOptions?: TurnManagerOptions },
): Promise<OpenAiServer> {
  const log = options.log ?? (() => undefined);
  if (config.handleError !== null) {
    // Operator detail only: it can name account paths and never leaves this log.
    log(`gateway handle configuration rejected: ${config.handleError}`);
  } else if (config.serving !== null) {
    log(`gateway serves handle '${config.serving.local.handle}'`);
  }
  const manager = new TurnManager(internals, options.stateDir, {
    turnTimeoutMs: config.turnTimeoutSeconds * 1000,
    ...(options.managerOptions ?? {})
  });

  const server: Server = createServer((req, res) => {
    void handleRequest(req, res, internals, config, manager).catch((error: unknown) => {
      const failure = asErrorData(error);
      log(`gateway ${req.method} ${req.url} failed: ${failure.code}: ${failure.message}`);
      if (res.headersSent) {
        // A streamed answer already began, so the status line is gone. The
        // streaming path reports its own failures as an SSE error frame; this
        // only makes sure a late throw cannot be answered with a second head.
        res.end();
        return;
      }
      send(res, failure.status, errorBody(failure), failure.retryAfterSeconds);
    });
  });

  server.on('clientError', (_error, socket) => socket.destroy());

  return new Promise<OpenAiServer>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, '0.0.0.0', () => {
      server.removeListener('error', reject);
      server.on('error', (error: Error) => log(`gateway listener: ${error.message}`));
      log(`OpenAI gateway listening on 0.0.0.0:${config.port} (protocol ${PROTOCOL})`);
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : config.port;
      resolve({
        port,
        manager,
        async stop(): Promise<void> {
          manager.dispose();
          // Drop keep-alive sockets first, or close() would wait for them forever.
          server.closeAllConnections?.();
          await new Promise<void>((done) => server.close(() => done()));
        }
      });
    });
  });
}

/** Coerce any thrown value into the gateway's error shape. */
function asErrorData(error: unknown): GatewayErrorData {
  if (typeof error === 'object' && error !== null &&
      typeof (error as GatewayErrorData).status === 'number' &&
      typeof (error as GatewayErrorData).code === 'string') {
    return error as GatewayErrorData;
  }
  return {
    status: 502,
    code: 'internal',
    message: error instanceof Error ? error.message : 'internal error'
  };
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  retryAfterSeconds?: number,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    ...(retryAfterSeconds !== undefined ? { 'Retry-After': String(retryAfterSeconds) } : {})
  });
  res.end(payload);
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  internals: CosInternals,
  config: GatewayConfig,
  manager: TurnManager,
): Promise<void> {
  const target = req.url ?? '/';
  const questionAt = target.indexOf('?');
  const url = questionAt < 0 ? target : target.slice(0, questionAt);
  const query = new URLSearchParams(questionAt < 0 ? '' : target.slice(questionAt + 1));
  if (req.method === 'GET' && url === '/health') {
    send(res, 200, { ok: true, protocol: PROTOCOL, authenticated: config.apiKey !== null });
    return;
  }
  if (!url.startsWith('/v1/')) {
    send(res, 404, errorBody({ status: 404, code: 'not_found', message: 'unknown route' }));
    return;
  }
  if (config.apiKey === null) {
    send(res, 503, errorBody({
      status: 503, code: 'gateway_unconfigured',
      message: 'GATEWAY_API_KEY is not set; the gateway refuses all /v1/* traffic'
    }));
    return;
  }
  if (!authorized(req, config.apiKey)) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    send(res, 401, errorBody({ status: 401, code: 'unauthorized', message: 'bearer key required' }));
    return;
  }
  // Which handle answered, for an authenticated caller: the operator's alias
  // only (never the account label, profile, userData or keyring).
  if (config.serving !== null) {
    res.setHeader(SERVED_BY_HEADER, servedByValue(config.serving.local.handle));
  }
  if (config.handleError !== null) {
    // Fail closed on a rejected handle config, with the static message: the
    // detail names account paths and stays in the startup log.
    send(res, 503, errorBody(gatewayError('handle_registry_invalid')));
    return;
  }
  if (req.method === 'GET' && url === '/v1/status') {
    await handleStatus(res, internals, config);
    return;
  }
  if (req.method === 'GET' && url === '/v1/models') {
    await handleModels(res, internals, config);
    return;
  }
  if (req.method === 'GET' && url === '/v1/errors') {
    // The published failure contract: one row per (code, status) the ledger can
    // answer, so a pool in front of the instances can decide `wait`, `failover`,
    // `reattach` or `stop` from the same table the gateway enforces.
    send(res, 200, {
      object: 'list',
      contract_version: ERROR_CONTRACT_VERSION,
      data: ERROR_CONTRACT
    });
    return;
  }
  if (req.method === 'GET' && url === '/v1/handles') {
    await handleHandles(res, internals, config);
    return;
  }
  if (req.method === 'GET' && url === '/v1/conversations') {
    // Read-only listing over the H-043 store: this instance's scope only, with
    // keyset pagination. It never resolves a session or sends anything.
    send(res, 200, listConversations(manager, servingHandle(config), query));
    return;
  }
  const turnsRoute = /^\/v1\/conversations\/([^/]+)\/turns$/.exec(url);
  if (req.method === 'GET' && turnsRoute !== null) {
    let conversationKey: string;
    try {
      conversationKey = decodeURIComponent(turnsRoute[1]!);
    } catch {
      // A malformed escape is not a conversation this gateway ever published.
      throw gatewayError('not_found', 'no such conversation');
    }
    send(res, 200, listTurns(manager, servingHandle(config), conversationKey, query));
    return;
  }
  const stopRoute = /^\/v1\/conversations\/([^/]+)\/turns\/([^/]+)\/stop$/.exec(url);
  if (req.method === 'POST' && stopRoute !== null) {
    let conversationKey: string;
    let turnId: string;
    try {
      conversationKey = decodeURIComponent(stopRoute[1]!);
      turnId = decodeURIComponent(stopRoute[2]!);
    } catch {
      throw gatewayError('not_found', 'no such conversation');
    }
    send(res, 200, handleStopTurn(manager, config, conversationKey, turnId));
    return;
  }
  if (req.method === 'POST' && url === '/v1/chat/completions') {
    await handleCompletions(req, res, internals, config, manager);
    return;
  }
  send(res, 404, errorBody({ status: 404, code: 'not_found', message: 'unknown route' }));
}

function authorized(req: IncomingMessage, apiKey: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.toLowerCase().startsWith('bearer ')) return false;
  const token = header.slice(7);
  const a = Buffer.from(token);
  const b = Buffer.from(apiKey);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Operator/observability status: the gateway's own health plus the facts a
 * deploy check needs — whether ChatGPT's browser is signed in (the persistent
 * browser proof, which can outlive a lost sign-in) AND whether that browser is
 * actually running with a fresh extension right now (live evidence, which the
 * persistent proof alone can mislead on). `effective` is the truthful answer:
 * true only when the proof says signed in AND the live browser is running AND
 * the extension is fresh; false when any side says no; null when anything is
 * unobserved. null never means "signed out".
 */
async function handleStatus(
  res: ServerResponse,
  internals: CosInternals,
  config: GatewayConfig,
): Promise<void> {
  const proof = internals.externalBrowserProof();
  const live = await internals.liveChatGptEvidence();
  const catalog = internals.getChatModels();
  const signedIn = proof?.signedIn ?? null;
  const since = proof?.since ?? null;
  const browserVersion = proof?.version ?? null;
  const browserRunning = live.browserRunning;
  const extensionFresh = live.extensionFresh;
  // true ONLY with positive last-known sign-in AND live browser running AND a
  // fresh extension; false when ANY side says no; null when unknown.
  const effective =
    signedIn === true && browserRunning === true && extensionFresh === true
      ? true
      : signedIn === false || browserRunning === false || extensionFresh === false
        ? false
        : null;
  const body: Record<string, unknown> = {
    ok: true,
    protocol: PROTOCOL,
    chatgpt: {
      lastKnown: { signedIn, since, browserVersion },
      live: { browserRunning, extensionFresh },
      effective
    },
    catalog: {
      state: catalog.state,
      observedAt: catalog.observedAt,
      models: catalog.models.length
    }
  };
  if (config.serving !== null) {
    const readiness = assessReadiness(config.serving.local, {
      signedIn, browserRunning, extensionFresh
    });
    body.handle = {
      ...publicHandleView(readiness),
      // The deployment map this instance can prove: its own handle carries the
      // observed catalog, every other handle's readiness is unknown (never
      // served by guesswork) and no account detail rides along.
      deployment: buildDeploymentMap(
        config.serving.registry,
        new Map<string, HandleReadiness>([[readiness.handle, readiness]]),
        new Map([[readiness.handle, catalogModels(catalog)]])
      )
    };
  }
  send(res, 200, body);
}

/** The base model ids a ready catalog offers; empty while it is not ready. */
function catalogModels(catalog: ChatModelCatalog): readonly string[] {
  return catalog.state === 'ready' ? catalog.models.map((model) => model.id) : [];
}

async function handleModels(
  res: ServerResponse,
  internals: CosInternals,
  config: GatewayConfig,
): Promise<void> {
  const catalog = internals.getChatModels();
  if (catalog.state !== 'ready') {
    send(res, 503, errorBody({
      status: 503, code: 'models_not_ready',
      message: catalog.error ?? catalog.waiting ?? 'the model catalog is not ready yet'
    }));
    return;
  }
  send(res, 200, { object: 'list', data: openAiModels(catalog, config.serving?.local.handle ?? null) });
}

/** The handle this instance serves, or null in single-account mode. */
function servingHandle(config: GatewayConfig): string | null {
  return config.serving?.local.handle ?? null;
}

/**
 * POST /v1/conversations/{key}/turns/{turnId}/stop (H-046).
 *
 * The store's one mutating route besides a completion: it interrupts an
 * in-flight turn and records the terminal `stopped` state. It deliberately
 * takes no conversation lock — the request following that turn holds it for
 * its whole lifetime — so the manager's transition is synchronous and atomic.
 *
 * Scope matches the listing: a conversation from outside this instance's scope
 * is never revealed. A key whose prefix names another handle this deployment
 * defines is a deliberate cross-account attempt (`409 cross_handle_session`);
 * any other foreign or unknown key is indistinguishable from a missing one
 * (`404`). SEALED has no representation in this fork: it is enforced by the
 * SCPM router/provider in front of the gateway, so this route inherits the same
 * bearer, registry and scope gates as every other `/v1/*` request instead of
 * inventing a local flag.
 */
function handleStopTurn(
  manager: TurnManager,
  config: GatewayConfig,
  conversationKey: string,
  turnId: string,
): TurnView & { changed: boolean } {
  const localHandle = servingHandle(config);
  if (!conversationInScope(conversationKey, localHandle)) {
    const owner = handleOfConversationKey(conversationKey);
    const foreignRegistered = owner !== null &&
      config.serving !== null && config.serving.registry.get(owner) !== null;
    throw foreignRegistered
      ? gatewayError('cross_handle_session')
      : gatewayError('not_found', 'no such conversation');
  }
  if (!manager.hasConversation(conversationKey)) {
    throw gatewayError('not_found', 'no such conversation');
  }
  const { turn, changed } = manager.stopTurn(conversationKey, turnId);
  return { ...turnView(turn), changed };
}

const NO_HANDLE_EVIDENCE = { signedIn: null, browserRunning: null, extensionFresh: null } as const;

/**
 * Per-handle status and entitlement (platform spec D4 / H-045).
 *
 * The local handle's readiness comes from the same LIVE browser evidence the
 * completions gate uses (`assessReadiness`), so unknown is never ready. Its
 * catalog facts are the ones CoS actually observed, with the age of that
 * observation. Another handle is not observable from this process, so it is
 * `unknown`, never ready, and carries no account detail at all.
 *
 * `processing_attested` is false everywhere and for a reason: this endpoint
 * reports what a browser and a catalog proved, never that a request was
 * processed locally.
 */
async function handleHandles(
  res: ServerResponse,
  internals: CosInternals,
  config: GatewayConfig,
): Promise<void> {
  if (config.serving === null) {
    send(res, 200, { object: 'list', processing_attested: false, data: [] });
    return;
  }
  const proof = internals.externalBrowserProof();
  const live = await internals.liveChatGptEvidence();
  const catalog = internals.getChatModels();
  const evidence = {
    signedIn: proof?.signedIn ?? null,
    browserRunning: live.browserRunning,
    extensionFresh: live.extensionFresh
  };
  const observedAt = catalog.observedAt;
  const ageSeconds = observedAt === null
    ? null
    : Math.max(0, Math.floor((Date.now() - observedAt) / 1000));
  const local = config.serving.local;
  const readiness = assessReadiness(local, evidence);
  const data = config.serving.registry.list().map((handle) => {
    if (handle.handle !== local.handle) {
      // This process owns one account. Another handle's readiness is unknown to
      // it, and nothing about that account (label, profile, keyring) rides along.
      return {
        handle: handle.handle,
        object: 'handle',
        local: false,
        status: 'unknown',
        ready: false,
        reason: 'this instance cannot observe another handle',
        evidence: NO_HANDLE_EVIDENCE,
        catalog: null
      };
    }
    return {
      ...publicHandleView(readiness),
      object: 'handle',
      local: true,
      // The raw live signals, so the status is auditable rather than asserted.
      evidence,
      catalog: {
        state: catalog.state,
        observed_at: observedAt === null ? null : Math.floor(observedAt / 1000),
        age_seconds: ageSeconds,
        // Base ids only: the per-handle entitlement, not another handle's view.
        models: catalogModels(catalog)
      }
    };
  });
  send(res, 200, { object: 'list', processing_attested: false, data });
}

interface CompletionRequest {
  model?: unknown;
  messages?: unknown;
  reasoning_effort?: unknown;
  stream?: unknown;
  include_system?: unknown;
  // Accepted only to refuse them: no CoS source contract verifies tool/function
  // calls, so the gateway documents them UNSUPPORTED instead of simulating them.
  tools?: unknown;
  functions?: unknown;
  tool_choice?: unknown;
  function_call?: unknown;
}

/**
 * Tool and function calls are UNSUPPORTED (platform spec D4 / H-045): CoS keeps
 * model execution in ChatGPT's own conversation, and no local contract verifies
 * a tool-call round trip. A non-empty `tools`/`functions` list, or any
 * `tool_choice`/`function_call` other than absent/null/'none', is refused with
 * a clear 400 instead of being silently ignored — a client must never believe a
 * tool call was supported and then act on a hallucinated invocation.
 *
 * An empty list is valid and means the caller sent no tools; a present
 * non-array is a malformed body, not an unsupported feature.
 */
function refuseToolCalls(body: CompletionRequest): void {
  for (const field of ['tools', 'functions'] as const) {
    const value = body[field];
    if (value === undefined) continue;
    if (!Array.isArray(value)) {
      throw gatewayError('invalid_body', `${field} must be an array when present`);
    }
    if (value.length > 0) throw gatewayError('tools_unsupported');
  }
  for (const field of ['tool_choice', 'function_call'] as const) {
    const value = body[field];
    if (value === undefined || value === null || value === 'none') continue;
    throw gatewayError('tools_unsupported');
  }
}

async function handleCompletions(
  req: IncomingMessage,
  res: ServerResponse,
  internals: CosInternals,
  config: GatewayConfig,
  manager: TurnManager,
): Promise<void> {
  const raw = await readBody(req);
  let body: CompletionRequest;
  try {
    body = JSON.parse(raw) as CompletionRequest;
  } catch {
    throw gatewayError('invalid_json');
  }
  // Refused before handle identity, readiness or the catalog: the request shape
  // is wrong for this gateway whatever account it names.
  refuseToolCalls(body);

  // Which account this request is for. `<model>@cos-<handle>` names a handle;
  // this instance serves exactly one. Another handle's identity is a routing
  // error (answered before anything is read from the catalog or sent), and an
  // unknown or disabled handle is refused outright.
  const served: ServedIdentity | null = config.serving === null
    ? null
    : resolveIdentity(
        config.serving.registry,
        config.serving.local.handle,
        typeof body.model === 'string' ? body.model : null,
      );

  // Per-handle readiness from LIVE browser evidence. Unknown is not ready: a
  // request must not be admitted into an account nobody has proven is signed
  // in, or the turn goes nowhere and the message stays in the outbox.
  if (served !== null) {
    const live = await internals.liveChatGptEvidence();
    const readiness = assessReadiness(served.handle, {
      signedIn: internals.externalBrowserProof()?.signedIn ?? null,
      browserRunning: live.browserRunning,
      extensionFresh: live.extensionFresh
    });
    if (!readiness.ready) {
      throw gatewayError('handle_not_ready',
        `handle '${readiness.handle}' is not ready: ${readiness.reason}`);
    }
  }

  const normalized: NormalizedMessage[] =
    ((): NormalizedMessage[] => {
      try {
        return normalizeMessages(body.messages);
      } catch (error) {
        if (error instanceof FoldError) throw gatewayError('invalid_body', error.message);
        throw error;
      }
    })();

  // `stream: true` answers with OpenAI `chat.completion.chunk` events on the
  // same turn path; anything else (including a non-boolean) answers whole.
  const streaming = body.stream === true;
  if (body.reasoning_effort !== undefined && body.reasoning_effort !== null &&
      !isReasoningEffort(body.reasoning_effort)) {
    throw gatewayError('invalid_reasoning_effort',
      `reasoning_effort must be one of ${REASONING_EFFORTS.join(', ')}`);
  }
  const includeSystem = body.include_system === false
    ? false
    : config.includeSystem;
  const selection = resolveModelChoice(
    internals.getChatModels(),
    served !== null ? served.model : (typeof body.model === 'string' ? body.model : null),
    body.reasoning_effort as ReasoningEffort | null | undefined,
  );
  // Conversation, session and retry keys are scoped BY HANDLE, so the same
  // message on two accounts is two conversations and a retry can only ever
  // re-attach to a turn of the handle that owns it.
  let key: string;
  try {
    const folded = conversationKey(normalized, sessionOverride(req));
    key = served === null ? folded : scopedConversationKey(served.handle.handle, folded);
  } catch (error) {
    if (error instanceof FoldError) throw gatewayError('invalid_body', error.message);
    throw error;
  }
  if (served !== null) {
    const named = sessionOverride(req);
    const owner = named === null ? null : manager.ownerOfSession(named);
    if (owner !== null && handleOfConversationKey(owner) !== served.handle.handle) {
      // Defense in depth against two instances pointed at one state directory:
      // adopting the session would send this account's next message into the
      // other account's ChatGPT conversation.
      throw gatewayError('cross_handle_session',
        `session '${named}' is bound to another handle; a handle never adopts another account's conversation`);
    }
  }

  const { info, release } = await busyAsError(manager.acquire(key));

  try {
    let plan: TurnPlan;
    try {
      plan = manager.planTurn(key, normalized, selection.model, selection.reasoningEffort, includeSystem);
    } catch (error) {
      if (error instanceof FoldError) throw gatewayError('invalid_body', error.message);
      throw error;
    }
    let inputId: string;
    if (plan.replaying) {
      // A timed-out or restart-left turn: re-attach by input id. Never
      // re-sent and never re-folded; the persisted marker clears only once
      // the outcome is known (finishTurn inside followAnswer).
      inputId = plan.inputId;
    } else {
      if (info.turnInput !== null) {
        // A DIFFERENT turn is still running for this conversation (a 504 or
        // a restart left it): wait it out before the new one may send.
        await busyAsError(manager.settleLeftover(info));
      }
      const sent = await manager.sendTurn(info, plan, selection);
      inputId = sent.inputId;
    }
    // Everything above answers a JSON error, because nothing was written yet.
    if (streaming) {
      await streamAnswer(res, manager, info, inputId, config, body);
      return;
    }
    const answer = await followAnswer(manager, info, inputId, config.turnTimeoutSeconds);
    const now = Math.floor(Date.now() / 1000);
    send(res, 200, {
      id: completionId(),
      object: 'chat.completion',
      created: now,
      model: typeof body.model === 'string' ? body.model : 'auto',
      choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
      usage: null
    });
  } finally {
    release();
  }
}

/**
 * Answer one turn as OpenAI `chat.completion.chunk` SSE events.
 *
 * Frames: one role chunk, one content chunk per answer revision suffix as CoS
 * records it, one empty chunk with `finish_reason: 'stop'`, then `[DONE]`.
 * Failures that happen after the first byte cannot be a status code any more,
 * so they become one `data: {"error": …}` frame and the stream ends without
 * `[DONE]` — an OpenAI client treats that as a failed stream, never as a
 * complete answer.
 *
 * A client that goes away stops the follow within one poll (the socket close
 * wakes the waiter) and leaves the persisted turn marker in place, exactly
 * like a 504: the CoS turn keeps running, nothing is recorded as failed, and
 * the next request re-attaches by input id instead of sending twice.
 */
async function streamAnswer(
  res: ServerResponse,
  manager: TurnManager,
  info: SessionInfo,
  inputId: string,
  config: GatewayConfig,
  body: CompletionRequest,
): Promise<void> {
  const meta = {
    id: completionId(),
    created: Math.floor(Date.now() / 1000),
    model: typeof body.model === 'string' ? body.model : 'auto'
  };
  const sessionId = info.sessionId;
  const writer = new SseWriter(res, sessionId === null
    ? {}
    : { onDisconnect: () => manager.wake([sessionId]) });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    // no-transform keeps a proxy from buffering the answer; X-Accel-Buffering
    // is the same request for nginx-fronted gateways.
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();
  writer.startHeartbeat(config.streamHeartbeatMs);
  try {
    await writer.send(completionChunk(meta, { role: 'assistant', content: '' }));
    await manager.followTurn(info, inputId, {
      onText: (update) => writer.send(completionChunk(meta, { content: update.delta })),
      cancelled: () => writer.disconnected
    });
    manager.finishTurn(info);
    await writer.send(completionChunk(meta, {}, 'stop'));
    await writer.raw(STREAM_DONE);
  } catch (error) {
    const outcome = settleFollowFailure(manager, info, error, config.turnTimeoutSeconds);
    if (outcome.kind === 'failed' && !writer.disconnected) {
      await writer.send(errorBody(outcome.error));
    }
  } finally {
    await writer.close();
  }
}

function sessionOverride(req: IncomingMessage): string | null {
  const header = req.headers['x-cos-session'];
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      throw gatewayError('body_too_large');
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Run a manager call that may raise SessionBusy, translating it into a 429. */
async function busyAsError<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (error) {
    if (error instanceof SessionBusy) throw error.toError();
    throw error;
  }
}

/**
 * Follow a turn to its outcome and clear the in-flight marker. A 504
 * timeout keeps the marker and sequence persisted so the next request
 * re-attaches to the running turn by input id instead of double-sending.
 */
async function followAnswer(
  manager: TurnManager,
  info: SessionInfo,
  inputId: string,
  turnTimeoutSeconds: number,
): Promise<string> {
  try {
    const answer = await manager.followTurn(info, inputId);
    manager.finishTurn(info);
    return answer;
  } catch (error) {
    const outcome = settleFollowFailure(manager, info, error, turnTimeoutSeconds);
    if (outcome.kind === 'detached') {
      // Without a streaming caller nothing can detach; keep the contract total.
      throw gatewayError('internal');
    }
    throw outcome.error;
  }
}

/**
 * The one place a followed turn's failure decides the marker's fate, shared by
 * the whole-answer and streaming paths so they can never disagree:
 *
 *  - a timeout or a client disconnect keeps the persisted slot (re-attachable),
 *  - a reported chat failure or a turn that ended without an answer clears it,
 *  - anything else is a gateway-internal 502.
 */
function settleFollowFailure(
  manager: TurnManager,
  info: SessionInfo,
  error: unknown,
  turnTimeoutSeconds: number,
): { kind: 'detached' } | { kind: 'failed'; error: GatewayErrorData } {
  if (error instanceof TurnStopped) {
    // `stopTurn` already recorded `stopped` and cleared the slot; finishing it
    // again would overwrite that terminal state with `settled`.
    return { kind: 'failed', error: gatewayError('turn_stopped') };
  }
  if (error instanceof TurnDetached) return { kind: 'detached' };
  if (error instanceof TurnTimeout) {
    // The turn keeps running; the persisted slot lets the next request re-attach.
    return { kind: 'failed', error: mapTurnTimeout(turnTimeoutSeconds) };
  }
  if (error instanceof TurnError) {
    manager.finishTurn(info);
    return { kind: 'failed', error: error.toError() };
  }
  if (error instanceof GatewayError) return { kind: 'failed', error };
  return { kind: 'failed', error: gatewayError('internal') };
}

export type { ChatModelCatalog };
