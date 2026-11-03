/**
 * Migration, shadow export, backup/restore and rollback for the gateway state
 * store.
 *
 * The legacy `state.json` is a one-shot import source only. These tests prove
 * that import is lossless and idempotent, that an interrupted import retries,
 * that a damaged source does not stop startup, and that the directory can be
 * moved between the SQLite build and the old JSON build without losing a turn.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { encodeLegacyState, SHADOW_STATE_FILE } from '../../src/main/openai-gateway/state/legacy-json.js';
import { DB_FILE, GatewayStateStore } from '../../src/main/openai-gateway/state/store.js';
import {
  META_JSON_IMPORT,
  META_SHADOW_RECOVERY,
  SCHEMA_SQL,
  SCHEMA_VERSION,
  type LegacyStateMap
} from '../../src/main/openai-gateway/state/schema.js';

const stateDir = (): string => mkdtempSync(path.join(tmpdir(), 'cos-gateway-migrate-'));
const clock = (start = 1_700_000_000_000): (() => number) => {
  let at = start;
  return () => (at += 1);
};
const open = (dir: string): GatewayStateStore => GatewayStateStore.open({ dir, now: clock() });

/** A legacy map with two conversations, one of them mid-flight. */
const legacyMap = (): LegacyStateMap => ({
  'conv-a': {
    session_id: 'cos-session-a', sent_users: 2, turn_input: 'turn-in-flight',
    turn_started: 1_700_000_000_100, turn_seq: 1
  },
  'conv-b': {
    session_id: 'cos-session-b', sent_users: 1, turn_input: null,
    turn_started: null, turn_seq: 4
  }
});

const writeLegacy = (dir: string, map: LegacyStateMap): string => {
  const file = path.join(dir, 'state.json');
  writeFileSync(file, encodeLegacyState(map), 'utf8');
  return file;
};

/** The durable facts a restart must reproduce (no generated timestamps). */
const facts = (store: GatewayStateStore): unknown => ({
  conversations: [...store.loadConversations().entries()].sort(([a], [b]) => a.localeCompare(b)),
  turns: store.turnsFor('conv-a').map(({ turnId, seq, sessionId, nativeTurnId, state, startedAt, attempts }) => ({
    turnId, seq, sessionId, nativeTurnId, state, startedAt, attempts
  })),
  inFlight: store.inFlight('conv-a'),
  session: store.conversationForSession('cos-session-a'),
  shadow: store.shadowProjection()
});

test('the legacy state.json is imported once, losslessly, and then ignored', () => {
  const dir = stateDir();
  const file = writeLegacy(dir, legacyMap());
  const original = readFileSync(file, 'utf8');

  const store = open(dir);
  try {
    const conversations = store.loadConversations();
    assert.equal(conversations.size, 2);
    assert.deepEqual(conversations.get('conv-a'), {
      sessionId: 'cos-session-a', sentUsers: 2, turnInput: 'turn-in-flight',
      turnStartedAt: 1_700_000_000_100, turnSeq: 1
    });
    assert.deepEqual(conversations.get('conv-b'), {
      sessionId: 'cos-session-b', sentUsers: 1, turnInput: null, turnStartedAt: null, turnSeq: 4
    });

    // The in-flight turn becomes a real turn row, not just a slot value.
    const turn = store.turn('turn-in-flight');
    assert.equal(turn?.conversationKey, 'conv-a');
    assert.equal(turn?.state, 'in_flight');
    assert.equal(store.inFlight('conv-a')?.turnId, 'turn-in-flight');

    const record = store.importRecord(META_JSON_IMPORT);
    assert.equal(record?.state, 'done');
    assert.equal(record?.source, 'state.json');
    assert.equal(record?.conversations, 2);
    assert.equal(record?.inFlight, 1);
    assert.match(record?.sha256 ?? '', /^[0-9a-f]{64}$/);

    // The source is evidence, not a live input: it is left exactly as it was.
    assert.equal(readFileSync(file, 'utf8'), original);
  } finally {
    store.close();
  }

  // Editing the source after `done` must not be imported again.
  writeLegacy(dir, {
    'conv-a': { session_id: 'changed', sent_users: 99, turn_input: null, turn_started: null, turn_seq: 99 }
  });
  const reopened = open(dir);
  try {
    assert.equal(reopened.loadConversations().size, 2);
    assert.equal(reopened.loadConversations().get('conv-a')?.sessionId, 'cos-session-a');
    assert.equal(reopened.importRecord(META_JSON_IMPORT)?.state, 'done');
  } finally {
    reopened.close();
  }
});

test('two clean restarts reproduce identical state and identical shadow bytes', () => {
  const dir = stateDir();
  writeLegacy(dir, legacyMap());
  const first = open(dir);
  const expected = facts(first);
  const shadowPath = path.join(dir, SHADOW_STATE_FILE);
  const shadowBytes = readFileSync(shadowPath, 'utf8');
  first.close();

  for (let restart = 1; restart <= 2; restart += 1) {
    const store = open(dir);
    try {
      assert.deepEqual(facts(store), expected, `restart ${restart} changed the committed state`);
      assert.equal(readFileSync(shadowPath, 'utf8'), shadowBytes,
        `restart ${restart} changed the shadow export`);
    } finally {
      store.close();
    }
  }
});

test('an interrupted import retries on the next open and lands complete', () => {
  const dir = stateDir();
  writeLegacy(dir, legacyMap());
  assert.throws(
    () => GatewayStateStore.open({ dir, now: clock(), interruptMigrationAfter: 1 }),
    /simulated interruption/,
  );

  // The `running` marker was committed before the data transaction, so the
  // half-done attempt is visible rather than silently looking complete.
  const raw = new DatabaseSync(path.join(dir, DB_FILE));
  try {
    const row = raw.prepare('SELECT value FROM meta WHERE key = ?').get(META_JSON_IMPORT) as
      { value?: string } | undefined;
    const record = JSON.parse(row?.value ?? '{}') as { state?: string };
    assert.equal(record.state, 'running');
    const conversations = raw.prepare('SELECT count(*) AS c FROM conversations').get() as { c?: number };
    assert.equal(conversations.c, 0, 'the interrupted transaction left no partial rows');
  } finally {
    raw.close();
  }

  const store = open(dir);
  try {
    assert.equal(store.loadConversations().size, 2);
    assert.equal(store.importRecord(META_JSON_IMPORT)?.state, 'done');
    assert.equal(store.turn('turn-in-flight')?.state, 'in_flight');
  } finally {
    store.close();
  }
});

test('a hand-crafted running marker with partial rows is retried, not trusted', () => {
  const dir = stateDir();
  writeLegacy(dir, legacyMap());

  // Build what a killed process could leave: schema, a wrong row, and the
  // `running` marker already committed.
  const raw = new DatabaseSync(path.join(dir, DB_FILE));
  try {
    raw.exec(SCHEMA_SQL);
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    raw.prepare(
      'INSERT INTO conversations (conversation_key, session_id, sent_users, turn_seq, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run('conv-a', 'half-imported', 9, 7, 1);
    raw.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(META_JSON_IMPORT, JSON.stringify({
      state: 'running', source: 'state.json', sha256: null, conversations: 1, inFlight: 0,
      startedAt: 1, finishedAt: null, error: null
    }));
  } finally {
    raw.close();
  }

  const store = open(dir);
  try {
    const conversations = store.loadConversations();
    assert.equal(conversations.get('conv-a')?.sessionId, 'cos-session-a',
      'the retry replaces the partial row instead of keeping both');
    assert.equal(conversations.get('conv-a')?.sentUsers, 2);
    assert.equal(conversations.size, 2);
    assert.equal(store.importRecord(META_JSON_IMPORT)?.state, 'done');
  } finally {
    store.close();
  }
});

test('a damaged state.json marks the import failed and never blocks startup', () => {
  const dir = stateDir();
  writeFileSync(path.join(dir, 'state.json'), '{ this is not json', 'utf8');

  const store = open(dir);
  try {
    const record = store.importRecord(META_JSON_IMPORT);
    assert.equal(record?.state, 'failed');
    assert.match(record?.error ?? '', /invalid JSON/);
    assert.equal(store.loadConversations().size, 0);
    // The store itself is usable: availability comes before the import.
    store.saveConversation('live', {
      sessionId: 's-live', sentUsers: 1, turnInput: null, turnStartedAt: null, turnSeq: 0
    });
  } finally {
    store.close();
  }

  // A corrected file is retried on the next open instead of being ignored
  // forever; the corrected import replaces what the failed attempt left.
  writeLegacy(dir, legacyMap());
  const reopened = open(dir);
  try {
    assert.equal(reopened.importRecord(META_JSON_IMPORT)?.state, 'done');
    assert.equal(reopened.loadConversations().size, 2);
    assert.equal(reopened.loadConversations().get('conv-a')?.sessionId, 'cos-session-a');
  } finally {
    reopened.close();
  }
});

test('an empty database is rebuilt from the shadow export', () => {
  const dir = stateDir();
  // No state.json at all; the export is the only durable copy, as after a lost
  // or replaced database file.
  writeFileSync(path.join(dir, SHADOW_STATE_FILE), encodeLegacyState(legacyMap()), 'utf8');

  const store = open(dir);
  try {
    assert.equal(store.loadConversations().size, 2);
    assert.equal(store.conversationForSession('cos-session-b'), 'conv-b');
    assert.equal(store.inFlight('conv-a')?.turnId, 'turn-in-flight');
    assert.equal(store.turn('turn-in-flight')?.state, 'in_flight');
    assert.equal(store.importRecord(META_SHADOW_RECOVERY)?.state, 'done');
    // The one-shot legacy marker records that there was no state.json.
    assert.equal(store.importRecord(META_JSON_IMPORT)?.state, 'done');
  } finally {
    store.close();
  }
});

test('a backup restores the whole store into a fresh directory', async () => {
  const dir = stateDir();
  const store = open(dir);
  store.beginTurn({
    turnId: 'turn-backup', conversationKey: 'conv-a', seq: 0, sessionId: 'cos-session-a', startedAt: 5
  });
  store.saveConversation('conv-a', {
    sessionId: 'cos-session-a', sentUsers: 1, turnInput: 'turn-backup', turnStartedAt: 5, turnSeq: 0
  });
  const expected = facts(store);
  const backupFile = path.join(stateDir(), 'gateway-backup.db');
  await store.backupTo(backupFile);
  store.close();

  const restored = GatewayStateStore.restore({ dir: stateDir(), backup: backupFile, now: clock() });
  try {
    assert.deepEqual(facts(restored), expected);
    assert.equal(restored.turn('turn-backup')?.state, 'in_flight');
  } finally {
    restored.close();
  }
});

test('rollback rewrites state.json, retires the database files, and reimports losslessly', () => {
  const dir = stateDir();
  const store = open(dir);
  store.beginTurn({
    turnId: 'turn-rollback', conversationKey: 'conv-r', seq: 0, sessionId: 'cos-session-r', startedAt: 77
  });
  store.saveConversation('conv-r', {
    sessionId: 'cos-session-r', sentUsers: 3, turnInput: 'turn-rollback', turnStartedAt: 77, turnSeq: 0
  });
  const projection = store.shadowProjection();
  const turn = store.turn('turn-rollback');
  const inFlight = store.inFlight('conv-r');
  store.rollbackToLegacy();

  // The old build now owns the directory: `state.json` is exactly the retired
  // shape, and the database files are renamed aside rather than deleted.
  const legacyFile = path.join(dir, 'state.json');
  assert.deepEqual(JSON.parse(readFileSync(legacyFile, 'utf8')) as LegacyStateMap, projection);
  assert.equal(existsSync(path.join(dir, DB_FILE)), false);
  const aside = readdirSync(dir).filter((name) => name.startsWith(`${DB_FILE}.rolled-back-`));
  assert.ok(aside.length >= 1, 'the retired database is kept for recovery');

  // Opening this build again re-imports that state.json losslessly.
  const reopened = open(dir);
  try {
    assert.equal(reopened.importRecord(META_JSON_IMPORT)?.state, 'done');
    assert.equal(reopened.loadConversations().get('conv-r')?.sessionId, 'cos-session-r');
    assert.deepEqual(reopened.turn('turn-rollback'), turn);
    assert.deepEqual(reopened.inFlight('conv-r'), inFlight);
  } finally {
    reopened.close();
  }
});

test('a store written by a newer schema version is refused, not silently opened', () => {
  const dir = stateDir();
  const raw = new DatabaseSync(path.join(dir, DB_FILE));
  try {
    raw.exec(SCHEMA_SQL);
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  } finally {
    raw.close();
  }
  assert.throws(() => open(dir), /newer than this build/);
});

test('restore replaces a damaged database file and keeps it aside', async () => {
  const dir = stateDir();
  const seed = open(dir);
  seed.beginTurn({ turnId: 'turn-copy', conversationKey: 'k', seq: 0, sessionId: 's', startedAt: 1 });
  seed.saveConversation('k', {
    sessionId: 's', sentUsers: 1, turnInput: 'turn-copy', turnStartedAt: 1, turnSeq: 0
  });
  const backupFile = path.join(stateDir(), 'copy.db');
  await seed.backupTo(backupFile);
  seed.close();

  // A torn/foreign file must never be opened as if it were ours.
  writeFileSync(path.join(dir, DB_FILE), 'not a sqlite database', 'utf8');
  const restored = GatewayStateStore.restore({ dir, backup: backupFile, now: clock() });
  try {
    assert.equal(restored.loadConversations().get('k')?.sessionId, 's');
    assert.equal(restored.turn('turn-copy')?.state, 'in_flight');
  } finally {
    restored.close();
  }
  assert.ok(readdirSync(dir).some((name) => name.startsWith(`${DB_FILE}.replaced-`)),
    'the damaged database is kept beside the restored one');
  assert.equal(existsSync(path.join(dir, DB_FILE)), true);
});
