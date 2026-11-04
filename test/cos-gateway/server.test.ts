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
import { FakeCos, deliverAnchor, deliverRevision, deliverTurn, endTurn } from './fake-cos.js';
import type { ChatModelCatalog } from '../../src/main/openai-gateway/catalog.js';
import { GATEWAY_ERRORS } from '../../src/main/openai-gateway/errors.js';

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
    stateDir: mkdtempSync(path.join(tmpdir(), 'cos-gateway-http-')),
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
    reasoning_effort: 'high'
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

test('v1/status reports the sign-in proof, live evidence and catalog state behind the bearer key', async () => {
  const fake = new FakeCos();
  fake.catalog = readyCatalog;
  fake.browserProof = { browserId: 'abc', version: '2.1.49', signedIn: true, since: 1_730_000_000_000 };
  fake.liveEvidence = { browserRunning: true, extensionFresh: true };
  const gateway = await startGateway(fake, gatewayConfigFromEnv({ GATEWAY_API_KEY: key }));

  const reply = await fetch(`${base(gateway)}/v1/status`, { headers: authed });
  assert.equal(reply.status, 200);
  assert.deepEqual(await reply.json(), {
    ok: true,
    protocol: PROTOCOL,
    chatgpt: {
      lastKnown: { signedIn: true, since: 1_730_000_000_000, browserVersion: '2.1.49' },
      live: { browserRunning: true, extensionFresh: true },
      effective: true
    },
    catalog: { state: 'ready', observedAt: 1_730_000_000_000, models: 1 }
  });

  const missing = await fetch(`${base(gateway)}/v1/status`);
  assert.equal(missing.status, 401);
});

test('v1/status never invents a sign-in state', async () => {
  const fake = new FakeCos();
  // The catalog may be cached while the proof says signed out, and a missing
  // proof must read as unknown (null), not as signed in.
  const cases: Array<{
    proof: { browserId: string; version: string; signedIn: boolean | null; since?: number | null } | null;
    expect: { lastKnown: { signedIn: boolean | null; since: number | null; browserVersion: string | null } }
  }> = [
    {
      proof: { browserId: 'abc', version: '2.1.49', signedIn: false, since: 9 },
      expect: { lastKnown: { signedIn: false, since: 9, browserVersion: '2.1.49' } }
    },
    {
      proof: null,
      expect: { lastKnown: { signedIn: null, since: null, browserVersion: null } }
    }
  ];
  for (const { proof, expect } of cases) {
    fake.browserProof = proof;
    fake.liveEvidence = { browserRunning: null, extensionFresh: null };
    const gateway = await startGateway(fake, gatewayConfigFromEnv({ GATEWAY_API_KEY: key }));
    const reply = await fetch(`${base(gateway)}/v1/status`, { headers: authed });
    assert.equal(reply.status, 200);
    const body = (await reply.json()) as { chatgpt: { lastKnown: { signedIn: boolean | null } } };
    assert.deepEqual(body.chatgpt.lastKnown, expect.lastKnown);
  }
});

test('v1/status effective is true only with live proof + running browser + fresh extension', async () => {
  const fake = new FakeCos();
  fake.catalog = readyCatalog;
  const gateway = await startGateway(fake, gatewayConfigFromEnv({ GATEWAY_API_KEY: key }));
  const status = async (): Promise<{ chatgpt: { effective: boolean | null } }> =>
    (await (await fetch(`${base(gateway)}/v1/status`, { headers: authed })).json()) as {
      chatgpt: { effective: boolean | null };
    };

  // All three positive -> true.
  fake.browserProof = { browserId: 'abc', version: '2.1.49', signedIn: true, since: 5 };
  fake.liveEvidence = { browserRunning: true, extensionFresh: true };
  assert.equal((await status()).chatgpt.effective, true);

  // Proof says signed in but the browser is not running (the stale-true
  // regression the backlog calls out): the live process probe says no.
  fake.browserProof = { browserId: 'abc', version: '2.1.49', signedIn: true, since: 5 };
  fake.liveEvidence = { browserRunning: false, extensionFresh: true };
  assert.equal((await status()).chatgpt.effective, false);

  // Signed-in proof but no live evidence at all -> unknown, never invented.
  fake.browserProof = { browserId: 'abc', version: '2.1.49', signedIn: true, since: 5 };
  fake.liveEvidence = { browserRunning: null, extensionFresh: null };
  assert.equal((await status()).chatgpt.effective, null);

  // Proof never answered and no live evidence -> unknown.
  fake.browserProof = { browserId: 'abc', version: '2.1.49', signedIn: null, since: null };
  fake.liveEvidence = { browserRunning: null, extensionFresh: null };
  assert.equal((await status()).chatgpt.effective, null);
});

test('the error matrix answers the exact status + code + Retry-After, bound to GATEWAY_ERRORS', async () => {
  const fake = new FakeCos();
  fake.catalog = readyCatalog;
  const gateway = await startGateway(fake, gatewayConfigFromEnv({ GATEWAY_API_KEY: key }));
  const url = `${base(gateway)}/v1/chat/completions`;
  const post = (body: unknown): Promise<Response> => fetch(url, {
    method: 'POST', headers: { ...authed, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const expectError = async (
    promise: Promise<Response>,
    code: string,
    retryAfter?: number,
  ): Promise<void> => {
    const reply = await promise;
    const spec = GATEWAY_ERRORS[code as keyof typeof GATEWAY_ERRORS];
    assert.equal(reply.status, spec.status, `${code} status`);
    assert.equal(reply.headers.get('retry-after'), retryAfter === undefined ? null : String(retryAfter),
      `${code} Retry-After`);
    const body = (await reply.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, code, `${code} code`);
  };

  // 429 busy — another message is already awaiting delivery (Retry-After exactly 5).
  fake.sendError = 'One message is already awaiting delivery for this chat.';
  await expectError(post({ messages: [{ role: 'user', content: 'x' }] }), 'busy', 5);

  // 502 chat unusable — a blocked conversation and a chat with no ChatGPT page.
  fake.sendError = 'Unblock this conversation before sending';
  await expectError(post({ messages: [{ role: 'user', content: 'x' }] }), 'chat_blocked');
  fake.sendError = 'This recording has no ChatGPT conversation';
  await expectError(post({ messages: [{ role: 'user', content: 'x' }] }), 'no_chat');

  // 409 id_conflict — the input id belongs to a different message.
  fake.sendError = 'Message id already belongs to different input';
  await expectError(post({ messages: [{ role: 'user', content: 'x' }] }), 'id_conflict');

  // 503 queue_full — CoS itself is unavailable.
  fake.sendError = 'The message queue is full';
  await expectError(post({ messages: [{ role: 'user', content: 'x' }] }), 'queue_full');
});

test('GET /v1/models returns model cards with only the efforts CoS observed', async () => {
  const fake = new FakeCos();
  fake.catalog = {
    state: 'ready',
    requestedAt: null,
    observedAt: 1_730_000_000_000,
    models: [
      { id: 'gpt-5.1', label: 'GPT-5.1', efforts: ['low', 'high'] },
      { id: 'gpt-6', label: 'GPT-6', efforts: [] }
    ]
  };
  const gateway = await startGateway(fake, gatewayConfigFromEnv({ GATEWAY_API_KEY: key }));
  const reply = await fetch(`${base(gateway)}/v1/models`, { headers: authed });
  assert.equal(reply.status, 200);
  const body = (await reply.json()) as { data: Array<Record<string, unknown>> };
  assert.equal(body.data.length, 2);

  const card = body.data[0]!;
  assert.deepEqual(card.efforts, ['low', 'high']);
  assert.deepEqual(card, {
    id: 'gpt-5.1',
    object: 'model',
    created: 1_730_000_000,
    owned_by: 'chat-on-steroids',
    efforts: ['low', 'high']
  });
  // CoS does not know a context window or a max-output figure; the card must
  // not invent them (the task forbids it).
  assert.equal('context_window' in card, false);
  assert.equal('max_output_tokens' in card, false);
  assert.equal('context_length' in card, false);

  // A model with no observed efforts still answers; null effort means ChatGPT's
  // composer auto lane, never an invented default effort.
  assert.deepEqual(body.data[1]!.efforts, []);
});

// --------------------------------------------------------------------------
// Streaming completions (`stream: true`): OpenAI chat.completion.chunk events
// on the same turn path, with cancellation and re-attachment preserved.
// --------------------------------------------------------------------------

const SSE_ACCEPT = { ...authed, 'content-type': 'application/json' };

interface Chunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: string; content?: string };
    logprobs: unknown;
    finish_reason: string | null;
  }>;
}

interface ParsedSse {
  chunks: Array<Chunk | { error: { code: string; message: string; type: string } }>;
  done: boolean;
  comments: string[];
}

/** Split an SSE body into its JSON frames, the [DONE] marker and comments. */
function parseSse(body: string): ParsedSse {
  const chunks: ParsedSse['chunks'] = [];
  const comments: string[] = [];
  let done = false;
  for (const frame of body.split('\n\n')) {
    if (frame.trim() === '') continue;
    if (frame.startsWith(':')) {
      comments.push(frame.replace(/^:\s*/, ''));
      continue;
    }
    const line = frame.split('\n').find((row) => row.startsWith('data: '));
    if (line === undefined) continue;
    const payload = line.slice('data: '.length);
    if (payload.trim() === '[DONE]') {
      done = true;
      continue;
    }
    chunks.push(JSON.parse(payload) as ParsedSse['chunks'][number]);
  }
  return { chunks, done, comments };
}

const contentOf = (frames: ParsedSse): string =>
  frames.chunks
    .flatMap((chunk) => ('choices' in chunk ? chunk.choices[0]?.delta.content ?? [] : []))
    .join('');

test('stream: true answers in-order chat.completion.chunk events', async () => {
  const fake = new FakeCos();
  fake.catalog = readyCatalog;
  const gateway = await startGateway(fake, gatewayConfigFromEnv({ GATEWAY_API_KEY: key }));

  const replyPromise = fetch(`${base(gateway)}/v1/chat/completions`, {
    method: 'POST',
    headers: SSE_ACCEPT,
    body: JSON.stringify({
      model: 'gpt-5.1',
      messages: [{ role: 'user', content: 'Say hi' }],
      stream: true
    })
  });
  await waitFor(() => fake.sent.length === 1);
  deliverTurn(fake, fake.sent[0]!.id, 'Hi there');

  const reply = await replyPromise;
  assert.equal(reply.status, 200);
  assert.match(reply.headers.get('content-type') ?? '', /^text\/event-stream/);
  const frames = parseSse(await reply.text());
  assert.equal(frames.done, true, 'the stream ends with [DONE]');

  const chunks = frames.chunks as Chunk[];
  assert.equal(chunks.length, 3, 'one role chunk, one content chunk, one finish chunk');
  const id = chunks[0]!.id;
  for (const chunk of chunks) {
    assert.equal(chunk.object, 'chat.completion.chunk');
    assert.equal(chunk.id, id, 'every chunk of one turn shares its id');
    assert.equal(chunk.model, 'gpt-5.1');
    assert.equal(typeof chunk.created, 'number');
    assert.equal(chunk.choices.length, 1);
    assert.equal(chunk.choices[0]!.index, 0);
    assert.equal(chunk.choices[0]!.logprobs, null);
  }
  assert.deepEqual(chunks[0]!.choices[0]!.delta, { role: 'assistant', content: '' });
  assert.equal(chunks[0]!.choices[0]!.finish_reason, null);
  assert.deepEqual(chunks[1]!.choices[0]!.delta, { content: 'Hi there' });
  assert.equal(chunks[1]!.choices[0]!.finish_reason, null);
  assert.deepEqual(chunks[2]!.choices[0]!.delta, {});
  assert.equal(chunks[2]!.choices[0]!.finish_reason, 'stop');
});

test('each answer revision streams only its new suffix, matching the whole answer', async () => {
  const fake = new FakeCos();
  fake.catalog = readyCatalog;
  const gateway = await startGateway(fake, gatewayConfigFromEnv({ GATEWAY_API_KEY: key }));
  const url = `${base(gateway)}/v1/chat/completions`;
  const messages = [{ role: 'user', content: 'Say hi' }];

  const streamed = fetch(url, {
    method: 'POST',
    headers: SSE_ACCEPT,
    body: JSON.stringify({ messages, stream: true })
  });
  await waitFor(() => fake.sent.length === 1);
  const inputId = fake.sent[0]!.id;
  deliverAnchor(fake, inputId);
  // CoS re-records one growing message under one id: three revisions.
  deliverRevision(fake, inputId, 'msg-1', 'Hi');
  deliverRevision(fake, inputId, 'msg-1', 'Hi there');
  deliverRevision(fake, inputId, 'msg-1', 'Hi there!', { final: true });
  endTurn(fake, inputId);

  const frames = parseSse(await (await streamed).text());
  const contents = (frames.chunks as Chunk[])
    .map((chunk) => chunk.choices[0]?.delta.content)
    .filter((text): text is string => typeof text === 'string' && text !== '');
  assert.deepEqual(contents, ['Hi', ' there', '!'], 'each revision contributes only its suffix');
  assert.equal(contentOf(frames), 'Hi there!');
  assert.equal(frames.done, true);

  // The same completed turn asked without `stream` answers the same content.
  const whole = fetch(url, {
    method: 'POST',
    headers: SSE_ACCEPT,
    body: JSON.stringify({ messages })
  });
  await waitFor(() => fake.sent.length === 2);
  deliverTurn(fake, fake.sent[1]!.id, 'Hi there!');
  const json = (await (await whole).json()) as { choices: Array<{ message: { content: string } }> };
  assert.equal(json.choices[0]?.message.content, contentOf(frames), 'SSE and JSON agree');
});

test('a mid-stream client disconnect stops the follow and keeps the turn re-attachable', async () => {
  const fake = new FakeCos();
  fake.catalog = readyCatalog;
  const gateway = await startGateway(fake, gatewayConfigFromEnv({ GATEWAY_API_KEY: key }));
  const url = `${base(gateway)}/v1/chat/completions`;
  const payload = { messages: [{ role: 'user', content: 'Long one' }], stream: true };

  const controller = new AbortController();
  const replyPromise = fetch(url, {
    method: 'POST', headers: SSE_ACCEPT, body: JSON.stringify(payload), signal: controller.signal
  });
  await waitFor(() => fake.sent.length === 1);
  const inputId = fake.sent[0]!.id;
  deliverAnchor(fake, inputId);
  deliverRevision(fake, inputId, 'msg-1', 'Half');

  const reply = await replyPromise;
  assert.equal(reply.status, 200);
  const reader = reply.body!.getReader();
  const decoder = new TextDecoder();
  let seen = '';
  while (!seen.includes('Half')) {
    const { value, done } = await reader.read();
    assert.equal(done, false, 'the stream stays open until the turn ends');
    if (value !== undefined) seen += decoder.decode(value, { stream: true });
  }

  await reader.cancel().catch(() => undefined);
  controller.abort();
  // Gone means gone: the follower stops within a poll, it does not keep
  // reading CoS's journal for a caller that no longer listens.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const readsAfterAbort = fake.readSessionEventsCalls;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(
    fake.readSessionEventsCalls - readsAfterAbort <= 2,
    `the follow stopped after the disconnect (${fake.readSessionEventsCalls - readsAfterAbort} extra reads)`
  );

  // The turn kept running in ChatGPT and its answer was recorded; the retry
  // re-attaches to that turn instead of sending the message a second time.
  deliverRevision(fake, inputId, 'msg-1', 'Half and half', { final: true });
  endTurn(fake, inputId);
  const retry = await fetch(url, {
    method: 'POST', headers: SSE_ACCEPT, body: JSON.stringify({ messages: payload.messages })
  });
  assert.equal(retry.status, 200);
  const json = (await retry.json()) as { choices: Array<{ message: { content: string } }> };
  assert.equal(json.choices[0]?.message.content, 'Half and half');
  assert.equal(fake.sent.length, 1, 'the retry re-attached by input id');
});

test('a streamed turn that times out sends an error frame and the retry re-attaches', async () => {
  const fake = new FakeCos();
  fake.catalog = readyCatalog;
  const gateway = await startGateway(fake, gatewayConfigFromEnv({ GATEWAY_API_KEY: key }), 120);
  const url = `${base(gateway)}/v1/chat/completions`;
  const payload = { messages: [{ role: 'user', content: 'Slow' }], stream: true };

  const first = fetch(url, { method: 'POST', headers: SSE_ACCEPT, body: JSON.stringify(payload) });
  await waitFor(() => fake.sent.length === 1);
  const timedOut = await first;
  assert.equal(timedOut.status, 200, 'the status line left before the turn failed');
  const failed = parseSse(await timedOut.text());
  assert.equal(failed.done, false, 'a failed stream never ends with [DONE]');
  const error = failed.chunks.at(-1) as { error: { code: string } };
  assert.equal(error.error.code, 'turn_timeout');

  // The turn keeps running; the retry streams the late answer, never re-sends.
  const retry = fetch(url, { method: 'POST', headers: SSE_ACCEPT, body: JSON.stringify(payload) });
  await new Promise((resolve) => setTimeout(resolve, 20));
  deliverTurn(fake, fake.sent[0]!.id, 'finally');
  const replied = await retry;
  assert.equal(replied.status, 200);
  const frames = parseSse(await replied.text());
  assert.equal(frames.done, true);
  assert.equal(contentOf(frames), 'finally');
  assert.equal(fake.sent.length, 1, 'the retry re-attached by input id');
});

test('a request that fails before the stream opens still answers JSON', async () => {
  const fake = new FakeCos();
  fake.catalog = readyCatalog;
  const gateway = await startGateway(fake, gatewayConfigFromEnv({ GATEWAY_API_KEY: key }));
  const reply = await fetch(`${base(gateway)}/v1/chat/completions`, {
    method: 'POST',
    headers: SSE_ACCEPT,
    body: JSON.stringify({
      model: 'nope', messages: [{ role: 'user', content: 'x' }], stream: true
    })
  });
  assert.equal(reply.status, 400);
  assert.match(reply.headers.get('content-type') ?? '', /^application\/json/);
  const body = (await reply.json()) as { error: { code: string } };
  assert.equal(body.error.code, 'model_unknown');
});

test('a non-boolean stream value keeps the whole-answer JSON reply', async () => {
  const fake = new FakeCos();
  fake.catalog = readyCatalog;
  const gateway = await startGateway(fake, gatewayConfigFromEnv({ GATEWAY_API_KEY: key }));
  const replyPromise = fetch(`${base(gateway)}/v1/chat/completions`, {
    method: 'POST',
    headers: SSE_ACCEPT,
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'Say hi' }], stream: 'yes'
    })
  });
  await waitFor(() => fake.sent.length === 1);
  deliverTurn(fake, fake.sent[0]!.id, 'whole');
  const reply = await replyPromise;
  assert.equal(reply.status, 200);
  const body = (await reply.json()) as { object: string };
  assert.equal(body.object, 'chat.completion');
});
