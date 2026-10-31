import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  errorBody,
  isReasoningEffort,
  mapChatError,
  mapEndedWithoutAnswer,
  mapRefusal,
  mapSessionBusy,
  mapTurnTimeout,
  mapUndelivered
} from '../../src/main/openai-gateway/errors.js';

test('outbox refusals map to the gateway contract', () => {
  const cases: Array<[string, number, string, number | undefined]> = [
    ['The app is shutting down', 503, 'shutting_down', undefined],
    ['Input cancelled', 409, 'cancelled', undefined],
    ['One message is already awaiting delivery for this chat.', 429, 'busy', 5],
    ['Message id already belongs to different input', 409, 'id_conflict', undefined],
    ['Unblock this conversation before sending', 502, 'chat_blocked', undefined],
    ['This recording has no ChatGPT conversation', 502, 'no_chat', undefined],
    ['The message queue is full', 503, 'queue_full', undefined]
  ];
  for (const [message, status, code, retryAfter] of cases) {
    const mapped = mapRefusal(new Error(message));
    assert.ok(mapped, `unmapped: ${message}`);
    assert.equal(mapped.status, status, message);
    assert.equal(mapped.code, code, message);
    assert.equal(mapped.retryAfterSeconds, retryAfter, message);
  }
  assert.equal(mapRefusal(new Error('something new')), null);
});

test('chat_error with a deadline is a 429 carrying Retry-After', () => {
  const now = 1_730_000_000_000;
  const error = mapChatError({
    message: { text: 'history limit' },
    retryAt: now + 12_000,
    recoverable: true
  }, now);
  assert.equal(error.status, 429);
  assert.equal(error.code, 'chat_error');
  assert.equal(error.retryAfterSeconds, 12);
});

test('chat_error without a deadline is a 502', () => {
  const error = mapChatError({ message: { text: 'hard stop' } }, 0);
  assert.equal(error.status, 502);
  assert.equal(error.retryAfterSeconds, undefined);
});

test('a turn end without an answer is a 502', () => {
  const error = mapEndedWithoutAnswer('stopped');
  assert.equal(error.status, 502);
  assert.match(error.message, /stopped/);
});

test('an undelivered row is a 502 that says where it is', () => {
  const error = mapUndelivered('Browser startup failed: x');
  assert.equal(error.status, 502);
  assert.match(error.message, /Browser startup failed/);
});

test('turn timeout is a 504 and session busy is a 429', () => {
  assert.equal(mapTurnTimeout(600).status, 504);
  const busy = mapSessionBusy(60);
  assert.equal(busy.status, 429);
  assert.equal(busy.retryAfterSeconds, 60);
});

test('error bodies are OpenAI-shaped with the right type per status', () => {
  const body = errorBody({ status: 429, code: 'busy', message: 'b', retryAfterSeconds: 5 });
  assert.deepEqual(body, { error: { message: 'b', type: 'rate_limit_error', code: 'busy' } });
  assert.equal(errorBody({ status: 400, code: 'c', message: 'm' }).error.type, 'invalid_request_error');
  assert.equal(errorBody({ status: 503, code: 'c', message: 'm' }).error.type, 'server_error');
});

test('reasoning effort membership is checked against CoS vocabulary', () => {
  assert.equal(isReasoningEffort('high'), true);
  assert.equal(isReasoningEffort('ultra'), true);
  assert.equal(isReasoningEffort('turbo'), false);
  assert.equal(isReasoningEffort(3), false);
});
