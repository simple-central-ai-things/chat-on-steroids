import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTEXT_MARKER,
  conversationKey,
  foldDelta,
  foldFirst,
  lastUserMessage,
  normalizeMessages,
  systemText,
  FoldError,
  MAX_TEXT
} from '../../src/main/openai-gateway/fold.js';

const messages = [
  { role: 'system', content: 'You are terse.' },
  { role: 'user', content: 'Hello' },
  { role: 'assistant', content: 'Hi' },
  { role: 'user', content: 'Tell me more' }
];

test('normalizes roles and rejects anything else', () => {
  const normalized = normalizeMessages(messages);
  assert.deepEqual(normalized, [
    ['system', 'You are terse.'],
    ['user', 'Hello'],
    ['assistant', 'Hi'],
    ['user', 'Tell me more']
  ]);
  assert.throws(() => normalizeMessages([]), FoldError);
  assert.throws(() => normalizeMessages([{ role: 'tool', content: 'x' }]), /role/);
  assert.throws(() => normalizeMessages([{ role: 'user', content: '  ' }]), /content/);
  assert.throws(() => normalizeMessages([{ role: 'user', content: [{ type: 'text' }] }]), /non-empty string/);
});

test('first turn folds the system message into a context prefix block', () => {
  const normalized = normalizeMessages(messages);
  const text = foldFirst(normalized, true);
  assert.equal(
    text,
    `${CONTEXT_MARKER}\nYou are terse.\n\nTell me more`,
  );
});

test('first turn without include_system sends only the user text', () => {
  const normalized = normalizeMessages(messages);
  assert.equal(foldFirst(normalized, false), 'Tell me more');
});

test('first turn with no system message sends the plain user text', () => {
  const normalized = normalizeMessages([{ role: 'user', content: 'Just hello' }]);
  assert.equal(foldFirst(normalized, true), 'Just hello');
});

test('later turns send only the newest user delta', () => {
  const normalized = normalizeMessages(messages);
  assert.equal(foldDelta(normalized), 'Tell me more');
});

test('the last message must be a user message', () => {
  assert.throws(() => lastUserMessage([['assistant', 'done']]), FoldError);
  assert.throws(() => foldDelta(normalizeMessages(messages.slice(0, 3))), FoldError);
});

test('system text joins all system messages', () => {
  const normalized = normalizeMessages([
    { role: 'system', content: 'One' },
    { role: 'system', content: 'Two' },
    { role: 'user', content: 'Hi' }
  ]);
  assert.equal(systemText(normalized), 'One\n\nTwo');
  assert.equal(systemText(normalizeMessages([{ role: 'user', content: 'Hi' }])), null);
});

test('text beyond the CoS ceiling is a fold error', () => {
  const normalized = normalizeMessages([{ role: 'user', content: 'x'.repeat(MAX_TEXT + 1) }]);
  assert.throws(() => foldDelta(normalized), /at most/);
});

test('the conversation key is stable across turns of one conversation', async () => {
  const first = normalizeMessages(messages);
  const second = normalizeMessages([
    ...messages,
    { role: 'assistant', content: 'More!' },
    { role: 'user', content: 'Again' }
  ]);
  const key1 = conversationKey(first, null);
  const key2 = conversationKey(second, null);
  assert.match(key1, /^[0-9a-f]{64}$/);
  assert.equal(key1, key2);

  const other = normalizeMessages([{ role: 'user', content: 'A different opener' }]);
  assert.notEqual(conversationKey(other, null), key1);
});

test('the conversation key includes the system context, so callers do not share sessions', () => {
  const opener = (system: string | null) => normalizeMessages([
    ...(system === null ? [] : [{ role: 'system', content: system }]),
    { role: 'user', content: 'Hello' }
  ]);
  const keyA = conversationKey(opener('Caller A context'), null);
  const keyPlain = conversationKey(opener(null), null);
  const keyB = conversationKey(opener('Caller B context'), null);
  assert.notEqual(keyA, keyPlain, 'same opener, different context: different sessions');
  assert.notEqual(keyA, keyB);
  assert.notEqual(keyPlain, keyB);
});

test('the conversation key honors an override and requires a user message', () => {
  const normalized = normalizeMessages(messages);
  assert.equal(conversationKey(normalized, '  my-key  '), 'my-key');
  assert.throws(
    () => conversationKey([['system', 'Only context']], null),
    /at least one user message/,
  );
});
