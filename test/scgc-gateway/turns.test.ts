import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  SessionBusy,
  TurnError,
  TurnManager,
  TurnTimeout,
  turnInputId,
  type SessionInfo,
  type TurnPlan
} from '../../src/main/openai-gateway/turns.js';
import { GatewayError } from '../../src/main/openai-gateway/errors.js';
import { normalizeMessages } from '../../src/main/openai-gateway/fold.js';
import { FakeCos, deliverTurn } from './fake-cos.js';

const stateDir = (): string => mkdtempSync(path.join(tmpdir(), 'scgc-test-'));

const managerFor = (fake: FakeCos, extra: Record<string, unknown> = {}): TurnManager =>
  new TurnManager(fake, stateDir(), { pollMs: 1, queueWaitMs: 50, turnTimeoutMs: 2000, refTimers: true, ...extra });

const firstTurn = normalizeMessages([
  { role: 'system', content: 'ctx' },
  { role: 'user', content: 'Hi' }
]);

const planFor = (manager: TurnManager, key: string, text: string): TurnPlan =>
  manager.planTurn(key, normalizeMessages([{ role: 'user', content: text }]), null, null, true);

const sendPlain = async (
  manager: TurnManager,
  key: string,
  info: SessionInfo,
  text: string,
): Promise<{ replayed: boolean; inputId: string; sessionId: string }> =>
  manager.sendTurn(info, planFor(manager, key, text), { model: null, reasoningEffort: null });

test('turnInputId is a deterministic UUIDv5 over key + seq + text + model + effort', () => {
  const a = turnInputId('key', 0, 'text', 'gpt-5.1', 'high');
  const b = turnInputId('key', 0, 'text', 'gpt-5.1', 'high');
  const nextSeq = turnInputId('key', 1, 'text', 'gpt-5.1', 'high');
  const otherEffort = turnInputId('key', 0, 'text', 'gpt-5.1', 'low');
  assert.equal(a, b);
  assert.notEqual(a, nextSeq, 'the same text on a later sequence derives a fresh id');
  assert.notEqual(a, otherEffort);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('planTurn folds the first turn and later deltas, and detects a retry', async () => {
  const fake = new FakeCos();
  const manager = managerFor(fake);
  const key = 'k1';

  // No session yet: the first turn carries the context prefix.
  const first = manager.planTurn(key, firstTurn, null, null, true);
  assert.equal(first.replaying, false);
  assert.ok(first.text.startsWith('[Context for this conversation]'));
  assert.equal(first.seq, 0);
  assert.equal(first.inputId, turnInputId(key, 0, first.text, null, null));

  const { info, release } = await manager.acquire(key);
  try {
    info.sessionId = 'sess-1';
    info.turnSeq = 5;
    info.turnInput = turnInputId(key, 5, 'delta', null, null);

    // A retry of the in-flight turn re-plans to the SAME id and sequence.
    const retry = manager.planTurn(key, normalizeMessages([
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'delta' }
    ]), null, null, false);
    assert.equal(retry.replaying, true);
    assert.equal(retry.text, 'delta');
    assert.equal(retry.seq, 5);
    assert.equal(retry.inputId, info.turnInput);

    // A different message while in flight takes the next sequence.
    const other = manager.planTurn(key, normalizeMessages([
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'again' }
    ]), null, null, false);
    assert.equal(other.replaying, false);
    assert.equal(other.seq, 6);
    assert.notEqual(other.inputId, info.turnInput);

    // A session exists but no turn in flight: later turns are plain deltas.
    info.turnInput = null;
    const later = manager.planTurn(key, normalizeMessages([
      { role: 'user', content: 'delta' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'again' }
    ]), null, null, false);
    assert.equal(later.replaying, false);
    assert.equal(later.text, 'again');
  } finally {
    release();
  }
});

test('two identical consecutive turns get different input ids', async () => {
  const fake = new FakeCos();
  const manager = managerFor(fake);
  const { info, release } = await manager.acquire('k1');
  try {
    const first = await sendPlain(manager, 'k1', info, 'Hello');
    deliverTurn(fake, first.inputId, 'hi');
    await manager.followTurn(info, first.inputId);
    manager.finishTurn(info);

    // The user sends the exact same message again: a new turn, not the old row.
    const second = await sendPlain(manager, 'k1', info, 'Hello');
    assert.equal(second.replayed, false);
    assert.notEqual(second.inputId, first.inputId, 'a repeat message must not ride the stale row');
    deliverTurn(fake, second.inputId, 'hi again');
    assert.equal(await manager.followTurn(info, second.inputId), 'hi again');
    manager.finishTurn(info);
    assert.equal(fake.sent.length, 2);
  } finally {
    release();
  }
});

test('sendTurn files a new chat under its own input id and records the slot', async () => {
  const fake = new FakeCos();
  const manager = managerFor(fake);
  const { info, release } = await manager.acquire('k1');
  try {
    const sent = await sendPlain(manager, 'k1', info, 'Hello');
    assert.equal(sent.replayed, false);
    assert.equal(sent.sessionId, sent.inputId, "a new chat's session id is the message id");
    const row = fake.inputs.get(sent.inputId);
    assert.ok(row);
    assert.equal(row!.sessionId, sent.inputId);
    assert.equal(info.sessionId, sent.inputId);
    assert.equal(info.turnInput, sent.inputId);
    assert.equal(info.turnSeq, 0, 'the in-flight turn owns sequence zero');
    assert.equal(fake.sent.length, 1);
    assert.equal(fake.sent[0]!.mode, 'auto');
    assert.equal(fake.sent[0]!.authoredSource, 'text');
  } finally {
    release();
  }
});

test('sendTurn replays a known row instead of double-sending', async () => {
  const fake = new FakeCos();
  const manager = managerFor(fake);
  const { info, release } = await manager.acquire('k1');
  try {
    const first = await sendPlain(manager, 'k1', info, 'Hello');
    // planTurn recognizes the in-flight turn as a retry of the same id...
    const retryPlan = manager.planTurn('k1', normalizeMessages([{ role: 'user', content: 'Hello' }]), null, null, true);
    assert.equal(retryPlan.replaying, true);
    assert.equal(retryPlan.inputId, first.inputId);
    // ...and even a direct send of the same plan rides the existing row.
    const replay = await manager.sendTurn(info, retryPlan, { model: null, reasoningEffort: null });
    assert.equal(replay.replayed, true);
    assert.equal(replay.inputId, first.inputId);
    assert.equal(fake.sent.length, 1, 'the outbox row already exists, so no second send');
  } finally {
    release();
  }
});

test('sendTurn rejects an id that already belongs to different content', async () => {
  const fake = new FakeCos();
  const manager = managerFor(fake);
  const { info, release } = await manager.acquire('k1');
  try {
    const first = await sendPlain(manager, 'k1', info, 'Hello');
    // The same derived id now names a row with different content (a mutated
    // outbox): the gateway must not ride that row.
    const row = fake.inputs.get(first.inputId);
    assert.ok(row);
    row!.text = 'Something else entirely';
    await assert.rejects(
      sendPlain(manager, 'k1', info, 'Hello'),
      (error: unknown) => error instanceof GatewayError && error.status === 409,
    );
  } finally {
    release();
  }
});

test('sendTurn refuses to interrupt an in-flight answer', async () => {
  const fake = new FakeCos();
  const manager = managerFor(fake);
  fake.setPolicy('sess-1', { directTurn: { id: 'turn-1', startedAt: 1 } });
  const { info, release } = await manager.acquire('k1');
  info.sessionId = 'sess-1';
  try {
    await assert.rejects(
      sendPlain(manager, 'k1', info, 'delta'),
      (error: unknown) => error instanceof GatewayError
        && error.status === 429 && error.code === 'would_interrupt',
    );
  } finally {
    release();
  }
});

test('followTurn returns the final answer after the input-id anchor', async () => {
  const fake = new FakeCos();
  const manager = managerFor(fake);
  const { info, release } = await manager.acquire('k1');
  try {
    const sent = await sendPlain(manager, 'k1', info, 'Hello');
    deliverTurn(fake, sent.inputId, 'Answer text');
    const answer = await manager.followTurn(info, sent.inputId);
    assert.equal(answer, 'Answer text');
  } finally {
    release();
  }
});

test('followTurn raises a 429 for a chat_error with retryAt', async () => {
  const fake = new FakeCos();
  const manager = managerFor(fake);
  const { info, release } = await manager.acquire('k1');
  try {
    const sent = await sendPlain(manager, 'k1', info, 'Hello');
    const sessionId = sent.sessionId;
    fake.appendEvent(sessionId, { kind: 'user_message', message: { text: 'x' }, inputId: sent.inputId });
    fake.appendEvent(sessionId, {
      kind: 'chat_error', message: { text: 'limit' }, retryAt: Date.now() + 8000
    });
    fake.notify(sessionId);
    await assert.rejects(manager.followTurn(info, sent.inputId), (error: unknown) => {
      if (!(error instanceof TurnError)) return false;
      const mapped = error.toError();
      return mapped.status === 429 && mapped.code === 'chat_error' && mapped.retryAfterSeconds === 8;
    });
  } finally {
    release();
  }
});

test('findAnchor returns null when the row never delivered', async () => {
  const fake = new FakeCos();
  const manager = managerFor(fake);
  const { info, release } = await manager.acquire('k1');
  try {
    const sent = await sendPlain(manager, 'k1', info, 'Hello');
    const row = fake.inputs.get(sent.inputId);
    assert.ok(row);
    row!.state = 'failed';
    row!.error = 'Browser startup failed';
    const anchor = await manager.findAnchor(sent.sessionId, sent.inputId, Date.now() + 5000);
    assert.equal(anchor, null);
  } finally {
    release();
  }
});

test('a timed-out turn is re-attached by input id on retry, not re-sent', async () => {
  const fake = new FakeCos();
  const manager = managerFor(fake, { turnTimeoutMs: 30 });
  const { info, release } = await manager.acquire('k1');
  try {
    const plan = planFor(manager, 'k1', 'Hello');
    const sent = await manager.sendTurn(info, plan, { model: null, reasoningEffort: null });
    // The turn never answers before the deadline.
    await assert.rejects(manager.followTurn(info, sent.inputId), (error: unknown) =>
      error instanceof TurnTimeout);
    // The marker and its sequence survive the timeout.
    assert.equal(info.turnInput, sent.inputId);
    assert.equal(info.turnSeq, plan.seq);

    // The retry re-plans to the SAME input id without settling.
    const retry = planFor(manager, 'k1', 'Hello');
    assert.equal(retry.replaying, true);
    assert.equal(retry.inputId, sent.inputId);
    assert.equal(retry.seq, plan.seq);

    deliverTurn(fake, sent.inputId, 'late answer');
    const answer = await manager.followTurn(info, retry.inputId);
    assert.equal(answer, 'late answer');
    manager.finishTurn(info);
    assert.equal(info.turnInput, null, 'the marker clears only after the outcome is known');
    assert.equal(info.turnSeq, retry.seq + 1);
    assert.equal(fake.sent.length, 1, 'the retry never re-sent the message');
  } finally {
    release();
  }
});

test('a restart-left in-flight turn is re-attached on a matching retry', async () => {
  const fake = new FakeCos();
  const dir = stateDir();
  const first = new TurnManager(fake, dir, { pollMs: 1, turnTimeoutMs: 2000, refTimers: true });
  const acquired = await first.acquire('k1');
  const sent = await sendPlain(first, 'k1', acquired.info, 'Hello');
  // Simulate a restart while the turn is in flight: drop the in-process handle.
  acquired.release();
  first.dispose();

  // After the restart the persisted marker must re-plan to the SAME input id.
  const second = new TurnManager(fake, dir, { pollMs: 1, turnTimeoutMs: 2000, refTimers: true });
  const retryPlan = planFor(second, 'k1', 'Hello');
  assert.equal(retryPlan.replaying, true);
  assert.equal(retryPlan.inputId, sent.inputId);

  deliverTurn(fake, sent.inputId, 'done');
  const reacquired = await second.acquire('k1');
  assert.equal(reacquired.info.sessionId, sent.sessionId, 'the mapping survives the restart');
  const answer = await second.followTurn(reacquired.info, retryPlan.inputId);
  assert.equal(answer, 'done');
  second.finishTurn(reacquired.info);
  assert.equal(reacquired.info.turnInput, null);
  assert.equal(fake.sent.length, 1, 'the retry never re-sent');
  reacquired.release();
  second.dispose();
});

test('a restart-left turn is settled before a different turn sends', async () => {
  const fake = new FakeCos();
  const dir = stateDir();
  const first = new TurnManager(fake, dir, { pollMs: 1, turnTimeoutMs: 2000, refTimers: true });
  const acquired = await first.acquire('k1');
  const sent = await sendPlain(first, 'k1', acquired.info, 'Hello');
  acquired.release();
  first.dispose();

  const second = new TurnManager(fake, dir, { pollMs: 1, turnTimeoutMs: 2000, refTimers: true });
  const { info, release } = await second.acquire('k1');
  try {
    const other = second.planTurn(
      'k1', normalizeMessages([{ role: 'user', content: 'Something new' }]), null, null, true,
    );
    assert.equal(other.replaying, false);
    assert.equal(other.seq, 1, 'a different turn takes the next sequence');
    deliverTurn(fake, sent.inputId, 'done');
    await second.settleLeftover(info);
    assert.equal(info.turnInput, null, 'the leftover turn is settled and cleared');
    const sent2 = await second.sendTurn(info, other, { model: null, reasoningEffort: null });
    assert.notEqual(sent2.inputId, sent.inputId);
    deliverTurn(fake, sent2.inputId, 'two');
    assert.equal(await second.followTurn(info, sent2.inputId), 'two');
    second.finishTurn(info);
  } finally {
    release();
  }
  second.dispose();
});

test('settleLeftover is a SessionBusy when a restart-left turn never settles', async () => {
  const fake = new FakeCos();
  const dir = stateDir();
  const first = new TurnManager(fake, dir, { pollMs: 100, turnTimeoutMs: 15, refTimers: true });
  const acquired = await first.acquire('k1');
  const sent = await sendPlain(first, 'k1', acquired.info, 'Hello');
  acquired.release();
  first.dispose();

  const second = new TurnManager(fake, dir, { pollMs: 100, turnTimeoutMs: 15, refTimers: true });
  const { info, release } = await second.acquire('k1');
  try {
    await assert.rejects(second.settleLeftover(info), (error: unknown) =>
      error instanceof SessionBusy && error.retryAfterSeconds > 0);
    assert.equal(info.turnInput, sent.inputId, 'an unsettled marker is never cleared');
  } finally {
    release();
  }
  second.dispose();
});

test('persisting one conversation keeps the other conversations', async () => {
  const fake = new FakeCos();
  const dir = stateDir();
  const manager = new TurnManager(fake, dir, { pollMs: 1, queueWaitMs: 50, turnTimeoutMs: 2000, refTimers: true });
  const a = await manager.acquire('conv-a');
  const b = await manager.acquire('conv-b');
  const sentA = await sendPlain(manager, 'conv-a', a.info, 'first-a');
  const sentB = await sendPlain(manager, 'conv-b', b.info, 'first-b');
  const persisted = JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8')) as Record<string, {
    session_id: string | null;
    turn_input: string | null;
  }>;
  assert.equal(persisted['conv-a']?.session_id, a.info.sessionId, 'an earlier conversation is not dropped');
  assert.equal(persisted['conv-a']?.turn_input, sentA.inputId);
  assert.equal(persisted['conv-b']?.session_id, b.info.sessionId);
  assert.equal(persisted['conv-b']?.turn_input, sentB.inputId);
  a.release();
  b.release();
  manager.dispose();
});

test('waitTurn times out as a TurnTimeout', async () => {
  const fake = new FakeCos();
  const manager = managerFor(fake, { turnTimeoutMs: 15, pollMs: 5 });
  const { info, release } = await manager.acquire('k1');
  try {
    const sent = await sendPlain(manager, 'k1', info, 'Hello');
    fake.appendEvent(sent.sessionId, { kind: 'user_message', message: { text: 'x' }, inputId: sent.inputId });
    fake.notify(sent.sessionId);
    await assert.rejects(manager.waitTurn(sent.sessionId, 1, Date.now() + 15, true),
      (error: unknown) => error instanceof TurnTimeout);
  } finally {
    release();
  }
});

test('finishTurn clears the in-flight slot and persists the mapping', async () => {
  const fake = new FakeCos();
  const dir = stateDir();
  const manager = new TurnManager(fake, dir, { pollMs: 1, queueWaitMs: 50, turnTimeoutMs: 2000, refTimers: true });
  const { info, release } = await manager.acquire('k1');
  const sent = await sendPlain(manager, 'k1', info, 'Hello');
  assert.equal(info.turnInput, sent.inputId);
  manager.finishTurn(info);
  assert.equal(info.turnInput, null);
  const persisted = JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8')) as Record<string, {
    session_id: string | null;
    turn_input: string | null;
    sent_users: number;
    turn_seq: number;
  }>;
  assert.equal(persisted['k1']?.session_id, sent.sessionId);
  assert.equal(persisted['k1']?.turn_input, null);
  assert.equal(persisted['k1']?.sent_users, 1);
  assert.equal(persisted['k1']?.turn_seq, 1, 'the consumed sequence is persisted');
  release();
});

// --------------------------------------------------------------------------
// Late-anchor re-attach (live gap found in the 2026-11-01 E2E): CoS records
// the delivered user_message at its residence seq, which can sit AFTER the
// turn_end. The follow must key by turnId, not by seq order after the anchor.
// --------------------------------------------------------------------------

/**
 * Deliver a full turn whose anchor lands LAST at its residence seq, the way
 * CoS recorded it for a turn queued hours before delivery: the final answer
 * and the turn_end are already in the journal before the user_message.
 */
function deliverLateAnchorTurn(
  fake: FakeCos,
  inputId: string,
  answer: string,
  turnId: string,
): void {
  const row = fake.inputs.get(inputId);
  if (row === undefined) throw new Error('deliverLateAnchorTurn: unknown input id');
  const sessionId = row.sessionId!;
  fake.appendEvent(sessionId, { kind: 'assistant_message', final: true, message: { text: answer }, turnId });
  fake.appendEvent(sessionId, { kind: 'turn_end', outcome: 'completed', turnId });
  fake.appendEvent(sessionId, { kind: 'user_message', message: { text: '...' }, inputId, turnId });
  fake.notify(sessionId);
}

test('a retry re-attaches to an already-completed turn whose anchor landed after the turn end', async () => {
  const fake = new FakeCos();
  const manager = managerFor(fake);
  const { info, release } = await manager.acquire('k1');
  try {
    const sent = await sendPlain(manager, 'k1', info, 'slow question');
    deliverLateAnchorTurn(fake, sent.inputId, 'the recorded answer', 'turn-1');

    // The retry re-plans the same logical turn and must get the recorded
    // answer back instead of waiting out the deadline.
    const retry = manager.planTurn('k1', normalizeMessages([
      { role: 'assistant', content: 'earlier' },
      { role: 'user', content: 'slow question' }
    ]), null, null, false);
    assert.equal(retry.replaying, true);
    assert.equal(retry.inputId, sent.inputId);
    assert.equal(await manager.followTurn(info, sent.inputId), 'the recorded answer');
  } finally {
    release();
  }
});

test('a different turn settles immediately once the leftover turn has completed before its anchor', async () => {
  const fake = new FakeCos();
  const manager = managerFor(fake);
  const { info, release } = await manager.acquire('k1');
  try {
    const sent = await sendPlain(manager, 'k1', info, 'slow question');
    deliverLateAnchorTurn(fake, sent.inputId, 'the recorded answer', 'turn-1');
    info.turnStartedAt = 0;

    // A DIFFERENT message may send without waiting out the turn timeout.
    const later = await sendPlain(manager, 'k1', info, 'the next question');
    assert.equal(later.replayed, false);
    assert.notEqual(later.inputId, sent.inputId);
  } finally {
    release();
  }
});

test('a completed turn with an untagged anchor keeps the legacy positional follow', async () => {
  const fake = new FakeCos();
  const manager = managerFor(fake, { turnTimeoutMs: 50 });
  const { info, release } = await manager.acquire('k1');
  try {
    const sent = await sendPlain(manager, 'k1', info, 'slow question');
    // No turnId anywhere: nothing to key by, the positional wait stands.
    fake.appendEvent(sent.sessionId, { kind: 'assistant_message', final: true, message: { text: 'a' } });
    fake.appendEvent(sent.sessionId, { kind: 'turn_end', outcome: 'completed' });
    fake.appendEvent(sent.sessionId, { kind: 'user_message', message: { text: '...' }, inputId: sent.inputId });
    fake.notify(sent.sessionId);
    await assert.rejects(
      manager.followTurn(info, sent.inputId),
      TurnTimeout,
      'the untagged journal cannot be keyed by turn id; the deadline stands'
    );
  } finally {
    release();
  }
});

test('a chat_error recorded for the same turn id is surfaced by the keyed follow', async () => {
  const fake = new FakeCos();
  const manager = managerFor(fake);
  const { info, release } = await manager.acquire('k1');
  try {
    const sent = await sendPlain(manager, 'k1', info, 'slow question');
    const retryAt = Date.now() + 120_000;
    fake.appendEvent(sent.sessionId, { kind: 'chat_error', message: { text: 'limited' }, turnId: 'turn-1', retryAt, recoverable: true });
    fake.appendEvent(sent.sessionId, { kind: 'turn_end', outcome: 'failed', turnId: 'turn-1' });
    fake.appendEvent(sent.sessionId, { kind: 'user_message', message: { text: '...' }, inputId: sent.inputId, turnId: 'turn-1' });
    fake.notify(sent.sessionId);
    await assert.rejects(
      manager.followTurn(info, sent.inputId),
      (error: unknown) => error instanceof TurnError && error.retryAt === retryAt
    );
  } finally {
    release();
  }
});
