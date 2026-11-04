/**
 * Pool failover classification (platform spec D1 / H-042): only a classified
 * handle unavailability may move a request to another account, Retry-After is
 * honored, and a 504 is never "failed over" because its turn is still running.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyFailure,
  planFailover,
  poolCandidates,
  readyPool,
  UNAVAILABLE_CODES,
  type PoolCandidate
} from '../../src/main/openai-gateway/failover.js';
import { HandleRegistry, type HandleReadiness, type HandleDefinition } from '../../src/main/openai-gateway/handles.js';
import { GATEWAY_ERRORS } from '../../src/main/openai-gateway/errors.js';

function fixture(): HandleDefinition[] {
  return [
    {
      handle: 'work',
      instance: { apiPort: 18801, vncPort: 18802 },
      browserProfile: '/srv/cos/fixtures/work/browser-profile',
      userData: '/srv/cos/fixtures/work/user-data',
      keyring: 'keyring://fixture-work',
      models: ['gpt-5.1'],
      order: 0
    },
    {
      handle: 'home',
      instance: { apiPort: 18811, vncPort: 18812 },
      browserProfile: '/srv/cos/fixtures/home/browser-profile',
      userData: '/srv/cos/fixtures/home/user-data',
      keyring: 'keyring://fixture-home',
      models: ['gpt-5.1'],
      order: 1
    },
    {
      handle: 'lab',
      instance: { apiPort: 18821, vncPort: 18822 },
      browserProfile: '/srv/cos/fixtures/lab/browser-profile',
      userData: '/srv/cos/fixtures/lab/user-data',
      keyring: 'keyring://fixture-lab',
      models: ['gpt-5.1-mini'],
      order: 2
    }
  ];
}

const state = (handle: string, ready: boolean, status: HandleReadiness['status']): HandleReadiness => ({
  handle,
  status,
  ready,
  reason: ready ? 'live browser evidence' : 'unobserved live evidence: browserRunning',
  evidence: { signedIn: ready ? true : null, browserRunning: ready ? true : null, extensionFresh: ready ? true : null }
});

test('a throttle is honored, never answered by hopping accounts', () => {
  const withDeadline = classifyFailure({ status: 429, code: 'busy', retryAfterSeconds: 12 });
  assert.equal(withDeadline.class, 'throttled');
  assert.equal(withDeadline.mayFailover, false);
  assert.equal(withDeadline.retryAfterSeconds, 12);

  const withoutDeadline = classifyFailure({ status: 429, code: 'chat_error' });
  assert.equal(withoutDeadline.class, 'throttled');
  assert.equal(withoutDeadline.mayFailover, false);
  assert.equal(withoutDeadline.retryAfterSeconds, undefined, 'a deadline is never invented');
});

test('only an availability failure may fail over', () => {
  for (const code of UNAVAILABLE_CODES) {
    const decision = classifyFailure({ status: 503, code });
    assert.equal(decision.class, 'handle_unavailable', code);
    assert.equal(decision.mayFailover, true, code);
  }
  const notReady = classifyFailure({ status: 503, code: 'handle_not_ready' });
  assert.match(notReady.reason, /handle_not_ready/);
});

test('a turn timeout is terminal: the turn keeps running in that account', () => {
  const decision = classifyFailure({ status: 504, code: 'turn_timeout' });
  assert.equal(decision.class, 'terminal');
  assert.equal(decision.mayFailover, false);
  assert.match(decision.reason, /re-attach/);
});

test('client errors and stateful chat failures are terminal', () => {
  for (const failure of [
    { status: 400, code: 'model_unknown' },
    { status: 400, code: 'handle_mismatch' },
    { status: 401, code: 'unauthorized' },
    { status: 409, code: 'id_conflict' },
    { status: 409, code: 'cross_handle_session' },
    { status: 502, code: 'chat_blocked' },
    { status: 502, code: 'turn_ended_without_answer' },
    { status: 502, code: 'internal' }
  ]) {
    const decision = classifyFailure(failure);
    assert.equal(decision.class, 'terminal', `${failure.code} must not fail over`);
    assert.equal(decision.mayFailover, false, failure.code);
  }
});

test('every ledger code classifies into its documented pool class', () => {
  for (const [code, spec] of Object.entries(GATEWAY_ERRORS)) {
    const statuses = Array.isArray(spec.status) ? spec.status : [spec.status];
    for (const status of statuses) {
      const decision = classifyFailure({ status, code });
      const expected = status === 429 ? 'throttled' : status === 503 ? 'handle_unavailable' : 'terminal';
      assert.equal(decision.class, expected, `${code} (${status})`);
      assert.equal(decision.mayFailover, expected === 'handle_unavailable', `${code} (${status})`);
    }
  }
});

test('the pool keeps operator order and only ready handles may serve', () => {
  const registry = HandleRegistry.parse(fixture());
  const pool = poolCandidates(registry.list(), 'gpt-5.1', new Map<string, HandleReadiness>([
    ['work', state('work', false, 'not_ready')],
    ['home', state('home', true, 'ready')],
    ['lab', state('lab', true, 'ready')]
  ]));
  // lab does not declare gpt-5.1, so it is not a candidate for that model.
  assert.deepEqual(pool.map((candidate) => candidate.handle), ['work', 'home']);
  assert.deepEqual(readyPool(pool).map((candidate) => candidate.handle), ['home']);

  // A handle this instance cannot observe is unknown, hence not ready.
  const unobserved = poolCandidates(registry.list(), 'gpt-5.1', new Map());
  assert.deepEqual(unobserved.map((candidate) => candidate.status), ['unknown', 'unknown']);
  assert.deepEqual(readyPool(unobserved), []);

  // No model means every handle is a candidate (the picker chooses).
  assert.deepEqual(poolCandidates(registry.list(), null, new Map()).map((candidate) => candidate.handle),
    ['work', 'home', 'lab']);
});

test('a disabled handle is never a pool candidate', () => {
  const handles = fixture();
  handles[1] = { ...handles[1]!, enabled: false };
  const registry = HandleRegistry.parse(handles);
  const pool = poolCandidates(registry.list(), 'gpt-5.1', new Map([['home', state('home', true, 'ready')]]));
  assert.deepEqual(pool.map((candidate) => candidate.handle), ['work']);
});

test('an unavailable handle hands the request to the next ready one, never to an attempted one', () => {
  const pool: PoolCandidate[] = [
    { handle: 'work', status: 'not_ready', ready: true, order: 0 },
    { handle: 'home', status: 'ready', ready: true, order: 1 },
    { handle: 'lab', status: 'unknown', ready: false, order: 2 }
  ];
  const failure = { status: 503, code: 'queue_full' };
  const first = planFailover(pool, ['work'], failure);
  assert.equal(first.action, 'retry_next');
  assert.equal(first.handle, 'home');

  // home failed too: lab is not ready, so the pool stops rather than guessing.
  const second = planFailover(pool, ['work', 'home'], failure);
  assert.equal(second.action, 'stop');
  assert.match(second.reason, /no ready handle/);

  // The same handle is never offered twice.
  const only = planFailover([pool[1]!], ['home'], failure);
  assert.equal(only.action, 'stop');
});

test('a throttled pool tells the client to wait, and a terminal failure stops it', () => {
  const pool: PoolCandidate[] = [
    { handle: 'work', status: 'ready', ready: true, order: 0 },
    { handle: 'home', status: 'ready', ready: true, order: 1 }
  ];
  const throttled = planFailover(pool, ['work'], { status: 429, code: 'session_busy', retryAfterSeconds: 30 });
  assert.equal(throttled.action, 'wait');
  assert.equal(throttled.retryAfterSeconds, 30);

  const timeout = planFailover(pool, ['work'], { status: 504, code: 'turn_timeout' });
  assert.equal(timeout.action, 'stop');
  assert.match(timeout.reason, /re-attach/);

  const bad = planFailover(pool, ['work'], { status: 400, code: 'invalid_body' });
  assert.equal(bad.action, 'stop');
});
