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
  isReasoningEffort,
  mapTurnTimeout,
  type GatewayErrorData,
  GatewayError
} from './errors.js';
import {
  completionId,
  SessionBusy,
  TurnError,
  TurnManager,
  TurnTimeout,
  type CosInternals,
  type SessionInfo,
  type TurnManagerOptions,
  type TurnPlan
} from './turns.js';

export const PROTOCOL = 'cos-embedded-1';
const MAX_BODY_BYTES = 1_000_000;

export interface GatewayConfig {
  port: number;
  apiKey: string | null;
  turnTimeoutSeconds: number;
  includeSystem: boolean;
}

export function gatewayConfigFromEnv(env: NodeJS.ProcessEnv): GatewayConfig {
  const apiKey = env.GATEWAY_API_KEY;
  const portRaw = env.PORT;
  const port = portRaw !== undefined && portRaw !== '' ? Number.parseInt(portRaw, 10) : 8793;
  const timeoutRaw = env.TURN_TIMEOUT_SECONDS;
  const turnTimeoutSeconds =
    timeoutRaw !== undefined && timeoutRaw !== '' ? Number.parseInt(timeoutRaw, 10) : 600;
  return {
    port: Number.isSafeInteger(port) && port >= 0 && port < 65536 ? port : 8793,
    apiKey: apiKey !== undefined && apiKey.length > 0 ? apiKey : null,
    turnTimeoutSeconds: Number.isSafeInteger(turnTimeoutSeconds) && turnTimeoutSeconds > 0
      ? turnTimeoutSeconds
      : 600,
    includeSystem: env.GATEWAY_INCLUDE_SYSTEM !== '0' && env.GATEWAY_INCLUDE_SYSTEM !== 'false'
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
    throw new GatewayError(400, 'invalid_json', 'the request body is not valid JSON');
  }

  const normalized: NormalizedMessage[] =
    ((): NormalizedMessage[] => {
      try {
        return normalizeMessages(body.messages);
      } catch (error) {
        if (error instanceof FoldError) throw new GatewayError(400, 'invalid_body', error.message);
        throw error;
      }
    })();

  // v1 ignores `stream`: the turn is followed to completion and answered whole.
  if (body.reasoning_effort !== undefined && body.reasoning_effort !== null &&
      !isReasoningEffort(body.reasoning_effort)) {
    throw new GatewayError(400, 'invalid_reasoning_effort',
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
    if (error instanceof FoldError) throw new GatewayError(400, 'invalid_body', error.message);
    throw error;
  }

  const { info, release } = await busyAsError(manager.acquire(key));

  try {
    let plan: TurnPlan;
    try {
      plan = manager.planTurn(key, normalized, selection.model, selection.reasoningEffort, includeSystem);
    } catch (error) {
      if (error instanceof FoldError) throw new GatewayError(400, 'invalid_body', error.message);
      throw error;
    }
    let answer: string;
    if (plan.replaying) {
      // A timed-out or restart-left turn: re-attach by input id. Never
      // re-sent and never re-folded; the persisted marker clears only once
      // the outcome is known (finishTurn inside followAnswer).
      answer = await followAnswer(manager, info, plan.inputId, config.turnTimeoutSeconds);
    } else {
      if (info.turnInput !== null) {
        // A DIFFERENT turn is still running for this conversation (a 504 or
        // a restart left it): wait it out before the new one may send.
        await busyAsError(manager.settleLeftover(info));
      }
      const sent = await manager.sendTurn(info, plan, selection);
      answer = await followAnswer(manager, info, sent.inputId, config.turnTimeoutSeconds);
    }
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
      throw new GatewayError(413, 'body_too_large', 'the request body is too large');
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
    if (error instanceof TurnTimeout) {
      // The turn keeps running; the persisted slot lets the next request re-attach.
      throw mapTurnTimeout(turnTimeoutSeconds);
    }
    if (error instanceof TurnError) {
      manager.finishTurn(info);
      throw error.toError();
    }
    throw error instanceof GatewayError ? error : new GatewayError(502, 'internal', 'internal error');
  }
}

export type { ChatModelCatalog };
