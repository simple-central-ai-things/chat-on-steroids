import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { STREAM_DONE, SseWriter, completionChunk } from '../../src/main/openai-gateway/sse.js';

/**
 * Just enough of a `ServerResponse` for the writer: it records frames, can
 * report backpressure, and emits 'close'/'drain' like the real socket. The
 * writer only uses these members, so a full socket is unnecessary.
 */
class FakeResponse extends EventEmitter {
  readonly frames: string[] = [];
  accepting = true;
  writableEnded = false;
  destroyed = false;
  endCalls = 0;
  /** When set, `write` throws instead of recording, like a torn socket. */
  throwOnWrite = false;

  write(text: string): boolean {
    if (this.destroyed) throw new Error('write after destroy');
    if (this.throwOnWrite) {
      this.throwOnWrite = false;
      throw new Error('EPIPE');
    }
    this.frames.push(text);
    return this.accepting;
  }

  end(): void {
    this.endCalls += 1;
    this.writableEnded = true;
    // A real response emits 'close' once its socket is done with it.
    this.emit('close');
  }
}

const fake = (): FakeResponse => new FakeResponse();
const writerFor = (
  res: FakeResponse,
  onDisconnect?: () => void
): SseWriter => new SseWriter(res as unknown as ServerResponse, { onDisconnect });

const settle = async (): Promise<void> => {
  // One macrotask turn drains the writer's promise chain, which only uses
  // microtasks plus the fake's synchronous events.
  await new Promise<void>((resolve) => setImmediate(resolve));
};

test('completionChunk carries the OpenAI chat.completion.chunk shape', () => {
  const meta = { id: 'chatcmpl-1', created: 1_700_000_000, model: 'gpt-6' };
  const first = completionChunk(meta, { role: 'assistant' });
  assert.deepEqual(first, {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model: 'gpt-6',
    choices: [{ index: 0, delta: { role: 'assistant' }, logprobs: null, finish_reason: null }]
  });
  const last = completionChunk(meta, {}, 'stop');
  assert.deepEqual(last.choices[0]?.delta, {});
  assert.equal(last.choices[0]?.finish_reason, 'stop');
  assert.equal(last.id, first.id);
  assert.equal(last.created, first.created);
});

test('frames are written whole, in call order, and [DONE] is last', async () => {
  const res = fake();
  const writer = writerFor(res);

  void writer.send({ n: 1 });
  void writer.comment('keep-alive');
  void writer.send({ n: 2 });
  void writer.raw(STREAM_DONE);
  await writer.close();

  assert.deepEqual(res.frames, [
    'data: {"n":1}\n\n',
    ': keep-alive\n\n',
    'data: {"n":2}\n\n',
    'data: [DONE]\n\n'
  ]);
  assert.equal(res.endCalls, 1);
  // Our own close is not a client disconnect.
  assert.equal(writer.disconnected, false);
});

test('a write the socket refuses waits for drain before the next frame', async () => {
  const res = fake();
  const writer = writerFor(res);
  res.accepting = false;

  let firstDone = false;
  const first = writer.send({ n: 1 }).then(() => {
    firstDone = true;
  });
  void writer.send({ n: 2 });
  await settle();
  // Frame one is on the wire but unacknowledged, and frame two has not
  // overtaken it even though it was queued right after.
  assert.deepEqual(res.frames, ['data: {"n":1}\n\n']);
  assert.equal(firstDone, false);

  res.accepting = true;
  res.emit('drain');
  await first;
  await settle();
  assert.deepEqual(res.frames, ['data: {"n":1}\n\n', 'data: {"n":2}\n\n']);
  await writer.close();
});

test('a client disconnect resolves a pending write and reports the departure once', async () => {
  const res = fake();
  let disconnects = 0;
  const writer = writerFor(res, () => {
    disconnects += 1;
  });
  res.accepting = false;

  const pending = writer.send({ n: 1 });
  await settle();
  assert.equal(disconnects, 0);

  res.emit('close');
  await pending;
  assert.equal(disconnects, 1);
  assert.equal(writer.disconnected, true);

  // Nothing more reaches a socket nobody reads, and no second notice.
  await writer.send({ n: 2 });
  await writer.close();
  assert.equal(disconnects, 1);
  assert.deepEqual(res.frames, ['data: {"n":1}\n\n']);
});

test('a write error is a departure, not an exception in the follower', async () => {
  const res = fake();
  const writer = writerFor(res);
  res.throwOnWrite = true;

  await writer.send({ n: 1 });
  assert.equal(writer.closed, true);
  await writer.send({ n: 2 });
  assert.deepEqual(res.frames, []);
  await writer.close();
});

test('the keep-alive comment repeats until it is stopped', async () => {
  const res = fake();
  const writer = writerFor(res);
  writer.startHeartbeat(5, 'still-here');
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  writer.stopHeartbeat();
  const sent = res.frames.length;
  assert.ok(sent >= 2, `expected repeated comments, got ${sent}`);
  assert.ok(res.frames.every((frame) => frame === ': still-here\n\n'));

  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.equal(res.frames.length, sent);
  await writer.close();
});

test('a non-positive heartbeat interval sends no comment', async () => {
  const res = fake();
  const writer = writerFor(res);
  writer.startHeartbeat(0);
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(res.frames, []);
  await writer.close();
  assert.equal(writer.disconnected, false);
});
