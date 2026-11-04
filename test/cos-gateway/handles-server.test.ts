/**
 * The gateway's per-handle serving contract (platform spec D1 / H-042), proven
 * offline on the embedded HTTP surface with synthetic two-handle fixtures:
 *
 *  - a handle identity is resolved against the registry; a foreign handle is a
 *    routing error,
 *  - readiness comes from live browser evidence and unknown is not ready,
 *  - the response names the serving handle by alias only,
 *  - conversation/session keys are handle-scoped, so a handle refuses to adopt
 *    another handle's session even if two instances share one state directory,
 *  - a rejected handle config fails closed with a generic error.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  gatewayConfigFromEnv,
  startOpenAiServer,
  type GatewayConfig,
  type OpenAiServer
} from '../../src/main/openai-gateway/openai-server.js';
import { FakeCos, deliverTurn } from './fake-cos.js';
import type { ChatModelCatalog } from '../../src/main/openai-gateway/catalog.js';
import type { HandleDefinition } from '../../src/main/openai-gateway/handles.js';

const key = 'test-key-123';
const authed = { authorization: `Bearer ${key}` };

const readyCatalog: ChatModelCatalog = {
  state: 'ready',
  requestedAt: null,
  observedAt: 1_730_000_000_000,
  models: [{ id: 'gpt-5.1', label: 'GPT-5.1', efforts: ['low', 'high'] }]
};

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

interface StartOptions {
  handles?: unknown;
  handle?: string;
  stateDir?: string;
}

function configFor(options: StartOptions = {}): GatewayConfig {
  const env: NodeJS.ProcessEnv = { GATEWAY_API_KEY: key };
  if (options.handles !== undefined) env.GATEWAY_HANDLES = JSON.stringify(options.handles);
  if (options.handle !== undefined) env.GATEWAY_HANDLE = options.handle;
  return gatewayConfigFromEnv(env);
}

async function startGateway(
  fake: FakeCos,
  config: GatewayConfig,
  stateDir = mkdtempSync(path.join(tmpdir(), 'cos-handles-')),
): Promise<OpenAiServer> {
  const gateway = await startOpenAiServer(fake, { ...config, port: 0 }, {
    stateDir,
    managerOptions: { pollMs: 1, queueWaitMs: 100, turnTimeoutMs: 5000, refTimers: true }
  });
  after(async () => gateway.stop());
  return gateway;
}

function signIn(fake: FakeCos): void {
  fake.browserProof = { browserId: 'fixture', version: '2.1.49', signedIn: true, since: 1_730_000_000_000 };
  fake.liveEvidence = { browserRunning: true, extensionFresh: true };
}

const base = (gateway: OpenAiServer): string => `http://127.0.0.1:${gateway.port}`;

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition never became true');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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

test('v1/status reports the handle, its readiness and the deployment map without account identity', async () => {
  const fake = new FakeCos();
  fake.catalog = readyCatalog;
  signIn(fake);
  const gateway = await startGateway(fake, configFor({ handles: handlesFixture(), handle: 'work' }));

  const reply = await fetch(`${base(gateway)}/v1/status`, { headers: authed });
  assert.equal(reply.status, 200);
  assert.equal(reply.headers.get('x-cos-handle'), 'work');
  const body = (await reply.json()) as {
    handle: {
      handle: string;
      status: string;
      ready: boolean;
      deployment: Array<{ model: string; status: string; ready: boolean }>;
    };
  };
  assert.equal(body.handle.handle, 'work');
  assert.equal(body.handle.status, 'ready');
  assert.equal(body.handle.ready, true);
  assert.deepEqual(body.handle.deployment.map((entry) => entry.model), [
    'gpt-5.1@cos-work',
    'gpt-5.1@cos-home'
  ]);
  assert.equal(body.handle.deployment[0]!.ready, true);
  // This instance cannot observe home: unknown is not ready.
  assert.equal(body.handle.deployment[1]!.status, 'unknown');
  assert.equal(body.handle.deployment[1]!.ready, false);

  const serialized = JSON.stringify(body);
  for (const hidden of [
    'work@example.invalid',
    'home@example.invalid',
    'keyring://fixture-work',
    '/srv/cos/fixtures/work/browser-profile',
    '/srv/cos/fixtures/home/user-data'
  ]) {
    assert.equal(serialized.includes(hidden), false, `status leaked ${hidden}`);
  }
});

test('a bare model id serves the local handle; the models list carries the identity', async () => {
  const fake = new FakeCos();
  fake.catalog = readyCatalog;
  signIn(fake);
  const gateway = await startGateway(fake, configFor({ handles: handlesFixture(), handle: 'work' }));

  const models = await fetch(`${base(gateway)}/v1/models`, { headers: authed });
  assert.equal(models.status, 200);
  const list = (await models.json()) as { data: Array<{ id: string }> };
  assert.deepEqual(list.data.map((entry) => entry.id), ['gpt-5.1@cos-work']);

  const replyPromise = post(gateway, {
    model: 'gpt-5.1@cos-work',
    messages: [{ role: 'user', content: 'Say hi' }],
    reasoning_effort: 'high'
  });
  await waitFor(() => fake.sent.length === 1);
  assert.equal(fake.sent[0]!.model, 'gpt-5.1', 'CoS receives the bare model id');
  deliverTurn(fake, fake.sent[0]!.id, 'Hi there');

  const reply = await replyPromise;
  assert.equal(reply.status, 200);
  assert.equal(reply.headers.get('x-cos-handle'), 'work');
  const body = (await reply.json()) as { model: string; choices: Array<{ message: { content: string } }> };
  assert.equal(body.model, 'gpt-5.1@cos-work');
  assert.equal(body.choices[0]!.message.content, 'Hi there');
  // No account identity anywhere on the wire.
  assert.equal(JSON.stringify([...reply.headers]).includes('example.invalid'), false);
});

test('readiness unknown is not ready: no turn is admitted until live evidence proves it', async () => {
  const fake = new FakeCos();
  fake.catalog = readyCatalog;
  // Signed in long ago, but the browser is not observed now.
  fake.browserProof = { browserId: 'fixture', version: '2.1.49', signedIn: null, since: null };
  const gateway = await startGateway(fake, configFor({ handles: handlesFixture(), handle: 'work' }));

  const reply = await post(gateway, { messages: [{ role: 'user', content: 'Hello?' }] });
  assert.equal(reply.status, 503);
  assert.equal(reply.headers.get('x-cos-handle'), 'work');
  const body = (await reply.json()) as { error: { code: string; message: string } };
  assert.equal(body.error.code, 'handle_not_ready');
  assert.match(body.error.message, /unobserved/);
  assert.equal(fake.sent.length, 0, 'nothing was admitted into an unproven account');
});

test('a handle with negative live evidence is not ready either', async () => {
  const fake = new FakeCos();
  fake.catalog = readyCatalog;
  fake.browserProof = { browserId: 'fixture', version: '2.1.49', signedIn: false, since: 9 };
  fake.liveEvidence = { browserRunning: true, extensionFresh: true };
  const gateway = await startGateway(fake, configFor({ handles: handlesFixture(), handle: 'work' }));

  const reply = await post(gateway, { messages: [{ role: 'user', content: 'Hello?' }] });
  assert.equal(reply.status, 503);
  const body = (await reply.json()) as { error: { code: string; message: string } };
  assert.equal(body.error.code, 'handle_not_ready');
  assert.match(body.error.message, /signedIn/);
  assert.equal(fake.sent.length, 0);
});

test('another handle identity is a routing error, not an invitation to that account', async () => {
  const fake = new FakeCos();
  fake.catalog = readyCatalog;
  signIn(fake);
  const gateway = await startGateway(fake, configFor({ handles: handlesFixture(), handle: 'work' }));

  const foreign = await post(gateway, {
    model: 'gpt-5.1@cos-home',
    messages: [{ role: 'user', content: 'Hello' }]
  });
  assert.equal(foreign.status, 400);
  assert.equal(((await foreign.json()) as { error: { code: string } }).error.code, 'handle_mismatch');

  const unknown = await post(gateway, {
    model: 'gpt-5.1@cos-ghost',
    messages: [{ role: 'user', content: 'Hello' }]
  });
  assert.equal(unknown.status, 400);
  assert.equal(((await unknown.json()) as { error: { code: string } }).error.code, 'handle_unknown');

  const malformed = await post(gateway, {
    model: 'gpt-5.1@cos-',
    messages: [{ role: 'user', content: 'Hello' }]
  });
  assert.equal(malformed.status, 400);
  assert.equal(((await malformed.json()) as { error: { code: string } }).error.code, 'handle_unknown');

  assert.equal(fake.sent.length, 0);
});

test('a disabled handle is refused with 403', async () => {
  const handles = handlesFixture();
  handles[1] = { ...handles[1]!, enabled: false };
  const fake = new FakeCos();
  fake.catalog = readyCatalog;
  signIn(fake);
  const gateway = await startGateway(fake, configFor({ handles, handle: 'work' }));

  const reply = await post(gateway, {
    model: 'gpt-5.1@cos-home',
    messages: [{ role: 'user', content: 'Hello' }]
  });
  assert.equal(reply.status, 403);
  assert.equal(((await reply.json()) as { error: { code: string } }).error.code, 'handle_disabled');
  assert.equal(fake.sent.length, 0);
});

test('session keys are handle-scoped: a handle refuses to adopt another handle\'s session', async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'cos-handles-shared-'));
  // Deliberately misconfigured: both "instances" share one state directory,
  // which the registry forbids in a real deploy. This is the defense-in-depth
  // case the denial protects.
  const workFake = new FakeCos();
  workFake.catalog = readyCatalog;
  signIn(workFake);
  const work = await startGateway(workFake, configFor({ handles: handlesFixture(), handle: 'work' }), stateDir);
  const sessionId = 'sess-shared-fixture';

  const first = post(work, { messages: [{ role: 'user', content: 'Opener' }] }, { 'x-cos-session': 'sess-shared-fixture' });
  await waitFor(() => workFake.sent.length === 1);
  // The CoS session id this account's turn created; home must never adopt it.
  const workSessionId = workFake.sent[0]!.id;
  deliverTurn(workFake, workSessionId, 'ok');
  assert.equal((await first).status, 200);
  await work.stop();

  const homeFake = new FakeCos();
  homeFake.catalog = readyCatalog;
  signIn(homeFake);
  const home = await startGateway(homeFake, configFor({ handles: handlesFixture(), handle: 'home' }), stateDir);

  const denied = await post(home, { messages: [{ role: 'user', content: 'Opener' }] }, { 'x-cos-session': workSessionId });
  assert.equal(denied.status, 409);
  assert.equal(denied.headers.get('x-cos-handle'), 'home');
  const body = (await denied.json()) as { error: { code: string; message: string } };
  assert.equal(body.error.code, 'cross_handle_session');
  assert.match(body.error.message, /another handle/);
  assert.equal(homeFake.sent.length, 0, 'nothing was sent into the other account\'s conversation');

  // The handle's own session still works: the denial is about the owner, not
  // about session overrides in general.
  const own = post(home, { messages: [{ role: 'user', content: 'Opener' }] }, { 'x-cos-session': 'sess-home-fixture' });
  await waitFor(() => homeFake.sent.length === 1);
  deliverTurn(homeFake, homeFake.sent[0]!.id, 'home ok');
  assert.equal((await own).status, 200);
});

test('an invalid handle registry fails closed with a generic error and no path detail', async () => {
  const handles = handlesFixture();
  handles[1] = { ...handles[1]!, browserProfile: handles[0]!.browserProfile };
  const fake = new FakeCos();
  fake.catalog = readyCatalog;
  signIn(fake);
  const gateway = await startGateway(fake, configFor({ handles, handle: 'work' }));

  assert.equal((await fetch(`${base(gateway)}/health`)).status, 200);
  const reply = await fetch(`${base(gateway)}/v1/status`, { headers: authed });
  assert.equal(reply.status, 503);
  const body = (await reply.json()) as { error: { code: string; message: string } };
  assert.equal(body.error.code, 'handle_registry_invalid');
  assert.equal(JSON.stringify(body).includes('/srv/cos/fixtures'), false, 'the registry detail never leaves the log');
  assert.equal(fake.sent.length, 0);
});

test('a handle registry without GATEWAY_HANDLE fails closed instead of guessing', async () => {
  const fake = new FakeCos();
  fake.catalog = readyCatalog;
  signIn(fake);
  const gateway = await startGateway(fake, configFor({ handles: handlesFixture() }));
  const reply = await fetch(`${base(gateway)}/v1/models`, { headers: authed });
  assert.equal(reply.status, 503);
  assert.equal(((await reply.json()) as { error: { code: string } }).error.code, 'handle_registry_invalid');
});

test('without handle config the gateway keeps the single-account behavior', async () => {
  const fake = new FakeCos();
  fake.catalog = readyCatalog;
  // No sign-in evidence at all: the legacy mode does not gate on readiness.
  const gateway = await startGateway(fake, configFor());
  const models = await fetch(`${base(gateway)}/v1/models`, { headers: authed });
  assert.equal(models.status, 200);
  const list = (await models.json()) as { data: Array<{ id: string }> };
  assert.deepEqual(list.data.map((entry) => entry.id), ['gpt-5.1']);
  assert.equal(models.headers.get('x-cos-handle'), null);

  const replyPromise = post(gateway, { messages: [{ role: 'user', content: 'Hi' }] });
  await waitFor(() => fake.sent.length === 1);
  deliverTurn(fake, fake.sent[0]!.id, 'Hi');
  assert.equal((await replyPromise).status, 200);
});
