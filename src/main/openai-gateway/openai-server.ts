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
import {
  openAiModels,
  resolveModelChoice,
  REASONING_EFFORTS,
  type ChatModelCatalog,
  type ReasoningEffort
} from './catalog.js';
import { conversationKey, normalizeMessages, FoldError, type NormalizedMessage } from './fold.js';
import {
  errorBody,
  gatewayError,
  isReasoningEffort,
  mapTurnTimeout,
  type GatewayErrorData,
  GatewayError
} from './errors.js';
import {
  completionId,
  SessionBusy,
  TurnDetached,
  TurnError,
  TurnManager,
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
  return {
    port: Number.isSafeInteger(port) && port >= 0 && port < 65536 ? port : 8793,
    apiKey: apiKey !== undefined && apiKey.length > 0 ? apiKey : null,
    turnTimeoutSeconds: Number.isSafeInteger(turnTimeoutSeconds) && turnTimeoutSeconds > 0
      ? turnTimeoutSeconds
      : 600,
    includeSystem: env.GATEWAY_INCLUDE_SYSTEM !== '0' && env.GATEWAY_INCLUDE_SYSTEM !== 'false',
    streamHeartbeatMs: Number.isSafeInteger(heartbeatSeconds) && heartbeatSeconds > 0
      ? heartbeatSeconds * 1000
      : 0
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
  const url = (req.url ?? '/').split('?')[0]!;
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
  if (req.method === 'GET' && url === '/v1/status') {
    await handleStatus(res, internals);
    return;
  }
  if (req.method === 'GET' && url === '/v1/models') {
    await handleModels(res, internals);
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
async function handleStatus(res: ServerResponse, internals: CosInternals): Promise<void> {
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
  send(res, 200, {
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
  });
}

async function handleModels(res: ServerResponse, internals: CosInternals): Promise<void> {
  const catalog = internals.getChatModels();
  if (catalog.state !== 'ready') {
    send(res, 503, errorBody({
      status: 503, code: 'models_not_ready',
      message: catalog.error ?? catalog.waiting ?? 'the model catalog is not ready yet'
    }));
    return;
  }
  send(res, 200, { object: 'list', data: openAiModels(catalog) });
}

interface CompletionRequest {
  model?: unknown;
  messages?: unknown;
  reasoning_effort?: unknown;
  stream?: unknown;
  include_system?: unknown;
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
    typeof body.model === 'string' ? body.model : null,
    body.reasoning_effort as ReasoningEffort | null | undefined,
  );
  let key: string;
  try {
    key = conversationKey(normalized, sessionOverride(req));
  } catch (error) {
    if (error instanceof FoldError) throw gatewayError('invalid_body', error.message);
    throw error;
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
