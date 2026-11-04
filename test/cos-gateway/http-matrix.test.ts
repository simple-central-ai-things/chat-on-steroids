/**
 * The H-044 offline acceptance matrix (platform spec D3), proven the way the
 * real deployment is exercised: fake-CoS behind the embedded HTTP server.
 *
 *  - failure   every answer the published contract publishes, driven by a real
 *              request: 429 with a usable Retry-After, both `chat_error`
 *              shapes, the post-admission 502s, the 503s, and a 504 whose
 *              duplicate re-attaches instead of re-sending,
 *  - restart   a turn in flight across a gateway restart resumes from the
 *              SQLite store (the outbox, slot and turn rows are inspected on
 *              disk), and a turn that finished while the gateway was down is
 *              settled before the next turn of that conversation,
 *  - isolation two handle definitions never share a browser profile, userData,
 *              keyring, account or port; each handle's readiness comes from
 *              its own fake browser evidence (unknown stays unknown); and on
 *              one shared state directory a handle can neither re-attach, list
 *              nor adopt the other handle's conversation,
 *  - stop      an in-flight turn is interrupted (stream and whole-answer), the
 *              terminal `stopped` row is recorded once, an identical resend is
 *              a new turn, a terminal or unknown turn is safe, and a stop is
 *              handle-scoped and bearer-gated like every other route.
 *
 * Duplicate-request note: this gateway has no client-supplied request-id cache.
 * Its idempotency key is the deterministic turn id derived from
 * (conversation, seq, text, model, effort). A duplicate of a turn that is
 * still recorded in flight (a 504 or a restart) therefore re-attaches to the
 * recorded turn and returns its result without a second send. An identical
 * body after that turn settled is, by design, the NEXT turn of the
 * conversation and gets a fresh id; the negative test below pins that so
 * nobody "fixes" it into a silent cache that would swallow a repeated prompt.
 *
 * SOURCE ONLY: no live CoS, no VNC, no real browser and no account material.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  gatewayConfigFromEnv,
  startOpenAiServer,
  type GatewayConfig,
  type OpenAiServer
} from '../../src/main/openai-gateway/openai-server.js';
import { ERROR_CONTRACT } from '../../src/main/openai-gateway/contract.js';
import { GatewayStateStore } from '../../src/main/openai-gateway/state/store.js';
import type { ChatModelCatalog } from '../../src/main/openai-gateway/catalog.js';
import type { HandleDefinition } from '../../src/main/openai-gateway/handles.js';
import { FakeCos, deliverAnchor, deliverTurn, endTurn } from './fake-cos.js';

const key = 'test-key-123';
const authed = { authorization: `Bearer ${key}` };

/**
 * This host's `/tmp` is a RAM tmpfs and must not be used for test state. Every
 * directory this file creates lives under the operator's cache directory, or
 * under COS_GATEWAY_TEST_TMP when a CI run needs to relocate it. Nothing here
 * deletes: the no-rm rule leaves the small fixture directories in place.
 */
const TEST_TMP_ROOT =
  (process.env.COS_GATEWAY_TEST_TMP ?? '').trim() || path.join(homedir(), '.cache', 'opencode', 'tmp');

function stateDir(prefix = 'cos-http-matrix'): string {
  mkdirSync(TEST_TMP_ROOT, { recursive: true });
  return mkdtempSync(path.join(TEST_TMP_ROOT, `${prefix}-`));
}

const readyCatalog: ChatModelCatalog = {
  state: 'ready',
  requestedAt: null,
  observedAt: 1_730_000_000_000,
  models: [{ id: 'gpt-5.1', label: 'GPT-5.1', efforts: ['low', 'high'] }]
};

const started = new Set<OpenAiServer>();
after(async () => {
  for (const gateway of started) await gateway.stop();
  started.clear();
});

interface GatewayOptions {
  stateDir?: string;
  turnTimeoutMs?: number;
  pollMs?: number;
  refTimers?: boolean;
}

async function startGateway(
  fake: FakeCos,
  config: GatewayConfig,
  options: GatewayOptions = {},
): Promise<OpenAiServer> {
  const gateway = await startOpenAiServer(fake, { ...config, port: 0 }, {
    stateDir: options.stateDir ?? stateDir(),
    managerOptions: {
      pollMs: options.pollMs ?? 1,
      queueWaitMs: 100,
      turnTimeoutMs: options.turnTimeoutMs ?? 5000,
      refTimers: options.refTimers ?? true
    }
  });
  started.add(gateway);
  return gateway;
}

async function stopGateway(gateway: OpenAiServer): Promise<void> {
  if (!started.delete(gateway)) return;
  await gateway.stop();
}

const base = (gateway: OpenAiServer): string => `http://127.0.0.1:${gateway.port}`;

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition never became true');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function get(gateway: OpenAiServer, route: string, headers: Record<string, string> = authed) {
  return fetch(`${base(gateway)}${route}`, { headers });
}

function post(
  gateway: OpenAiServer,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${base(gateway)}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...authed, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
}

const user = (text: string): Array<{ role: string; content: string }> => [{ role: 'user', content: text }];

/** POST /v1/conversations/{key}/turns/{turnId}/stop (H-046). */
function stopTurn(
  gateway: OpenAiServer,
  conversation: string,
  turnId: string,
  headers: Record<string, string> = authed,
): Promise<Response> {
  const route = `/v1/conversations/${encodeURIComponent(conversation)}/turns/${encodeURIComponent(turnId)}/stop`;
  return fetch(`${base(gateway)}${route}`, { method: 'POST', headers });
}

function configFor(options: { handles?: unknown; handle?: string } = {}): GatewayConfig {
  const env: NodeJS.ProcessEnv = { GATEWAY_API_KEY: key };
  if (options.handles !== undefined) env.GATEWAY_HANDLES = JSON.stringify(options.handles);
  if (options.handle !== undefined) env.GATEWAY_HANDLE = options.handle;
  return gatewayConfigFromEnv(env);
}

function signIn(fake: FakeCos): void {
  fake.browserProof = { browserId: 'fixture', version: '2.1.49', signedIn: true, since: 1_730_000_000_000 };
  fake.liveEvidence = { browserRunning: true, extensionFresh: true };
}

function handlesFixture(): HandleDefinition[] {
  return [
    {
      handle: 'work',
      instance: { apiPort: 18801, vncPort: 18802 },
      browserProfile: '/srv/cos/fixtures/work/browser-profile',
      userData: '/srv/cos/fixtures/work/user-data',
      keyring: 'keyring://fixture-work',
      account: 'work@example.invalid',
      models: ['gpt-5.1'],
      order: 0
    },
    {
      handle: 'home',
      instance: { apiPort: 18811, vncPort: 18812 },
      browserProfile: '/srv/cos/fixtures/home/browser-profile',
      userData: '/srv/cos/fixtures/home/user-data',
      keyring: 'keyring://fixture-home',
      account: 'home@example.invalid',
      models: ['gpt-5.1'],
      order: 1
    }
  ];
}

/** The CoS session a delivered input belongs to (a new chat's id is its input id). */
function sessionOf(fake: FakeCos, inputId: string): string {
  const row = fake.inputs.get(inputId);
  if (row === undefined) throw new Error(`sessionOf: unknown input id ${inputId}`);
  return row.sessionId!;
}

/**
 * Deliver a full turn whose anchor lands LAST at its residence seq, the way CoS
 * recorded it for a turn queued before delivery: answer and turn_end are in the
 * journal before the user_message. Keyed-by-turnId re-attach must still find it.
 */
function deliverLateAnchorTurn(fake: FakeCos, inputId: string, answer: string, turnId: string): void {
  const sessionId = sessionOf(fake, inputId);
  fake.appendEvent(sessionId, { kind: 'assistant_message', final: true, message: { text: answer }, turnId });
  fake.appendEvent(sessionId, { kind: 'turn_end', outcome: 'completed', turnId });
  fake.appendEvent(sessionId, { kind: 'user_message', message: { text: '...' }, inputId, turnId });
  fake.notify(sessionId);
}

// ------------------------------------------------------------------ contract

interface ErrorEnvelope {
  error: { message: string; code: string; type: string };
}

function contractRow(code: string, status: number) {
  const row = ERROR_CONTRACT.find((entry) => entry.code === code && entry.status === status);
  assert.ok(row, `the published contract has a row for ${code} ${status}`);
  return row;
}

/** The envelope `type` the gateway publishes for a status (errors.ts). */
function envelopeType(status: number): string {
  if (status === 400) return 'invalid_request_error';
  if (status === 404) return 'not_found_error';
  if (status === 429) return 'rate_limit_error';
  if (status >= 500) return 'server_error';
  return 'api_error';
}

/**
 * Assert one real HTTP failure against the SAME published row a router reads:
 * status, Retry-After presence and the envelope type can never drift here.
 */
async function expectFailure(
  reply: Response | Promise<Response>,
  code: string,
  status: number,
): Promise<{ response: Response; body: ErrorEnvelope }> {
  const row = contractRow(code, status);
  const response = await reply;
  assert.equal(response.status, status, `${code} status`);
  const retryAfter = response.headers.get('retry-after');
  assert.equal(retryAfter !== null, row.retry_after, `${code} Retry-After presence`);
  if (row.retry_after) assert.ok(Number(retryAfter) >= 1, `${code} Retry-After is a positive delay`);
  const body = (await response.json()) as ErrorEnvelope;
  assert.equal(body.error.code, code);
  assert.equal(body.error.type, envelopeType(status));
  assert.equal(typeof body.error.message, 'string');
  return { response, body };
}

interface ConversationPage {
  object: string;
  data: Array<{
    id: string;
    object: string;
    session: string | null;
    sent_users: number;
    turn_seq: number;
    in_flight: { turn_id: string; started_at: number } | null;
  }>;
}

interface TurnPage {
  object: string;
  data: Array<{
    id: string;
    object: string;
    conversation: string;
    seq: number;
    session: string | null;
    native_turn_id: string | null;
    state: string;
    attempts: number;
    last_error: string | null;
  }>;
}

async function conversations(gateway: OpenAiServer): Promise<ConversationPage> {
  const reply = await get(gateway, '/v1/conversations');
  assert.equal(reply.status, 200);
  return (await reply.json()) as ConversationPage;
}

async function turnsOf(gateway: OpenAiServer, conversation: string): Promise<TurnPage> {
  const reply = await get(gateway, `/v1/conversations/${encodeURIComponent(conversation)}/turns`);
  assert.equal(reply.status, 200);
  return (await reply.json()) as TurnPage;
}

async function answerText(reply: Response): Promise<string> {
  const body = (await reply.json()) as { choices: Array<{ message: { content: string } }> };
  return body.choices[0]!.message.content;
}

interface StreamFrame {
  done?: boolean;
  error?: { code?: string; message?: string };
}

/** Decode the `data:` frames of an SSE answer (comments/heartbeats are skipped). */
function sseFrames(text: string): StreamFrame[] {
  const frames: StreamFrame[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6);
    if (data === '[DONE]') {
      frames.push({ done: true });
      continue;
    }
    try {
      frames.push(JSON.parse(data) as StreamFrame);
    } catch {
      // A comment or a partial line is not a frame.
    }
  }
  return frames;
}

// -------------------------------------------------------------- failure matrix

test('H-044/429: a chat_error with a ChatGPT deadline answers Retry-After and the contract says wait', async () => {
  const fake = new FakeCos();
  const gateway = await startGateway(fake, configFor());
  const conversation = 'sess-chat-error-429';
  const messages = user('Rate limited please');

  const reply = post(gateway, { messages }, { 'x-cos-session': conversation });
  await waitFor(() => fake.sent.length === 1);
  const inputId = fake.sent[0]!.id;
  deliverAnchor(fake, inputId);
  const retryAt = Date.now() + 4000;
  fake.appendEvent(sessionOf(fake, inputId), {
    kind: 'chat_error',
    message: { text: 'ChatGPT asked to slow down' },
    retryAt,
    recoverable: true
  });
  fake.notify(sessionOf(fake, inputId));

  const { response, body } = await expectFailure(reply, 'chat_error', 429);
  assert.equal(body.error.type, 'rate_limit_error');
  const retryAfter = Number(response.headers.get('retry-after'));
  // The deadline was four seconds out; the header is that deadline in whole
  // seconds (clock skew between the event and the mapping is at most a tick).
  assert.ok(retryAfter >= 1 && retryAfter <= 4, `Retry-After is the deadline in seconds (${retryAfter})`);
  assert.equal(contractRow('chat_error', 429).advice, 'wait');
  assert.equal(contractRow('chat_error', 429).retry_after, true);
  assert.equal(fake.sent.length, 1, 'the reported failure never re-sent the message');

  // A reported chat failure is terminal for that turn: the slot is cleared, so
  // a client that honors the deadline comes back to a fresh turn, not a stuck
  // conversation.
  const page = await conversations(gateway);
  assert.equal(page.data[0]!.id, conversation);
  assert.equal(page.data[0]!.in_flight, null);
  const turns = await turnsOf(gateway, conversation);
  assert.equal(turns.data[0]!.state, 'settled');
});

test('H-044/502: a chat_error without a deadline is a hard 502 with no Retry-After', async () => {
  const fake = new FakeCos();
  const gateway = await startGateway(fake, configFor());
  const conversation = 'sess-chat-error-502';

  const reply = post(gateway, { messages: user('Hard failure') }, { 'x-cos-session': conversation });
  await waitFor(() => fake.sent.length === 1);
  const inputId = fake.sent[0]!.id;
  deliverAnchor(fake, inputId);
  fake.appendEvent(sessionOf(fake, inputId), {
    kind: 'chat_error',
    message: { text: 'ChatGPT reported an error with no retry deadline' }
  });
  fake.notify(sessionOf(fake, inputId));

  const { response } = await expectFailure(reply, 'chat_error', 502);
  assert.equal(response.headers.get('retry-after'), null, 'a deadline-less failure must not invite a wait');
  assert.equal(contractRow('chat_error', 502).advice, 'none');
  assert.equal(contractRow('chat_error', 502).retry_after, false);
  assert.equal(fake.sent.length, 1);
});

test('H-044/502: a turn that ends without an answer and an undelivered input map to their own codes', async () => {
  // A turn_end before any final answer.
  const endedFake = new FakeCos();
  const endedGateway = await startGateway(endedFake, configFor());
  const endedConversation = 'sess-ended-fixture';
  const endedReply = post(endedGateway, { messages: user('Abort me') }, { 'x-cos-session': endedConversation });
  await waitFor(() => endedFake.sent.length === 1);
  const endedId = endedFake.sent[0]!.id;
  deliverAnchor(endedFake, endedId);
  endTurn(endedFake, endedId, 'aborted');
  const ended = await expectFailure(endedReply, 'turn_ended_without_answer', 502);
  assert.equal(ended.response.headers.get('retry-after'), null);
  assert.equal(contractRow('turn_ended_without_answer', 502).advice, 'none');
  const endedPage = await conversations(endedGateway);
  assert.equal(endedPage.data[0]!.in_flight, null, 'a reported turn_end clears the slot');
  assert.equal((await turnsOf(endedGateway, endedConversation)).data[0]!.state, 'settled');

  // An outbox row CoS itself marked failed: the anchor will never arrive.
  const lostFake = new FakeCos();
  const lostGateway = await startGateway(lostFake, configFor());
  const lostConversation = 'sess-undelivered-fixture';
  const lostReply = post(lostGateway, { messages: user('Lose me') }, { 'x-cos-session': lostConversation });
  await waitFor(() => lostFake.sent.length === 1);
  const lostId = lostFake.sent[0]!.id;
  const lostRow = lostFake.inputs.get(lostId)!;
  lostRow.state = 'failed';
  lostRow.error = 'the browser went away before delivery';

  const lost = await expectFailure(lostReply, 'not_delivered', 502);
  assert.match(lost.body.error.message, /browser went away/);
  assert.equal(contractRow('not_delivered', 502).advice, 'none');
  assert.equal(lostFake.sent.length, 1);
  // Honest durable state: the row failed, but only a later request can settle
  // the persisted slot (the follower got a GatewayError, not a TurnError). The
  // leftover-settling test below proves that next request recovers.
  const lostPage = await conversations(lostGateway);
  assert.equal(lostPage.data[0]!.in_flight?.turn_id, lostId);
  assert.equal((await turnsOf(lostGateway, lostConversation)).data[0]!.state, 'failed');
});

test('H-044/503: shutting_down answers JSON even for stream:true, and an unready catalog is models_not_ready', async () => {
  const fake = new FakeCos();
  fake.catalog = readyCatalog;
  const gateway = await startGateway(fake, configFor());

  // A pre-admission refusal must leave the status line intact, so a streaming
  // client still receives a JSON error instead of a half-open event stream.
  fake.sendError = 'The app is shutting down';
  const refused = await post(gateway, { messages: user('Anybody there?'), stream: true });
  assert.equal(refused.status, 503);
  assert.match(refused.headers.get('content-type') ?? '', /^application\/json/);
  assert.equal((await expectFailure(Promise.resolve(refused), 'shutting_down', 503)).body.error.type, 'server_error');
  assert.equal(refused.headers.get('retry-after'), null);
  // A 503 means this instance cannot serve, so a pool in front may fail over;
  // nothing of the request was accepted here.
  assert.equal(contractRow('shutting_down', 503).advice, 'failover');
  assert.equal(contractRow('shutting_down', 503).may_failover, true);
  assert.equal(fake.sent.length, 0);
  fake.sendError = null;

  // The catalog route publishes the pending state; a named model cannot be
  // resolved from a catalog that is not ready.
  fake.catalog = {
    state: 'pending',
    requestedAt: null,
    observedAt: null,
    models: [],
    waiting: 'Inspecting the picker'
  };
  const models = await get(gateway, '/v1/models');
  assert.equal(models.status, 503);
  assert.equal(((await models.json()) as ErrorEnvelope).error.code, 'models_not_ready');
  assert.equal(contractRow('models_not_ready', 503).advice, 'failover');
  await expectFailure(post(gateway, { model: 'gpt-5.1', messages: user('x') }), 'models_unknown', 503);
  assert.equal(contractRow('models_unknown', 503).advice, 'failover');
  assert.equal(fake.sent.length, 0, 'nothing was admitted before the catalog was ready');
});

test('H-044/504: the timeout keeps the slot and the duplicate re-attaches to the recorded answer', async () => {
  const fake = new FakeCos();
  const gateway = await startGateway(fake, configFor(), { turnTimeoutMs: 150 });
  const conversation = 'sess-timeout-fixture';
  const messages = user('This turn is slow');

  const timedOut = await post(gateway, { messages }, { 'x-cos-session': conversation });
  const { response } = await expectFailure(timedOut, 'turn_timeout', 504);
  assert.equal(response.headers.get('retry-after'), null, 'a timeout is not a throttle');
  assert.equal(contractRow('turn_timeout', 504).advice, 'reattach');
  assert.equal(fake.sent.length, 1);

  // The slot and the turn row survive the 504; the router can see the turn is
  // still running and reattach instead of retrying blind.
  const inputId = fake.sent[0]!.id;
  const page = await conversations(gateway);
  assert.equal(page.data[0]!.id, conversation);
  assert.equal(page.data[0]!.in_flight?.turn_id, inputId);
  const timedOutTurns = await turnsOf(gateway, conversation);
  assert.equal(timedOutTurns.data[0]!.id, inputId);
  assert.equal(timedOutTurns.data[0]!.state, 'timeout');
  assert.equal(timedOutTurns.data[0]!.attempts, 1);

  // The duplicate request re-derives the same turn id and waits for the late
  // answer; it never sends the prompt a second time.
  const retry = post(gateway, { messages }, { 'x-cos-session': conversation });
  await new Promise((resolve) => setTimeout(resolve, 20));
  deliverTurn(fake, inputId, 'the late answer');
  const replied = await retry;
  assert.equal(replied.status, 200);
  assert.equal(await answerText(replied), 'the late answer');
  assert.equal(fake.sent.length, 1, 'the duplicate re-attached by turn id');

  const settled = await conversations(gateway);
  assert.equal(settled.data[0]!.in_flight, null, 'the answer clears the slot');
  const settledTurns = await turnsOf(gateway, conversation);
  assert.equal(settledTurns.data[0]!.state, 'settled');
  assert.equal(settledTurns.data[0]!.attempts, 1, 'a re-attach is not a second delivery attempt');
});

test('H-044/429: a concurrent duplicate is session_busy with Retry-After and never a second send', async () => {
  const fake = new FakeCos();
  const gateway = await startGateway(fake, configFor());
  const conversation = 'sess-busy-fixture';
  const messages = user('One at a time');

  const first = post(gateway, { messages }, { 'x-cos-session': conversation });
  await waitFor(() => fake.sent.length === 1);
  const { response } = await expectFailure(
    post(gateway, { messages }, { 'x-cos-session': conversation }),
    'session_busy',
    429
  );
  // queueWaitMs is 100, so the published delay is one second.
  assert.equal(response.headers.get('retry-after'), '1');
  assert.equal(contractRow('session_busy', 429).advice, 'wait');
  assert.equal(fake.sent.length, 1, 'the duplicate was refused before the outbox');

  deliverTurn(fake, fake.sent[0]!.id, 'done');
  assert.equal((await first).status, 200);
  const page = await conversations(gateway);
  assert.equal(page.data[0]!.in_flight, null);
});

test('H-044/negative: an identical body after the turn settled is a fresh turn, not a cached result', async () => {
  const fake = new FakeCos();
  const gateway = await startGateway(fake, configFor());
  const conversation = 'sess-next-turn-fixture';
  const messages = user('Say this twice');

  const first = post(gateway, { messages }, { 'x-cos-session': conversation });
  await waitFor(() => fake.sent.length === 1);
  const firstId = fake.sent[0]!.id;
  deliverTurn(fake, firstId, 'first answer');
  assert.equal((await first).status, 200);

  // Same conversation, same body, same model/effort: the settled turn has
  // consumed its sequence, so this is the next turn and must be delivered.
  const second = post(gateway, { messages }, { 'x-cos-session': conversation });
  await waitFor(() => fake.sent.length === 2);
  const secondId = fake.sent[1]!.id;
  assert.notEqual(secondId, firstId, 'the next turn derives a fresh turn id');
  deliverTurn(fake, secondId, 'second answer');
  const replied = await second;
  assert.equal(replied.status, 200);
  assert.equal(await answerText(replied), 'second answer');

  const turns = await turnsOf(gateway, conversation);
  assert.deepEqual(turns.data.map((turn) => turn.id), [firstId, secondId]);
  assert.deepEqual(turns.data.map((turn) => turn.seq), [0, 1]);
  assert.equal(turns.data[1]!.state, 'settled');
});

test('H-044/late-anchor: a retry follows the turn by turnId when the anchor landed after the turn end', async () => {
  const fake = new FakeCos();
  const gateway = await startGateway(fake, configFor(), { turnTimeoutMs: 150 });
  const conversation = 'sess-late-anchor-fixture';
  const messages = user('Queued for hours');

  const timedOut = await post(gateway, { messages }, { 'x-cos-session': conversation });
  await expectFailure(timedOut, 'turn_timeout', 504);
  assert.equal(fake.sent.length, 1);
  const inputId = fake.sent[0]!.id;

  // The answer and turn_end were recorded BEFORE the user_message anchor. The
  // old positional scan (anchor.seq + 1) would see nothing and time out again.
  deliverLateAnchorTurn(fake, inputId, 'the recorded answer', 'turn-late-1');

  const retry = await post(gateway, { messages }, { 'x-cos-session': conversation });
  assert.equal(retry.status, 200);
  assert.equal(await answerText(retry), 'the recorded answer');
  assert.equal(fake.sent.length, 1, 'the late-anchor retry never re-sent');

  const turns = await turnsOf(gateway, conversation);
  assert.equal(turns.data[0]!.id, inputId);
  assert.equal(turns.data[0]!.native_turn_id, 'turn-late-1', "CoS's own turn id is kept as evidence");
  assert.equal(turns.data[0]!.state, 'settled');
});

// --------------------------------------------------------------- restart

test('H-044/restart: an in-flight turn survives a restart through the store and resumes without a second send', async () => {
  const dir = stateDir('cos-http-restart');
  const fake = new FakeCos();
  fake.catalog = readyCatalog;
  const conversation = 'sess-restart-fixture';
  const messages = user('Survive the restart');
  // refTimers:false keeps the abandoned follower's poll from holding the test
  // process after the gateway it belonged to is gone.
  const options: GatewayOptions = { stateDir: dir, turnTimeoutMs: 2000, pollMs: 20, refTimers: false };

  const first = await startGateway(fake, configFor(), options);
  const pending = post(first, { messages }, { 'x-cos-session': conversation });
  await waitFor(() => fake.sent.length === 1);
  const inputId = fake.sent[0]!.id;
  const abandoned = pending.catch(() => null);
  await stopGateway(first);
  await abandoned;

  // The durable half of the contract, read without a running gateway: the slot
  // still owes a turn, the outbox row was sent once, and the turn row is in
  // flight (exactly what a retry needs to reattach instead of re-sending).
  const stored = GatewayStateStore.open({ dir });
  try {
    const slot = stored.inFlight(conversation);
    assert.ok(slot, 'the in-flight slot survives the restart');
    assert.equal(slot.turnId, inputId);
    const outbox = stored.outboxRow(inputId);
    assert.equal(outbox?.state, 'sent');
    assert.equal(outbox?.attempts, 1);
    const turn = stored.turn(inputId);
    assert.equal(turn?.state, 'in_flight');
    assert.equal(turn?.attempts, 1);
    assert.equal(turn?.seq, 0);
  } finally {
    stored.close();
  }

  // Same state directory, fresh gateway: the identical request re-attaches and
  // the answer recorded after the restart completes it.
  const second = await startGateway(fake, configFor(), options);
  const retry = post(second, { messages }, { 'x-cos-session': conversation });
  await waitFor(() => fake.sent.length === 1);
  deliverTurn(fake, inputId, 'resumed after restart');
  const replied = await retry;
  assert.equal(replied.status, 200);
  assert.equal(await answerText(replied), 'resumed after restart');
  assert.equal(fake.sent.length, 1, 'the restarted gateway never re-sent the message');
  await stopGateway(second);

  const settled = GatewayStateStore.open({ dir });
  try {
    assert.equal(settled.inFlight(conversation), null, 'the slot is released by the answer');
    assert.equal(settled.outboxRow(inputId)?.state, 'answered');
    assert.equal(settled.turn(inputId)?.state, 'settled');
    assert.equal(settled.turn(inputId)?.attempts, 1);
  } finally {
    settled.close();
  }
});

test('H-044/restart: a turn that finished while the gateway was down is settled before the next turn', async () => {
  const dir = stateDir('cos-http-leftover');
  const fake = new FakeCos();
  fake.catalog = readyCatalog;
  const conversation = 'sess-leftover-fixture';
  const options: GatewayOptions = { stateDir: dir, turnTimeoutMs: 2000, pollMs: 20, refTimers: false };

  const first = await startGateway(fake, configFor(), options);
  const pending = post(first, { messages: user('Finished while down') }, { 'x-cos-session': conversation });
  await waitFor(() => fake.sent.length === 1);
  const leftoverId = fake.sent[0]!.id;
  const abandoned = pending.catch(() => null);
  await stopGateway(first);
  await abandoned;

  // While no gateway was listening, CoS finished the turn. The next, DIFFERENT
  // message must settle that leftover instead of losing or double-sending it.
  deliverTurn(fake, leftoverId, 'finished while down');

  const second = await startGateway(fake, configFor(), options);
  const next = post(second, {
    messages: [
      { role: 'user', content: 'Finished while down' },
      { role: 'assistant', content: 'finished while down' },
      { role: 'user', content: 'Then say two' }
    ]
  }, { 'x-cos-session': conversation });
  await waitFor(() => fake.sent.length === 2);
  const nextId = fake.sent[1]!.id;
  assert.notEqual(nextId, leftoverId);
  deliverTurn(fake, nextId, 'two');
  const replied = await next;
  assert.equal(replied.status, 200);
  assert.equal(await answerText(replied), 'two');
  await stopGateway(second);

  const stored = GatewayStateStore.open({ dir });
  try {
    // Both turns are kept: the leftover is settled (not erased), and the new
    // turn is answered. The conversation sequence advanced past both.
    const leftover = stored.turn(leftoverId);
    assert.equal(leftover?.state, 'settled');
    assert.equal(stored.outboxRow(leftoverId)?.state, 'answered');
    const nextTurn = stored.turn(nextId);
    assert.equal(nextTurn?.state, 'settled');
    assert.equal(nextTurn?.seq, 1);
    assert.equal(stored.turnsFor(conversation).length, 2);
    assert.equal(stored.inFlight(conversation), null);
  } finally {
    stored.close();
  }
});

// ------------------------------------------------------------- handle isolation

test('H-044/handles: shared profile, userData, keyring, account or port fails closed without leaking paths', async () => {
  const collisions: Array<{ field: string; apply: (handles: HandleDefinition[]) => void }> = [
    {
      field: 'browserProfile',
      apply: (handles) => { handles[1] = { ...handles[1]!, browserProfile: handles[0]!.browserProfile }; }
    },
    {
      field: 'userData',
      apply: (handles) => { handles[1] = { ...handles[1]!, userData: handles[0]!.userData }; }
    },
    {
      field: 'keyring',
      apply: (handles) => { handles[1] = { ...handles[1]!, keyring: handles[0]!.keyring }; }
    },
    {
      field: 'account',
      apply: (handles) => { handles[1] = { ...handles[1]!, account: handles[0]!.account }; }
    },
    {
      field: 'apiPort',
      apply: (handles) => { handles[1] = { ...handles[1]!, instance: { ...handles[1]!.instance, apiPort: handles[0]!.instance.apiPort } }; }
    }
  ];

  for (const { field, apply } of collisions) {
    const handles = handlesFixture();
    apply(handles);
    const fake = new FakeCos();
    fake.catalog = readyCatalog;
    signIn(fake);
    const gateway = await startGateway(fake, configFor({ handles, handle: 'work' }));

    const reply = await get(gateway, '/v1/status');
    assert.equal(reply.status, 503, `${field} collision must fail closed`);
    const body = (await reply.json()) as ErrorEnvelope;
    assert.equal(body.error.code, 'handle_registry_invalid', field);
    const serialized = JSON.stringify(body);
    for (const hidden of ['/srv/cos/fixtures', 'keyring://', 'example.invalid']) {
      assert.equal(serialized.includes(hidden), false, `${field} collision leaked ${hidden}`);
    }
    assert.equal(fake.sent.length, 0, `${field} collision admitted nothing`);
  }
});

test('H-044/handles: each handle reports readiness from its own fake browser evidence', async () => {
  const handles = handlesFixture();
  const workFake = new FakeCos();
  workFake.catalog = readyCatalog;
  signIn(workFake);
  const homeFake = new FakeCos();
  homeFake.catalog = readyCatalog;
  // Signed out long ago with no live evidence: unknown, which is NOT ready.
  homeFake.browserProof = { browserId: 'fixture', version: '2.1.49', signedIn: null, since: null };

  const work = await startGateway(workFake, configFor({ handles, handle: 'work' }));
  const home = await startGateway(homeFake, configFor({ handles, handle: 'home' }));

  interface HandleView {
    handle: string;
    status: string;
    ready: boolean;
    reason: string;
    evidence: { signedIn: boolean | null; browserRunning: boolean | null; extensionFresh: boolean | null };
  }
  const view = async (gateway: OpenAiServer): Promise<HandleView[]> => {
    const reply = await get(gateway, '/v1/handles');
    assert.equal(reply.status, 200);
    return ((await reply.json()) as { data: HandleView[] }).data;
  };

  const fromWork = await view(work);
  const workLocal = fromWork.find((row) => row.handle === 'work')!;
  assert.equal(workLocal.status, 'ready');
  assert.equal(workLocal.ready, true);
  assert.deepEqual(workLocal.evidence, { signedIn: true, browserRunning: true, extensionFresh: true });
  const homeFromWork = fromWork.find((row) => row.handle === 'home')!;
  assert.equal(homeFromWork.status, 'unknown', 'another handle is never observed from this process');
  assert.equal(homeFromWork.ready, false);
  assert.deepEqual(homeFromWork.evidence, { signedIn: null, browserRunning: null, extensionFresh: null });

  const fromHome = await view(home);
  const homeLocal = fromHome.find((row) => row.handle === 'home')!;
  assert.equal(homeLocal.status, 'unknown');
  assert.equal(homeLocal.ready, false);
  assert.match(homeLocal.reason, /unobserved/);
  const workFromHome = fromHome.find((row) => row.handle === 'work')!;
  assert.equal(workFromHome.status, 'unknown');
  assert.equal(workFromHome.ready, false);

  // The unproven handle admits nothing; the proven one serves its own turn.
  const refused = await post(home, { messages: user('Hello home?') });
  assert.equal(refused.status, 503);
  assert.equal(((await refused.json()) as ErrorEnvelope).error.code, 'handle_not_ready');
  assert.equal(homeFake.sent.length, 0);

  const served = post(work, { messages: user('Hello work') });
  await waitFor(() => workFake.sent.length === 1);
  assert.equal(workFake.sent[0]!.sessionId, null, 'work opened its own chat');
  deliverTurn(workFake, workFake.sent[0]!.id, 'work answer');
  assert.equal((await served).status, 200);
});

test('H-044/handles: on one shared state directory a handle cannot re-attach, list or adopt the other account', async () => {
  const dir = stateDir('cos-http-shared');
  const handles = handlesFixture();
  const conversation = 'sess-shared-job';
  const workKey = 'cos:work:sess-shared-job';
  const homeKey = 'cos:home:sess-shared-job';
  const options: GatewayOptions = { stateDir: dir, turnTimeoutMs: 1500, pollMs: 20, refTimers: false };

  const workFake = new FakeCos();
  workFake.catalog = readyCatalog;
  signIn(workFake);
  const work = await startGateway(workFake, configFor({ handles, handle: 'work' }), options);
  const pending = post(work, { messages: user('Shared job') }, { 'x-cos-session': conversation });
  await waitFor(() => workFake.sent.length === 1);
  const workInputId = workFake.sent[0]!.id;
  const workSessionId = sessionOf(workFake, workInputId);
  const abandoned = pending.catch(() => null);
  await stopGateway(work);
  await abandoned;

  // Same directory, different handle: the store still holds work's in-flight
  // turn, which is exactly the denial scenario the handle scope protects.
  const homeFake = new FakeCos();
  homeFake.catalog = readyCatalog;
  signIn(homeFake);
  const home = await startGateway(homeFake, configFor({ handles, handle: 'home' }), options);

  // Work's conversation is out of scope: not listed, not addressable, and a
  // 404 so it is indistinguishable from one that never existed.
  const before = await conversations(home);
  assert.deepEqual(before.data, [], 'the other handle\'s conversation is never listed');
  const foreignTurns = await get(home, `/v1/conversations/${encodeURIComponent(workKey)}/turns`);
  assert.equal(foreignTurns.status, 404);
  assert.equal(((await foreignTurns.json()) as ErrorEnvelope).error.code, 'not_found');

  // The identical request under home's scope is a NEW home turn: a fresh chat,
  // a different turn id, and no adoption of work's session.
  const homeReply = post(home, { messages: user('Shared job') }, { 'x-cos-session': conversation });
  await waitFor(() => homeFake.sent.length === 1);
  const homeInputId = homeFake.sent[0]!.id;
  assert.notEqual(homeInputId, workInputId, 'the turn id is scoped by handle');
  assert.equal(homeFake.sent[0]!.sessionId, null, 'home never adopts work\'s CoS session');
  deliverTurn(homeFake, homeInputId, 'home answer');
  assert.equal((await homeReply).status, 200);

  const after = await conversations(home);
  assert.deepEqual(after.data.map((row) => row.id), [homeKey]);
  assert.equal(after.data[0]!.in_flight, null);

  // Naming work's CoS session directly is refused instead of routed.
  const adopted = await post(home, { messages: user('Adopt me') }, { 'x-cos-session': workSessionId });
  assert.equal(adopted.status, 409);
  const adoptedBody = (await adopted.json()) as ErrorEnvelope;
  assert.equal(adoptedBody.error.code, 'cross_handle_session');
  assert.match(adoptedBody.error.message, /another handle/);
  assert.equal(homeFake.sent.length, 1, 'nothing was sent into the other account\'s conversation');
});

// ---------------------------------------------------------------------- stop

test('H-046/stop: a mid-flight stream is stopped, recorded once, and an identical resend is a new turn', async () => {
  const dir = stateDir('cos-http-stop-stream');
  const fake = new FakeCos();
  fake.catalog = readyCatalog;
  const gateway = await startGateway(fake, configFor(), { stateDir: dir });
  const conversation = 'sess-stop-stream';
  const messages = user('Long answer please');

  const streaming = post(gateway, { messages, stream: true }, { 'x-cos-session': conversation });
  await waitFor(() => fake.sent.length === 1);
  const stoppedId = fake.sent[0]!.id;
  deliverAnchor(fake, stoppedId);
  // Let the follower reach its wait loop, so the stop interrupts a running
  // follow instead of racing the anchor read.
  await new Promise((resolve) => setTimeout(resolve, 20));

  const reply = await stopTurn(gateway, conversation, stoppedId);
  assert.equal(reply.status, 200);
  const body = (await reply.json()) as TurnPage['data'][number] & { changed: boolean };
  assert.equal(body.object, 'turn');
  assert.equal(body.id, stoppedId);
  assert.equal(body.state, 'stopped');
  assert.equal(body.changed, true);

  const stream = await streaming;
  assert.equal(stream.status, 200);
  const frames = sseFrames(await stream.text());
  assert.equal(frames.some((frame) => frame.done === true), false,
    'a stopped turn never ends the stream with [DONE]');
  assert.equal(frames.at(-1)?.error?.code, 'turn_stopped', 'the stop is a failed stream, not a complete answer');
  assert.equal(contractRow('turn_stopped', 409).advice, 'none');
  assert.equal(contractRow('turn_stopped', 409).may_failover, false);

  // Terminal, not re-attachable: listing already shows the recorded state.
  const page = await conversations(gateway);
  assert.equal(page.data[0]!.in_flight, null, 'the stop clears the in-flight slot');
  assert.equal((await turnsOf(gateway, conversation)).data[0]!.state, 'stopped');

  // The sequence was consumed, so the same body is the NEXT turn.
  const again = post(gateway, { messages }, { 'x-cos-session': conversation });
  await waitFor(() => fake.sent.length === 2);
  const nextId = fake.sent[1]!.id;
  assert.notEqual(nextId, stoppedId, 'a stopped turn is never resumed or replayed');
  deliverTurn(fake, nextId, 'the later answer');
  const later = await again;
  assert.equal(later.status, 200);
  assert.equal(await answerText(later), 'the later answer');

  await stopGateway(gateway);
  const stored = GatewayStateStore.open({ dir });
  try {
    assert.equal(stored.turn(stoppedId)?.state, 'stopped');
    assert.equal(stored.outboxRow(stoppedId)?.state, 'cancelled', 'the stopped outbox row is cancelled');
    assert.equal(stored.turn(nextId)?.state, 'settled');
    assert.equal(stored.inFlight(conversation), null);
  } finally {
    stored.close();
  }
});

test('H-046/stop: a whole-answer request answers 409 turn_stopped and a late answer never revives it', async () => {
  const dir = stateDir('cos-http-stop-whole');
  const fake = new FakeCos();
  fake.catalog = readyCatalog;
  const gateway = await startGateway(fake, configFor(), { stateDir: dir });
  const conversation = 'sess-stop-whole';

  const pending = post(gateway, { messages: user('Answer eventually') }, { 'x-cos-session': conversation });
  await waitFor(() => fake.sent.length === 1);
  const inputId = fake.sent[0]!.id;
  deliverAnchor(fake, inputId);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const reply = await stopTurn(gateway, conversation, inputId);
  assert.equal(reply.status, 200);
  assert.equal(((await reply.json()) as { changed: boolean }).changed, true);

  const { response } = await expectFailure(pending, 'turn_stopped', 409);
  assert.equal(response.headers.get('retry-after'), null, 'a stop is not a throttle');

  // CoS may still record the answer of the turn it never cancelled. Nothing
  // follows it, and the recorded terminal state is not rewritten.
  deliverTurn(fake, inputId, 'too late');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal((await turnsOf(gateway, conversation)).data[0]!.state, 'stopped');
  assert.equal((await conversations(gateway)).data[0]!.in_flight, null);

  // A stopped turn is terminal: a repeated stop is an idempotent success.
  const repeat = await stopTurn(gateway, conversation, inputId);
  assert.equal(repeat.status, 200);
  const repeatBody = (await repeat.json()) as { state: string; changed: boolean };
  assert.equal(repeatBody.changed, false);
  assert.equal(repeatBody.state, 'stopped');

  await stopGateway(gateway);
  const stored = GatewayStateStore.open({ dir });
  try {
    assert.equal(stored.turn(inputId)?.state, 'stopped');
    assert.equal(stored.outboxRow(inputId)?.state, 'cancelled');
    assert.equal(stored.inFlight(conversation), null);
  } finally {
    stored.close();
  }
});

test('H-046/stop: terminal, unknown, malformed and unauthenticated stops keep the published contract', async () => {
  const fake = new FakeCos();
  fake.catalog = readyCatalog;
  const gateway = await startGateway(fake, configFor());
  const conversation = 'sess-stop-errors';

  const reply = post(gateway, { messages: user('Finish normally') }, { 'x-cos-session': conversation });
  await waitFor(() => fake.sent.length === 1);
  const inputId = fake.sent[0]!.id;
  deliverTurn(fake, inputId, 'normal answer');
  assert.equal((await reply).status, 200);

  // A settled turn is terminal: success with the recorded state, no change.
  const terminal = await stopTurn(gateway, conversation, inputId);
  assert.equal(terminal.status, 200);
  const terminalBody = (await terminal.json()) as { state: string; changed: boolean };
  assert.equal(terminalBody.changed, false);
  assert.equal(terminalBody.state, 'settled');

  // Unknown turn on a known conversation, and an unknown conversation.
  await expectFailure(stopTurn(gateway, conversation, 'no-such-turn'), 'not_found', 404);
  await expectFailure(stopTurn(gateway, 'sess-never-seen', inputId), 'not_found', 404);

  // A malformed percent escape in either segment is not a conversation this
  // gateway published; it never reaches the manager.
  const malformedKey = await fetch(
    `${base(gateway)}/v1/conversations/%E0%A4%A/turns/${encodeURIComponent(inputId)}/stop`,
    { method: 'POST', headers: authed },
  );
  await expectFailure(Promise.resolve(malformedKey), 'not_found', 404);
  const malformedTurn = await fetch(
    `${base(gateway)}/v1/conversations/${encodeURIComponent(conversation)}/turns/%E0%A4%A/stop`,
    { method: 'POST', headers: authed },
  );
  await expectFailure(Promise.resolve(malformedTurn), 'not_found', 404);

  // The same bearer gate as every other /v1/* route.
  const unauthenticated = await fetch(
    `${base(gateway)}/v1/conversations/${encodeURIComponent(conversation)}/turns/${encodeURIComponent(inputId)}/stop`,
    { method: 'POST' },
  );
  assert.equal(unauthenticated.status, 401);
  assert.equal(((await unauthenticated.json()) as ErrorEnvelope).error.code, 'unauthorized');
  assert.equal((await turnsOf(gateway, conversation)).data[0]!.state, 'settled', 'no denial mutated the turn');
});

test('H-046/stop: a stop scoped to another handle is denied and leaves that turn untouched', async () => {
  const dir = stateDir('cos-http-stop-shared');
  const handles = handlesFixture();
  const conversation = 'sess-stop-shared';
  const workKey = 'cos:work:sess-stop-shared';
  const options: GatewayOptions = { stateDir: dir, turnTimeoutMs: 5000, pollMs: 20, refTimers: false };

  const workFake = new FakeCos();
  workFake.catalog = readyCatalog;
  signIn(workFake);
  const work = await startGateway(workFake, configFor({ handles, handle: 'work' }), options);
  const pending = post(work, { messages: user('Shared stop') }, { 'x-cos-session': conversation });
  await waitFor(() => workFake.sent.length === 1);
  const workInputId = workFake.sent[0]!.id;
  deliverAnchor(workFake, workInputId);
  const abandoned = pending.catch(() => null);
  await stopGateway(work);
  await abandoned;

  const homeFake = new FakeCos();
  homeFake.catalog = readyCatalog;
  signIn(homeFake);
  const home = await startGateway(homeFake, configFor({ handles, handle: 'home' }), options);

  // A registered handle's key is a deliberate cross-account stop.
  await expectFailure(stopTurn(home, workKey, workInputId), 'cross_handle_session', 409);
  // An unregistered prefix and home's own unknown conversation are indistinguishable
  // from a conversation that never existed.
  await expectFailure(stopTurn(home, 'cos:ghost:sess-stop-shared', workInputId), 'not_found', 404);
  await expectFailure(stopTurn(home, 'cos:home:sess-stop-shared', workInputId), 'not_found', 404);
  await stopGateway(home);

  const stored = GatewayStateStore.open({ dir });
  try {
    assert.equal(stored.turn(workInputId)?.state, 'in_flight', 'the denied stop never touched the turn');
    assert.equal(stored.inFlight(workKey)?.turnId, workInputId);
  } finally {
    stored.close();
  }
});
