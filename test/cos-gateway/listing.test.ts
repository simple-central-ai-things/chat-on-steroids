/**
 * Read-only conversation and turn listing (platform spec D4 / H-045).
 *
 * Two layers are pinned here: the pure codecs/scope/views, and the store's
 * keyset scans. The scans are tested with more rows than one internal chunk, so
 * a rejected row (outside the instance's handle scope) can never stall or skip
 * pagination.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  conversationInScope,
  conversationView,
  CONVERSATIONS_DEFAULT_LIMIT,
  CONVERSATIONS_MAX_LIMIT,
  decodeConversationCursor,
  decodeTurnCursor,
  encodeConversationCursor,
  encodeTurnCursor,
  listConversations,
  listTurns,
  pageLimit,
  TURNS_DEFAULT_LIMIT,
  TURNS_MAX_LIMIT,
  turnView
} from '../../src/main/openai-gateway/listing.js';
import { GatewayError } from '../../src/main/openai-gateway/errors.js';
import { GatewayStateStore } from '../../src/main/openai-gateway/state/store.js';
import type { ListedConversation, StoredTurn } from '../../src/main/openai-gateway/state/schema.js';
import type { TurnManager } from '../../src/main/openai-gateway/turns.js';

const stateDir = (): string => mkdtempSync(path.join(tmpdir(), 'cos-gateway-listing-'));
const clock = (start = 1_700_000_000_000): (() => number) => {
  let at = start;
  return () => (at += 1);
};

const openStore = (dir: string): GatewayStateStore => GatewayStateStore.open({ dir, now: clock() });

/** The three read-only passthroughs `listing.ts` needs from the manager. */
const managerFor = (store: GatewayStateStore): TurnManager => ({
  conversationsPage: (options: Parameters<GatewayStateStore['conversationsPage']>[0]) =>
    store.conversationsPage(options),
  hasConversation: (key: string) => store.hasConversation(key),
  turnsPage: (key: string, options: Parameters<GatewayStateStore['turnsPage']>[1]) =>
    store.turnsPage(key, options)
}) as unknown as TurnManager;

const conversation = (overrides: Partial<ListedConversation> = {}): ListedConversation => ({
  conversationKey: 'conv-a',
  sessionId: 'session-a',
  sentUsers: 2,
  turnSeq: 3,
  updatedAt: 1_700_000_000_987,
  inFlightTurnId: null,
  inFlightStartedAt: null,
  ...overrides
});

const storedTurn = (overrides: Partial<StoredTurn> = {}): StoredTurn => ({
  turnId: 'turn-a',
  conversationKey: 'conv-a',
  seq: 0,
  sessionId: 'session-a',
  nativeTurnId: null,
  state: 'settled',
  startedAt: 1_700_000_000_123,
  finishedAt: 1_700_000_000_999,
  attempts: 1,
  lastError: null,
  ...overrides
});

// ------------------------------------------------------------------- cursors

test('a conversation cursor round-trips any key, including handle and unicode', () => {
  for (const key of [
    '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0',
    'cos:work:sess-shared-fixture',
    'cos:work:oturum-ü-ç/../x?y=z#frag',
    'x'
  ]) {
    const encoded = encodeConversationCursor(key);
    assert.match(encoded, /^c1\.[A-Za-z0-9_-]+$/);
    assert.equal(decodeConversationCursor(encoded), key);
  }
});

test('a conversation cursor this gateway did not issue is a 400 invalid_cursor', () => {
  for (const value of ['', 'nope', 'x1.abc', 'c1.', 'c1.a']) {
    assert.throws(
      () => decodeConversationCursor(value),
      (error: unknown) =>
        error instanceof GatewayError && error.status === 400 && error.code === 'invalid_cursor',
      `cursor ${JSON.stringify(value)} should be refused`
    );
  }
});

test('a turn cursor round-trips the composite total order', () => {
  const turn = { seq: 7, startedAt: 1_700_000_000_123, turnId: 'turn-ü:x/y' };
  const encoded = encodeTurnCursor(turn);
  assert.match(encoded, /^t1\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeTurnCursor(encoded), turn);
});

test('a malformed turn cursor is a 400 invalid_cursor', () => {
  const encode = (value: unknown): string =>
    't1.' + Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  for (const value of [
    '',
    'c1.abc',
    't1.',
    't1.' + Buffer.from('not json', 'utf8').toString('base64url'),
    encode({ seq: 1 }),
    encode([1, 2]),
    encode([1, 2, 3]),
    encode([1.5, 2, 'turn']),
    encode([1, 2, '']),
    encode(['1', 2, 'turn'])
  ]) {
    assert.throws(
      () => decodeTurnCursor(value),
      (error: unknown) =>
        error instanceof GatewayError && error.status === 400 && error.code === 'invalid_cursor',
      `cursor ${JSON.stringify(value)} should be refused`
    );
  }
});

// --------------------------------------------------------------- page limits

test('pageLimit defaults, accepts 1..max, and refuses anything else', () => {
  assert.equal(pageLimit(new URLSearchParams(), 7, 9), 7);
  assert.equal(pageLimit(new URLSearchParams('limit=1'), 7, 9), 1);
  assert.equal(pageLimit(new URLSearchParams('limit=9'), 7, 9), 9);
  for (const raw of ['0', '10', '-1', '1.5', 'abc', '01x', '']) {
    assert.throws(
      () => pageLimit(new URLSearchParams(`limit=${raw}`), 7, 9),
      (error: unknown) =>
        error instanceof GatewayError && error.status === 400 && error.code === 'invalid_body',
      `limit ${JSON.stringify(raw)} should be refused`
    );
  }
});

test('the published defaults and maxima are the documented ones', () => {
  assert.equal(CONVERSATIONS_DEFAULT_LIMIT, 20);
  assert.equal(CONVERSATIONS_MAX_LIMIT, 100);
  assert.equal(TURNS_DEFAULT_LIMIT, 50);
  assert.equal(TURNS_MAX_LIMIT, 200);
});

// --------------------------------------------------------------------- scope

test('scope is exclusive: legacy keys and handle keys never mix', () => {
  assert.equal(conversationInScope('legacy-key', null), true);
  assert.equal(conversationInScope('cos:work:key', null), false);
  assert.equal(conversationInScope('legacy-key', 'work'), false);
  assert.equal(conversationInScope('cos:work:key', 'work'), true);
  assert.equal(conversationInScope('cos:home:key', 'work'), false);
});

// --------------------------------------------------------------------- views

test('a conversation view publishes epoch seconds and an honest in-flight slot', () => {
  assert.deepEqual(conversationView(conversation()), {
    id: 'conv-a',
    object: 'conversation',
    session: 'session-a',
    sent_users: 2,
    turn_seq: 3,
    updated_at: 1_700_000_000,
    in_flight: null
  });
  assert.deepEqual(
    conversationView(conversation({
      inFlightTurnId: 'turn-live',
      inFlightStartedAt: 1_700_000_000_500
    })),
    {
      id: 'conv-a',
      object: 'conversation',
      session: 'session-a',
      sent_users: 2,
      turn_seq: 3,
      updated_at: 1_700_000_000,
      in_flight: { turn_id: 'turn-live', started_at: 1_700_000_000 }
    }
  );
});

test('a turn view publishes epoch seconds and keeps absent evidence absent', () => {
  assert.deepEqual(turnView(storedTurn()), {
    id: 'turn-a',
    object: 'turn',
    conversation: 'conv-a',
    seq: 0,
    session: 'session-a',
    native_turn_id: null,
    state: 'settled',
    started_at: 1_700_000_000,
    finished_at: 1_700_000_000,
    attempts: 1,
    last_error: null
  });
  const open = turnView(storedTurn({
    turnId: 'turn-open',
    state: 'in_flight',
    finishedAt: null,
    nativeTurnId: 'native-1',
    lastError: 'boom'
  }));
  assert.equal(open.finished_at, null);
  assert.equal(open.native_turn_id, 'native-1');
  assert.equal(open.last_error, 'boom');
});

// ------------------------------------------------------------- store scanning

test('conversationsPage crosses chunks and never stalls on a rejected row', () => {
  const dir = stateDir();
  const store = openStore(dir);
  try {
    const total = 205;
    const expected: string[] = [];
    for (let index = 0; index < total; index++) {
      const key = `conv-${String(index).padStart(3, '0')}`;
      store.saveConversation(key, {
        sessionId: `session-${index}`,
        sentUsers: index,
        turnInput: null,
        turnStartedAt: null,
        turnSeq: index
      });
      if (index % 3 === 0) expected.push(key);
    }
    const accept = (row: ListedConversation): boolean => Number(row.conversationKey.slice(5)) % 3 === 0;

    const seen: string[] = [];
    let after: string | null = null;
    let pages = 0;
    for (;;) {
      const page = store.conversationsPage({ after, limit: 10, accept });
      assert.ok(page.conversations.length <= 10);
      pages += 1;
      seen.push(...page.conversations.map((row) => row.conversationKey));
      if (!page.hasMore) break;
      assert.equal(page.conversations.length, 10, 'a non-final page is full');
      after = page.conversations[page.conversations.length - 1]!.conversationKey;
      assert.ok(pages < 20, 'pagination must terminate');
    }
    assert.deepEqual(seen, expected, 'every accepted row appears once, in key order');
    // The accepted rows span more than one internal 200-row scan chunk.
    assert.ok(expected.length > 60);
  } finally {
    store.close();
  }
});

test('hasConversation reports existence without reading state', () => {
  const store = openStore(stateDir());
  try {
    store.saveConversation('present', {
      sessionId: null,
      sentUsers: 0,
      turnInput: null,
      turnStartedAt: null,
      turnSeq: 0
    });
    assert.equal(store.hasConversation('present'), true);
    assert.equal(store.hasConversation('absent'), false);
  } finally {
    store.close();
  }
});

test('turnsPage pages a total order even when sequences and start times collide', () => {
  const store = openStore(stateDir());
  try {
    const seed = (turnId: string, seq: number, startedAt: number): void => {
      store.beginTurn({
        turnId,
        conversationKey: 'conv-a',
        seq,
        sessionId: 'session-a',
        startedAt
      });
      store.recordTurnOutcome(turnId, 'settled');
    };
    seed('turn-c', 0, 50);
    seed('turn-a', 0, 100);
    seed('turn-b', 0, 100);
    seed('turn-d', 1, 10);

    const first = store.turnsPage('conv-a', { limit: 2 });
    assert.deepEqual(first.turns.map((row) => row.turnId), ['turn-c', 'turn-a']);
    assert.equal(first.hasMore, true);

    const last = first.turns[first.turns.length - 1]!;
    const second = store.turnsPage('conv-a', {
      after: { seq: last.seq, startedAt: last.startedAt, turnId: last.turnId },
      limit: 2
    });
    assert.deepEqual(second.turns.map((row) => row.turnId), ['turn-b', 'turn-d']);
    assert.equal(second.hasMore, false);

    // An unrelated conversation is never mixed in.
    const other = store.turnsPage('conv-other', { limit: 10 });
    assert.deepEqual(other.turns, []);
    assert.equal(other.hasMore, false);
  } finally {
    store.close();
  }
});

// -------------------------------------------------------------- listing pages

test('listConversations publishes only the instance\'s own scope', () => {
  const store = openStore(stateDir());
  try {
    store.saveConversation('legacy-alpha', {
      sessionId: 'session-legacy',
      sentUsers: 1,
      turnInput: null,
      turnStartedAt: null,
      turnSeq: 1
    });
    store.saveConversation('cos:work:beta', {
      sessionId: 'session-work',
      sentUsers: 1,
      turnInput: null,
      turnStartedAt: null,
      turnSeq: 1
    });
    const manager = managerFor(store);

    const legacy = listConversations(manager, null, new URLSearchParams());
    assert.deepEqual(legacy.data.map((row) => row.id), ['legacy-alpha']);
    assert.equal(legacy.object, 'list');
    assert.equal(legacy.has_more, false);
    assert.equal(legacy.next_cursor, null);

    const work = listConversations(manager, 'work', new URLSearchParams());
    assert.deepEqual(work.data.map((row) => row.id), ['cos:work:beta']);
    assert.equal(work.data[0]!.session, 'session-work');
  } finally {
    store.close();
  }
});

test('listConversations continues from the cursor it published', () => {
  const store = openStore(stateDir());
  try {
    for (let index = 0; index < 5; index++) {
      store.saveConversation(`conv-${index}`, {
        sessionId: `session-${index}`,
        sentUsers: 0,
        turnInput: null,
        turnStartedAt: null,
        turnSeq: 0
      });
    }
    const manager = managerFor(store);
    const first = listConversations(manager, null, new URLSearchParams('limit=2'));
    assert.deepEqual(first.data.map((row) => row.id), ['conv-0', 'conv-1']);
    assert.equal(first.has_more, true);
    assert.ok(first.next_cursor !== null);

    const second = listConversations(
      manager,
      null,
      new URLSearchParams(`limit=2&cursor=${encodeURIComponent(first.next_cursor!)}`)
    );
    assert.deepEqual(second.data.map((row) => row.id), ['conv-2', 'conv-3']);
    assert.equal(second.has_more, true);
    assert.ok(second.next_cursor !== null);

    const third = listConversations(
      manager,
      null,
      new URLSearchParams(`limit=2&cursor=${encodeURIComponent(second.next_cursor!)}`)
    );
    assert.deepEqual(third.data.map((row) => row.id), ['conv-4']);
    assert.equal(third.has_more, false);
    assert.equal(third.next_cursor, null);
  } finally {
    store.close();
  }
});

test('listTurns refuses a missing or foreign conversation with the same 404', () => {
  const store = openStore(stateDir());
  try {
    store.saveConversation('cos:work:key', {
      sessionId: 'session-work',
      sentUsers: 1,
      turnInput: null,
      turnStartedAt: null,
      turnSeq: 1
    });
    const manager = managerFor(store);
    for (const [localHandle, key] of [
      [null, 'missing'],
      [null, 'cos:work:key'],
      ['home', 'cos:work:key']
    ] as const) {
      assert.throws(
        () => listTurns(manager, localHandle, key, new URLSearchParams()),
        (error: unknown) =>
          error instanceof GatewayError &&
          error.status === 404 &&
          error.code === 'not_found' &&
          /no such conversation/.test(error.message),
        `${String(localHandle)}/${key} must be indistinguishable from missing`
      );
    }
  } finally {
    store.close();
  }
});

test('listTurns pages the composite cursor and converts timestamps', () => {
  const store = openStore(stateDir());
  try {
    store.saveConversation('conv-a', {
      sessionId: 'session-a',
      sentUsers: 55,
      turnInput: null,
      turnStartedAt: null,
      turnSeq: 55
    });
    for (let seq = 0; seq < 55; seq++) {
      const turnId = `turn-${String(seq).padStart(2, '0')}`;
      store.beginTurn({
        turnId,
        conversationKey: 'conv-a',
        seq,
        sessionId: 'session-a',
        startedAt: 1_700_000_000_000 + seq
      });
      store.recordTurnOutcome(turnId, 'settled');
    }
    const manager = managerFor(store);

    const first = listTurns(manager, null, 'conv-a', new URLSearchParams());
    assert.equal(first.data.length, TURNS_DEFAULT_LIMIT);
    assert.equal(first.has_more, true);
    assert.ok(first.next_cursor !== null);
    assert.equal(first.data[0]!.id, 'turn-00');
    assert.equal(first.data[0]!.started_at, 1_700_000_000);
    assert.equal(first.data[0]!.object, 'turn');
    assert.equal(first.data[0]!.conversation, 'conv-a');

    const second = listTurns(
      manager,
      null,
      'conv-a',
      new URLSearchParams(`cursor=${encodeURIComponent(first.next_cursor!)}`)
    );
    assert.deepEqual(
      second.data.map((row) => row.id),
      ['turn-50', 'turn-51', 'turn-52', 'turn-53', 'turn-54']
    );
    assert.equal(second.has_more, false);
    assert.equal(second.next_cursor, null);
  } finally {
    store.close();
  }
});

test('listing refuses an out-of-range limit with a 400', () => {
  const store = openStore(stateDir());
  try {
    store.saveConversation('conv-a', {
      sessionId: 'session-a',
      sentUsers: 0,
      turnInput: null,
      turnStartedAt: null,
      turnSeq: 0
    });
    const manager = managerFor(store);
    for (const limit of ['0', '101', 'abc']) {
      assert.throws(
        () => listConversations(manager, null, new URLSearchParams(`limit=${limit}`)),
        (error: unknown) =>
          error instanceof GatewayError && error.status === 400 && error.code === 'invalid_body'
      );
    }
    assert.throws(
      () => listTurns(manager, null, 'conv-a', new URLSearchParams('limit=201')),
      (error: unknown) =>
        error instanceof GatewayError && error.status === 400 && error.code === 'invalid_body'
    );
  } finally {
    store.close();
  }
});
