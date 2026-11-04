/**
 * The additive public read surface (platform spec D4 / H-045), proven over the
 * embedded HTTP server with synthetic fixtures:
 *
 *  - `/v1/errors` publishes the same ledger the gateway enforces,
 *  - `/v1/handles` reports live readiness (unknown is not ready) and an
 *    observed catalog age, with no account identity on the wire,
 *  - `/v1/conversations` and `/v1/conversations/{id}/turns` are read-only,
 *    handle-scoped and keyset-paginated,
 *  - tool/function calls are documented UNSUPPORTED and refused instead of
 *    silently ignored,
 *  - the existing `/health`, `/v1/models` and `/v1/chat/completions` behavior
 *    is unchanged.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  gatewayConfigFromEnv,
  PROTOCOL,
  startOpenAiServer,
  type GatewayConfig,
  type OpenAiServer
} from '../../src/main/openai-gateway/openai-server.js';
import { ERROR_CONTRACT } from '../../src/main/openai-gateway/contract.js';
import type { ChatModelCatalog } from '../../src/main/openai-gateway/catalog.js';
import type { HandleDefinition } from '../../src/main/openai-gateway/handles.js';
import { FakeCos, deliverTurn } from './fake-cos.js';

const key = 'test-key-123';
const authed = { authorization: `Bearer ${key}` };

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

async function startGateway(
  fake: FakeCos,
  config: GatewayConfig,
  stateDir = mkdtempSync(path.join(tmpdir(), 'cos-gateway-api-')),
): Promise<OpenAiServer> {
  const gateway = await startOpenAiServer(fake, { ...config, port: 0 }, {
    stateDir,
    managerOptions: { pollMs: 1, queueWaitMs: 100, turnTimeoutMs: 5000, refTimers: true }
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

async function post(
  gateway: OpenAiServer,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return fetch(`${base(gateway)}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...authed, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
}

/** Start a turn and let it finish, so the store has a real conversation. */
async function runTurn(
  gateway: OpenAiServer,
  fake: FakeCos,
  session: string,
  text: string,
  body: Record<string, unknown> = {},
): Promise<void> {
  const reply = post(gateway, { messages: [{ role: 'user', content: text }], ...body }, {
    'x-cos-session': session
  });
  await waitFor(() => fake.sent.length > 0);
  deliverTurn(fake, fake.sent[fake.sent.length - 1]!.id, 'an answer');
  assert.equal((await reply).status, 200);
}

interface ErrorBody {
  error: { message: string; code: string; type: string };
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

function handleConfig(handle: string): GatewayConfig {
  return gatewayConfigFromEnv({
    GATEWAY_API_KEY: key,
    GATEWAY_HANDLES: JSON.stringify(handlesFixture()),
    GATEWAY_HANDLE: handle
  });
}

function signIn(fake: FakeCos): void {
  fake.browserProof = {
    browserId: 'fixture',
    version: '2.1.49',
    signedIn: true,
    since: 1_730_000_000_000
  };
  fake.liveEvidence = { browserRunning: true, extensionFresh: true };
}

// ------------------------------------------------------------------- errors

test('v1/errors publishes the ledger with its contract version', async () => {
  const fake = new FakeCos();
  const gateway = await startGateway(fake, gatewayConfigFromEnv({ GATEWAY_API_KEY: key }));

  const reply = await get(gateway, '/v1/errors');
  assert.equal(reply.status, 200);
  const body = (await reply.json()) as {
    object: string;
    contract_version: number;
    data: Array<{ code: string; status: number; class: string; may_failover: boolean; advice: string; retry_after: boolean }>;
  };
  assert.equal(body.object, 'list');
  assert.equal(body.contract_version, 1);
  assert.equal(body.data.length, ERROR_CONTRACT.length);
  assert.deepEqual(body.data, JSON.parse(JSON.stringify(ERROR_CONTRACT)));
  assert.equal(body.data.filter((row) => row.code === 'chat_error').length, 2);
  // The published advice is derived, not asserted: a throttle waits.
  const busy = body.data.find((row) => row.code === 'busy');
  assert.deepEqual(busy, {
    code: 'busy',
    status: 429,
    class: 'throttled',
    may_failover: false,
    advice: 'wait',
    retry_after: true
  });
  assert.equal((await fetch(`${base(gateway)}/v1/errors`)).status, 401);
});

// ------------------------------------------------------------------ handles

test('v1/handles is an empty list in single-account mode', async () => {
  const fake = new FakeCos();
  const gateway = await startGateway(fake, gatewayConfigFromEnv({ GATEWAY_API_KEY: key }));

  const reply = await get(gateway, '/v1/handles');
  assert.equal(reply.status, 200);
  assert.deepEqual(await reply.json(), { object: 'list', processing_attested: false, data: [] });
});

test('v1/handles reports live readiness and catalog age without account identity', async () => {
  const fake = new FakeCos();
  fake.catalog = readyCatalog;
  signIn(fake);
  const gateway = await startGateway(fake, handleConfig('work'));

  const reply = await get(gateway, '/v1/handles');
  assert.equal(reply.status, 200);
  const body = (await reply.json()) as {
    object: string;
    processing_attested: boolean;
    data: Array<{
      handle: string;
      object: string;
      local: boolean;
      status: string;
      ready: boolean;
      reason: string;
      evidence: { signedIn: boolean | null; browserRunning: boolean | null; extensionFresh: boolean | null };
      catalog: null | {
        state: string;
        observed_at: number | null;
        age_seconds: number | null;
        models: string[];
      };
    }>;
  };
  assert.equal(body.object, 'list');
  assert.equal(body.processing_attested, false);
  assert.equal(body.data.length, 2);

  const local = body.data.find((row) => row.handle === 'work');
  assert.ok(local);
  assert.equal(local.object, 'handle');
  assert.equal(local.local, true);
  assert.equal(local.status, 'ready');
  assert.equal(local.ready, true);
  assert.deepEqual(local.evidence, { signedIn: true, browserRunning: true, extensionFresh: true });
  assert.ok(local.catalog);
  assert.equal(local.catalog.state, 'ready');
  assert.equal(local.catalog.observed_at, 1_730_000_000);
  assert.ok(local.catalog.age_seconds !== null && local.catalog.age_seconds >= 0);
  assert.deepEqual(local.catalog.models, ['gpt-5.1'], 'base ids, not the deployment identity');

  const foreign = body.data.find((row) => row.handle === 'home');
  assert.ok(foreign);
  assert.equal(foreign.local, false);
  assert.equal(foreign.status, 'unknown');
  assert.equal(foreign.ready, false);
  assert.deepEqual(foreign.evidence, {
    signedIn: null,
    browserRunning: null,
    extensionFresh: null
  });
  assert.equal(foreign.catalog, null);

  const serialized = JSON.stringify(body);
  for (const hidden of [
    'work@example.invalid',
    'home@example.invalid',
    'keyring://fixture-work',
    '/srv/cos/fixtures/work/browser-profile',
    '/srv/cos/fixtures/home/user-data'
  ]) {
    assert.equal(serialized.includes(hidden), false, `handles leaked ${hidden}`);
  }
});

test('v1/handles never upgrades unobserved evidence to ready', async () => {
  const fake = new FakeCos();
  fake.catalog = readyCatalog;
  // Signed in long ago, but the browser and extension are not observed now.
  fake.browserProof = { browserId: 'fixture', version: '2.1.49', signedIn: null, since: null };
  const gateway = await startGateway(fake, handleConfig('work'));

  const reply = await get(gateway, '/v1/handles');
  const body = (await reply.json()) as {
    data: Array<{ handle: string; status: string; ready: boolean; reason: string }>;
  };
  const local = body.data.find((row) => row.handle === 'work');
  assert.ok(local);
  assert.equal(local.status, 'unknown');
  assert.equal(local.ready, false);
  assert.match(local.reason, /unobserved/);
});

// -------------------------------------------------------------------- tools

test('tool and function calls are refused with 400 instead of silently ignored', async () => {
  const fake = new FakeCos();
  fake.catalog = readyCatalog;
  const gateway = await startGateway(fake, gatewayConfigFromEnv({ GATEWAY_API_KEY: key }));
  const messages = [{ role: 'user', content: 'Use a tool' }];

  const refused: Array<Record<string, unknown>> = [
    { tools: [{ type: 'function', function: { name: 'lookup' } }] },
    { functions: [{ name: 'lookup' }] },
    { tool_choice: 'auto' },
    { tool_choice: { type: 'function', function: { name: 'lookup' } } },
    { function_call: { name: 'lookup' } },
    { function_call: 'auto' }
  ];
  for (const extra of refused) {
    const reply = await post(gateway, { messages, ...extra });
    assert.equal(reply.status, 400, JSON.stringify(extra));
    const body = (await reply.json()) as ErrorBody;
    assert.equal(body.error.code, 'tools_unsupported', JSON.stringify(extra));
    assert.equal(body.error.type, 'invalid_request_error');
    assert.match(body.error.message, /not supported/);
  }
  assert.equal(fake.sent.length, 0, 'no refused request reached the outbox');

  // A present non-array is a malformed body, not an unsupported feature.
  for (const extra of [{ tools: 'lookup' }, { functions: 3 }]) {
    const reply = await post(gateway, { messages, ...extra });
    assert.equal(reply.status, 400, JSON.stringify(extra));
    const body = (await reply.json()) as ErrorBody;
    assert.equal(body.error.code, 'invalid_body', JSON.stringify(extra));
    assert.match(body.error.message, /must be an array/);
  }
  assert.equal(fake.sent.length, 0);

  // An empty list and an explicit 'none' mean "no tools" and are accepted.
  const accepted = post(gateway, {
    messages,
    tools: [],
    tool_choice: 'none',
    function_call: null
  });
  await waitFor(() => fake.sent.length === 1);
  deliverTurn(fake, fake.sent[0]!.id, 'no tools needed');
  assert.equal((await accepted).status, 200);
});

// -------------------------------------------------------------- listing HTTP

test('conversations and turns are listed read-only from the store', async () => {
  const fake = new FakeCos();
  fake.catalog = readyCatalog;
  const gateway = await startGateway(fake, gatewayConfigFromEnv({ GATEWAY_API_KEY: key }));

  await runTurn(gateway, fake, 'conv-legacy', 'First question');
  const sessionId = fake.sent[0]!.id;

  const conversations = await get(gateway, '/v1/conversations');
  assert.equal(conversations.status, 200);
  const listed = (await conversations.json()) as {
    object: string;
    data: Array<{
      id: string;
      object: string;
      session: string | null;
      sent_users: number;
      turn_seq: number;
      updated_at: number;
      in_flight: null | { turn_id: string; started_at: number };
    }>;
    has_more: boolean;
    next_cursor: string | null;
  };
  assert.equal(listed.object, 'list');
  assert.equal(listed.has_more, false);
  assert.equal(listed.next_cursor, null);
  assert.equal(listed.data.length, 1);
  const row = listed.data[0]!;
  assert.equal(row.id, 'conv-legacy');
  assert.equal(row.object, 'conversation');
  assert.equal(row.session, sessionId);
  assert.equal(row.sent_users, 1);
  assert.equal(row.turn_seq, 1);
  assert.equal(typeof row.updated_at, 'number');
  assert.equal(row.in_flight, null);

  const turns = await get(gateway, '/v1/conversations/conv-legacy/turns');
  assert.equal(turns.status, 200);
  const page = (await turns.json()) as {
    object: string;
    data: Array<{
      id: string;
      object: string;
      conversation: string;
      seq: number;
      session: string | null;
      state: string;
      started_at: number;
      finished_at: number | null;
      attempts: number;
      last_error: string | null;
    }>;
    has_more: boolean;
    next_cursor: string | null;
  };
  assert.equal(page.object, 'list');
  assert.equal(page.has_more, false);
  assert.equal(page.next_cursor, null);
  assert.equal(page.data.length, 1);
  const turn = page.data[0]!;
  assert.equal(turn.id, sessionId);
  assert.equal(turn.object, 'turn');
  assert.equal(turn.conversation, 'conv-legacy');
  assert.equal(turn.seq, 0);
  assert.equal(turn.session, sessionId);
  assert.equal(turn.state, 'settled');
  assert.equal(typeof turn.started_at, 'number');
  assert.equal(typeof turn.finished_at, 'number');
  assert.equal(turn.attempts, 1);
  assert.equal(turn.last_error, null);
});

test('an unknown, foreign or malformed conversation is a 404, never a leak', async () => {
  const fake = new FakeCos();
  fake.catalog = readyCatalog;
  const gateway = await startGateway(fake, gatewayConfigFromEnv({ GATEWAY_API_KEY: key }));

  for (const route of [
    '/v1/conversations/missing/turns',
    '/v1/conversations/%zz/turns'
  ]) {
    const reply = await get(gateway, route);
    assert.equal(reply.status, 404, route);
    const body = (await reply.json()) as ErrorBody;
    assert.equal(body.error.code, 'not_found', route);
    assert.match(body.error.message, /no such conversation/, route);
  }
});

test('listing refuses an invalid cursor and an out-of-range limit', async () => {
  const fake = new FakeCos();
  fake.catalog = readyCatalog;
  const gateway = await startGateway(fake, gatewayConfigFromEnv({ GATEWAY_API_KEY: key }));

  const cursor = await get(gateway, '/v1/conversations?cursor=not-a-cursor');
  assert.equal(cursor.status, 400);
  assert.equal(((await cursor.json()) as ErrorBody).error.code, 'invalid_cursor');

  for (const limit of ['0', '101', 'abc', '1.5']) {
    const reply = await get(gateway, `/v1/conversations?limit=${limit}`);
    assert.equal(reply.status, 400, limit);
    const body = (await reply.json()) as ErrorBody;
    assert.equal(body.error.code, 'invalid_body', limit);
    assert.match(body.error.message, /between 1 and 100/, limit);
  }
});

// ------------------------------------------------------- handle-scoped listing

test('handle mode publishes only its own handle-scoped conversations', async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'cos-gateway-api-handles-'));
  const workFake = new FakeCos();
  workFake.catalog = readyCatalog;
  signIn(workFake);
  const work = await startGateway(workFake, handleConfig('work'), stateDir);

  await runTurn(work, workFake, 'conv-shared', 'Work opener');
  const sessionId = workFake.sent[0]!.id;
  const scopedKey = 'cos:work:conv-shared';

  const listed = (await (await get(work, '/v1/conversations')).json()) as {
    data: Array<{ id: string; session: string | null }>;
  };
  assert.deepEqual(listed.data.map((row) => row.id), [scopedKey]);
  assert.equal(listed.data[0]!.session, sessionId);

  const turns = await get(work, `/v1/conversations/${encodeURIComponent(scopedKey)}/turns`);
  assert.equal(turns.status, 200);
  const page = (await turns.json()) as { data: Array<{ conversation: string }> };
  assert.deepEqual(page.data.map((row) => row.conversation), [scopedKey]);

  await stopGateway(work);

  // A second instance on the same state directory is a different account: it
  // sees nothing of work's conversation and cannot even prove it exists.
  const homeFake = new FakeCos();
  homeFake.catalog = readyCatalog;
  signIn(homeFake);
  const home = await startGateway(homeFake, handleConfig('home'), stateDir);

  const homeList = (await (await get(home, '/v1/conversations')).json()) as {
    data: unknown[];
  };
  assert.deepEqual(homeList.data, []);

  const denied = await get(home, `/v1/conversations/${encodeURIComponent(scopedKey)}/turns`);
  assert.equal(denied.status, 404);
  assert.equal(((await denied.json()) as ErrorBody).error.code, 'not_found');
});

// ------------------------------------------------------- compatibility checks

test('health, models and completions keep their existing behavior', async () => {
  const fake = new FakeCos();
  fake.catalog = readyCatalog;
  const gateway = await startGateway(fake, gatewayConfigFromEnv({ GATEWAY_API_KEY: key }));

  const health = await fetch(`${base(gateway)}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, protocol: PROTOCOL, authenticated: true });

  const models = await get(gateway, '/v1/models');
  assert.equal(models.status, 200);
  const list = (await models.json()) as {
    data: Array<{ id: string; capabilities: { tool_calls: boolean; context_window: null } }>;
  };
  assert.equal(list.data[0]!.id, 'gpt-5.1');
  assert.equal(list.data[0]!.capabilities.tool_calls, false);
  assert.equal(list.data[0]!.capabilities.context_window, null);

  const replyPromise = post(gateway, { messages: [{ role: 'user', content: 'Hello' }] });
  await waitFor(() => fake.sent.length === 1);
  deliverTurn(fake, fake.sent[0]!.id, 'Hello back');
  const reply = await replyPromise;
  assert.equal(reply.status, 200);
  const completion = (await reply.json()) as {
    object: string;
    choices: Array<{ message: { role: string; content: string } }>;
  };
  assert.equal(completion.object, 'chat.completion');
  assert.equal(completion.choices[0]!.message.content, 'Hello back');
});
