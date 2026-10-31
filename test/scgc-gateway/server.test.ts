import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  gatewayConfigFromEnv,
  PROTOCOL,
  startOpenAiServer,
  type OpenAiServer
} from '../../src/main/openai-gateway/openai-server.js';
import { FakeCos, deliverTurn } from './fake-cos.js';
import type { ChatModelCatalog } from '../../src/main/openai-gateway/catalog.js';

const key = 'test-key-123';
const readyCatalog: ChatModelCatalog = {
  state: 'ready',
  requestedAt: null,
  observedAt: 1_730_000_000_000,
  models: [{ id: 'gpt-5.1', label: 'GPT-5.1', efforts: ['low', 'high'] }]
};

async function startGateway(
  fake: FakeCos,
  config: Parameters<typeof startOpenAiServer>[1],
  turnTimeoutMs = 5000,
): Promise<OpenAiServer> {
  // Rebind onto an ephemeral port so parallel tests never fight over 8793.
  config = { ...config, port: 0 };
  const gateway = await startOpenAiServer(fake, config, {
    stateDir: mkdtempSync(path.join(tmpdir(), 'scgc-http-')),
    managerOptions: { pollMs: 1, queueWaitMs: 100, turnTimeoutMs, refTimers: true }
  });
  after(async () => gateway.stop());
  return gateway;
}

const base = (gateway: OpenAiServer): string => `http://127.0.0.1:${gateway.port}`;
const authed = { authorization: `Bearer ${key}` };

test('health is open and reports the protocol', async () => {
  const fake = new FakeCos();
  const gateway = await startGateway(fake, gatewayConfigFromEnv({ GATEWAY_API_KEY: key }));
  const reply = await fetch(`${base(gateway)}/health`);
  assert.equal(reply.status, 200);
  assert.deepEqual(await reply.json(), { ok: true, protocol: PROTOCOL, authenticated: true });
});

test('v1 routes require the bearer key', async () => {
  const fake = new FakeCos();
  const gateway = await startGateway(fake, gatewayConfigFromEnv({ GATEWAY_API_KEY: key }));
  const missing = await fetch(`${base(gateway)}/v1/models`);
  assert.equal(missing.status, 401);
  assert.ok(missing.headers.get('www-authenticate')?.startsWith('Bearer'));
  const wrong = await fetch(`${base(gateway)}/v1/models`, {
    headers: { authorization: 'Bearer nope' }
  });
  assert.equal(wrong.status, 401);
});

test('without GATEWAY_API_KEY the gateway fails closed with 503', async () => {
  const fake = new FakeCos();
  const gateway = await startGateway(fake, gatewayConfigFromEnv({}));
  const reply = await fetch(`${base(gateway)}/v1/models`, { headers: authed });
  assert.equal(reply.status, 503);
  const body = (await reply.json()) as { error: { code: string } };
  assert.equal(body.error.code, 'gateway_unconfigured');
  // health stays open either way
  assert.equal((await fetch(`${base(gateway)}/health`)).status, 200);
});

test('models answer 503 until the catalog is ready, then plain ids', async () => {
  const fake = new FakeCos();
  fake.catalog = { ...readyCatalog, state: 'pending', waiting: 'Inspecting the picker' };
  const gateway = await startGateway(fake, gatewayConfigFromEnv({ GATEWAY_API_KEY: key }));

  const pending = await fetch(`${base(gateway)}/v1/models`, { headers: authed });
  assert.equal(pending.status, 503);

  fake.catalog = readyCatalog;
  const reply = await fetch(`${base(gateway)}/v1/models`, { headers: authed });
  assert.equal(reply.status, 200);
  const body = (await reply.json()) as { object: string; data: Array<{ id: string; object: string }> };
  assert.equal(body.object, 'list');
  assert.equal(body.data[0]?.id, 'gpt-5.1');
  assert.equal(body.data[0]?.object, 'model');
});

test('chat completions run a full turn and answer in OpenAI shape', async () => {
  const fake = new FakeCos();
  fake.catalog = readyCatalog;
  const gateway = await startGateway(fake, gatewayConfigFromEnv({ GATEWAY_API_KEY: key }));

  const request = {
    model: 'gpt-5.1',
    messages: [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Say hi' }
    ],
    reasoning_effort: 'high',
    stream: true
  };
  // Answer as soon as the message is admitted, like CoS delivering a turn.
  const replyPromise = fetch(`${base(gateway)}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...authed, 'content-type': 'application/json' },
    body: JSON.stringify(request)
  });
  await waitFor(() => fake.sent.length === 1);
  deliverTurn(fake, fake.sent[0]!.id, 'Hi there');

  const reply = await replyPromise;
  assert.equal(reply.status, 200);
  const body = (await reply.json()) as {
    object: string;
    model: string;
    usage: unknown;
    choices: Array<{ finish_reason: string; message: { role: string; content: string } }>;
  };
  assert.equal(body.object, 'chat.completion');
  assert.equal(body.model, 'gpt-5.1');
  assert.equal(body.usage, null);
  assert.equal(body.choices[0]?.message.content, 'Hi there');
  assert.equal(body.choices[0]?.finish_reason, 'stop');

  // The admission carried the folded context prefix and the chosen model + effort.
  const admitted = fake.sent[0]!;
  assert.ok(admitted.text.startsWith('[Context for this conversation]'));
  assert.ok(admitted.text.includes('Say hi'));
  assert.equal(admitted.sessionId, null, 'the first turn starts a new chat');
  assert.equal(admitted.model, 'gpt-5.1');
  assert.equal(admitted.reasoningEffort, 'high');
});

test('a second turn of the same conversation sends only the newest delta', async () => {
  const fake = new FakeCos();
  fake.catalog = readyCatalog;
  const gateway = await startGateway(fake, gatewayConfigFromEnv({ GATEWAY_API_KEY: key }));
  const url = `${base(gateway)}/v1/chat/completions`;

  const first = await (async () => {
    const promise = fetch(url, {
      method: 'POST', headers: { ...authed, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'First' }] })
    });
    await waitFor(() => fake.sent.length === 1);
    deliverTurn(fake, fake.sent[0]!.id, 'one');
    return (await (await promise).json()) as { id: string };
  })();
  void first;

  const second = await (async () => {
    const promise = fetch(url, {
      method: 'POST', headers: { ...authed, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [
        { role: 'user', content: 'First' },
        { role: 'assistant', content: 'one' },
        { role: 'user', content: 'Second' }
      ] })
    });
    await waitFor(() => fake.sent.length === 2);
    const admitted = fake.sent[1]!;
    assert.equal(admitted.text, 'Second', 'only the newest user delta goes out');
    assert.ok(admitted.sessionId !== null, 'the conversation continues its session');
    deliverTurn(fake, admitted.id, 'two');
    return (await (await promise).json()) as { choices: Array<{ message: { content: string } }> };
  })();
  assert.equal(second.choices[0]?.message.content, 'two');
});

test('unknown models and bad bodies are 400s', async () => {
  const fake = new FakeCos();
  fake.catalog = readyCatalog;
  const gateway = await startGateway(fake, gatewayConfigFromEnv({ GATEWAY_API_KEY: key }));
  const url = `${base(gateway)}/v1/chat/completions`;
  const post = (body: unknown): Promise<Response> => fetch(url, {
    method: 'POST', headers: { ...authed, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });

  const badModel = await post({ messages: [{ role: 'user', content: 'x' }], model: 'nope' });
  assert.equal(badModel.status, 400);
  const badEffort = await post({
    messages: [{ role: 'user', content: 'x' }], model: 'gpt-5.1', reasoning_effort: 'turbo'
  });
  assert.equal(badEffort.status, 400);
  const badRole = await post({ messages: [{ role: 'tool', content: 'x' }] });
  assert.equal(badRole.status, 400);
  const noUser = await post({ messages: [{ role: 'assistant', content: 'x' }] });
  assert.equal(noUser.status, 400);
  const notJson = await fetch(url, { method: 'POST', headers: authed, body: 'nope' });
  assert.equal(notJson.status, 400);
  const trailingAssistant = await post({
    messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }]
  });
  assert.equal(trailingAssistant.status, 400, 'the last message must be a user message');
});

test('a busy session answers 429 with Retry-After', async () => {
  const fake = new FakeCos();
  fake.catalog = readyCatalog;
  const gateway = await startGateway(fake, gatewayConfigFromEnv({ GATEWAY_API_KEY: key }));
  const url = `${base(gateway)}/v1/chat/completions`;
  const body = { messages: [{ role: 'user', content: 'Hello' }] };
  const options = {
    method: 'POST', headers: { ...authed, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  };

  const first = fetch(url, options);
  await waitFor(() => fake.sent.length === 1);
  // The first turn stays in flight; the second request for the same
  // conversation cannot wait the bounded queue time.
  const second = await fetch(url, options);
  assert.equal(second.status, 429);
  assert.ok(Number(second.headers.get('retry-after')) > 0);
  const body2 = (await second.json()) as { error: { code: string } };
  assert.equal(body2.error.code, 'session_busy');

  deliverTurn(fake, fake.sent[0]!.id, 'done');
  assert.equal((await first).status, 200);
});

test('a 504 retry re-attaches to the running turn instead of double-sending', async () => {
  const fake = new FakeCos();
  fake.catalog = readyCatalog;
  const gateway = await startGateway(fake, gatewayConfigFromEnv({ GATEWAY_API_KEY: key }), 150);
  const url = `${base(gateway)}/v1/chat/completions`;
  const options = {
    method: 'POST',
    headers: { ...authed, 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Slow' }] })
  };

  const first = fetch(url, options);
  await waitFor(() => fake.sent.length === 1);
  const timedOut = await first;
  assert.equal(timedOut.status, 504);
  const timedBody = (await timedOut.json()) as { error: { code: string } };
  assert.equal(timedBody.error.code, 'turn_timeout');

  // The turn delivers late; the retry must re-attach by input id, never
  // re-send, and answer with the late result.
  const retry = fetch(url, options);
  await new Promise((resolve) => setTimeout(resolve, 20));
  deliverTurn(fake, fake.sent[0]!.id, 'finally');
  const replied = await retry;
  assert.equal(replied.status, 200);
  const body = (await replied.json()) as { choices: Array<{ message: { content: string } }> };
  assert.equal(body.choices[0]?.message.content, 'finally');
  assert.equal(fake.sent.length, 1, 'the retry re-attached by input id');
});

test('X-CoS-Session overrides the derived conversation key', async () => {
  const fake = new FakeCos();
  fake.catalog = readyCatalog;
  const gateway = await startGateway(fake, gatewayConfigFromEnv({ GATEWAY_API_KEY: key }));
  const url = `${base(gateway)}/v1/chat/completions`;

  const post = async (messages: Array<{ role: string; content: string }>, header?: string) => {
    const promise = fetch(url, {
      method: 'POST',
      headers: { ...authed, 'content-type': 'application/json', ...(header ? { 'x-cos-session': header } : {}) },
      body: JSON.stringify({ messages })
    });
    await waitFor(() => fake.sent.length === 1);
    const id = fake.sent[0]!.id;
    deliverTurn(fake, id, 'ok');
    return (await (await promise).json()) as unknown;
  };

  // Two different openers, one shared override: the same derived input id.
  await post([{ role: 'user', content: 'Alpha' }], 'shared-session');
  assert.equal(fake.sent.length, 1);
  const firstId = fake.sent[0]!.id;

  // A different opener under the same override is the same conversation.
  const overrideTurn = await (async () => {
    const promise = fetch(url, {
      method: 'POST',
      headers: { ...authed, 'content-type': 'application/json', 'x-cos-session': 'shared-session' },
      body: JSON.stringify({ messages: [
        { role: 'user', content: 'Alpha' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'Beta delta' }
      ] })
    });
    await waitFor(() => fake.sent.length === 2);
    const admitted = fake.sent[1]!;
    assert.equal(admitted.text, 'Beta delta');
    assert.equal(admitted.sessionId, firstId, 'the override maps onto the same CoS session');
    deliverTurn(fake, admitted.id, 'ok2');
    return (await (await promise).json()) as unknown;
  })();
  void overrideTurn;
});

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition never became true');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
