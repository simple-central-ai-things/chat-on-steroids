/**
 * The typed gateway state store on its own: schema, per-conversation upserts,
 * the stable turn id, the outbox row, and reopen persistence.
 *
 * These tests speak to the DAO directly (no TurnManager), so a failure names
 * the storage layer instead of a turn-orchestration path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SHADOW_STATE_FILE } from '../../src/main/openai-gateway/state/legacy-json.js';
import { DB_FILE, GatewayStateStore } from '../../src/main/openai-gateway/state/store.js';
import { SCHEMA_VERSION } from '../../src/main/openai-gateway/state/schema.js';

const stateDir = (): string => mkdtempSync(path.join(tmpdir(), 'cos-gateway-store-'));
const clock = (start = 1_700_000_000_000): (() => number) => {
  let at = start;
  return () => (at += 1);
};

const open = (dir: string): GatewayStateStore => GatewayStateStore.open({ dir, now: clock() });

test('a fresh store applies schema version 1 in WAL mode with STRICT tables', () => {
  const dir = stateDir();
  const store = open(dir);
  try {
    // A second connection sees the committed pragma and schema; the DAO does
    // not expose its handle, which is the point (one door to the storage).
    const db = new DatabaseSync(path.join(dir, DB_FILE));
    try {
      const version = db.prepare('PRAGMA user_version').get() as { user_version?: number };
      assert.equal(version.user_version, SCHEMA_VERSION);
      const mode = db.prepare('PRAGMA journal_mode').get() as { journal_mode?: string };
      assert.equal(mode.journal_mode, 'wal');
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as { name: string }[];
      assert.deepEqual(
        tables.map((row) => row.name),
        ['conversations', 'in_flight', 'meta', 'outbox', 'sessions', 'turns'],
      );
      // STRICT is what makes a wrong write loud instead of silently coerced.
      const sql = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'turns'")
        .get() as { sql?: string };
      assert.match(sql.sql ?? '', /\) STRICT$/);
    } finally {
      db.close();
    }
  } finally {
    store.close();
  }
});

test('saving one conversation never drops another', () => {
  const dir = stateDir();
  const store = open(dir);
  try {
    store.saveConversation('conv-a', {
      sessionId: 'session-a', sentUsers: 1, turnInput: 'turn-a', turnStartedAt: 10, turnSeq: 0
    });
    store.saveConversation('conv-b', {
      sessionId: 'session-b', sentUsers: 2, turnInput: null, turnStartedAt: null, turnSeq: 3
    });
    // A later write of conv-a must leave conv-b's row untouched.
    store.saveConversation('conv-a', {
      sessionId: 'session-a', sentUsers: 2, turnInput: null, turnStartedAt: null, turnSeq: 1
    });
    const loaded = store.loadConversations();
    assert.deepEqual(loaded.get('conv-a'), {
      sessionId: 'session-a', sentUsers: 2, turnInput: null, turnStartedAt: null, turnSeq: 1
    });
    assert.deepEqual(loaded.get('conv-b'), {
      sessionId: 'session-b', sentUsers: 2, turnInput: null, turnStartedAt: null, turnSeq: 3
    });
    assert.equal(store.inFlight('conv-b'), null);
  } finally {
    store.close();
  }
});

test('the in-flight slot is one row: present while owed, gone once settled', () => {
  const dir = stateDir();
  const store = open(dir);
  try {
    store.saveConversation('k', {
      sessionId: 's', sentUsers: 1, turnInput: 'turn-1', turnStartedAt: 42, turnSeq: 0
    });
    assert.deepEqual(store.inFlight('k'), { turnId: 'turn-1', startedAt: 42 });
    store.saveConversation('k', {
      sessionId: 's', sentUsers: 1, turnInput: null, turnStartedAt: null, turnSeq: 1
    });
    assert.equal(store.inFlight('k'), null);
    store.saveConversation('k', {
      sessionId: 's', sentUsers: 2, turnInput: 'turn-2', turnStartedAt: 43, turnSeq: 1
    });
    assert.deepEqual(store.inFlight('k'), { turnId: 'turn-2', startedAt: 43 });
  } finally {
    store.close();
  }
});

test('a turn row is keyed by the stable turn id and keeps the native id separately', () => {
  const dir = stateDir();
  const store = open(dir);
  try {
    store.beginTurn({
      turnId: 'turn-uuid-1', conversationKey: 'k', seq: 0, sessionId: 'session-1', startedAt: 100
    });
    let turn = store.turn('turn-uuid-1');
    assert.equal(turn?.state, 'in_flight');
    assert.equal(turn?.attempts, 1);
    assert.equal(turn?.nativeTurnId, null);
    assert.equal(turn?.finishedAt, null);

    // A retry of the same logical turn is the same row, not a second one.
    store.noteTurnAttempt('turn-uuid-1');
    turn = store.turn('turn-uuid-1');
    assert.equal(turn?.attempts, 2);
    assert.equal(store.turnsFor('k').length, 1);

    // CoS's own id is evidence beside the key, never the key itself.
    store.recordNativeTurnId('turn-uuid-1', 'chatgpt-turn-9');
    assert.equal(store.turn('turn-uuid-1')?.nativeTurnId, 'chatgpt-turn-9');
    assert.equal(store.turn('chatgpt-turn-9'), null, 'the native id does not become a row key');

    store.recordTurnOutcome('turn-uuid-1', 'answered');
    turn = store.turn('turn-uuid-1');
    assert.equal(turn?.state, 'answered');
    assert.notEqual(turn?.finishedAt, null);
  } finally {
    store.close();
  }
});

test('the outbox row mirrors admission, retry and outcome', () => {
  const dir = stateDir();
  const store = open(dir);
  try {
    store.beginTurn({
      turnId: 'turn-1', conversationKey: 'k', seq: 0, sessionId: null, startedAt: 100
    });
    let row = store.outboxRow('turn-1');
    assert.equal(row?.state, 'sent');
    assert.equal(row?.turnId, 'turn-1');
    assert.equal(row?.conversationKey, 'k');
    assert.equal(row?.nextAttemptAt, null);

    store.noteTurnAttempt('turn-1');
    row = store.outboxRow('turn-1');
    assert.equal(row?.state, 'sending');
    assert.equal(row?.attempts, 2);

    store.recordTurnOutcome('turn-1', 'timeout');
    row = store.outboxRow('turn-1');
    assert.equal(row?.state, 'timeout', 'a timeout keeps its own outbox state');

    store.beginTurn({
      turnId: 'turn-2', conversationKey: 'k', seq: 1, sessionId: 's', startedAt: 200
    });
    store.recordTurnOutcome('turn-2', 'failed', { error: 'the turn failed' });
    row = store.outboxRow('turn-2');
    assert.equal(row?.state, 'failed');
    assert.equal(row?.lastError, 'the turn failed');
    assert.equal(store.outboxRows().length, 2);
  } finally {
    store.close();
  }
});

test('a session maps back to its conversation key', () => {
  const dir = stateDir();
  const store = open(dir);
  try {
    store.saveConversation('conv-x', {
      sessionId: 'session-x', sentUsers: 1, turnInput: null, turnStartedAt: null, turnSeq: 0
    });
    assert.equal(store.conversationForSession('session-x'), 'conv-x');
    assert.equal(store.conversationForSession('session-unknown'), null);
  } finally {
    store.close();
  }
});

test('everything committed survives a close and reopen', () => {
  const dir = stateDir();
  const first = open(dir);
  first.beginTurn({
    turnId: 'turn-persisted', conversationKey: 'k', seq: 0, sessionId: 'session-p', startedAt: 500
  });
  first.saveAll(new Map([
    ['k', { sessionId: 'session-p', sentUsers: 1, turnInput: 'turn-persisted', turnStartedAt: 500, turnSeq: 0 }],
    ['other', { sessionId: 'session-o', sentUsers: 0, turnInput: null, turnStartedAt: null, turnSeq: 7 }]
  ]));
  first.close();

  const second = open(dir);
  try {
    const loaded = second.loadConversations();
    assert.deepEqual(loaded.get('k'), {
      sessionId: 'session-p', sentUsers: 1, turnInput: 'turn-persisted', turnStartedAt: 500, turnSeq: 0
    });
    assert.equal(loaded.get('other')?.turnSeq, 7);
    assert.equal(second.turn('turn-persisted')?.state, 'in_flight');
    assert.equal(second.conversationForSession('session-o'), 'other');
  } finally {
    second.close();
  }
});

test('every commit rewrites the recoverable shadow export in the legacy shape', () => {
  const dir = stateDir();
  const store = open(dir);
  try {
    store.saveConversation('k', {
      sessionId: 's', sentUsers: 3, turnInput: 'turn-1', turnStartedAt: 11, turnSeq: 2
    });
    const shadow = JSON.parse(readFileSync(path.join(dir, SHADOW_STATE_FILE), 'utf8')) as
      Record<string, Record<string, unknown>>;
    assert.deepEqual(shadow['k'], {
      session_id: 's',
      sent_users: 3,
      turn_input: 'turn-1',
      turn_started: 11,
      turn_seq: 2
    });
    assert.deepEqual(store.readShadow(), store.shadowProjection());
    assert.equal(existsSync(path.join(dir, 'state.json')), false, 'JSON is no longer the writer');
  } finally {
    store.close();
  }
});

test('a closed store refuses further writes', () => {
  const dir = stateDir();
  const store = open(dir);
  store.close();
  assert.throws(
    () => store.saveConversation('k', {
      sessionId: 's', sentUsers: 0, turnInput: null, turnStartedAt: null, turnSeq: 0
    }),
    /closed/,
  );
});
