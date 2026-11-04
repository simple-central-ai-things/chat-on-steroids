/**
 * The published failure contract (platform spec D4 / H-045).
 *
 * `GET /v1/errors` is derived from the two authorities the gateway already
 * enforces: `GATEWAY_ERRORS` (code -> status) and `classifyFailure` (what a
 * pool may do next). These tests pin that derivation so a router can never read
 * a row that disagrees with the answer the instance actually gives.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ERROR_CONTRACT,
  ERROR_CONTRACT_VERSION,
  errorContractFor,
  type ErrorAdvice,
  type ErrorContractRow
} from '../../src/main/openai-gateway/contract.js';
import { GATEWAY_ERRORS, type GatewayErrorCode } from '../../src/main/openai-gateway/errors.js';
import { classifyFailure } from '../../src/main/openai-gateway/failover.js';

const codes = Object.keys(GATEWAY_ERRORS) as GatewayErrorCode[];

function ledgerStatuses(code: GatewayErrorCode): readonly number[] {
  const declared = GATEWAY_ERRORS[code].status;
  return typeof declared === 'number' ? [declared] : declared;
}

test('the contract has one row per (code, status) the ledger can answer', () => {
  const expected = codes.reduce((count, code) => count + ledgerStatuses(code).length, 0);
  assert.equal(ERROR_CONTRACT.length, expected);
  assert.equal(ERROR_CONTRACT_VERSION, 1);
  for (const code of codes) {
    assert.deepEqual(
      errorContractFor(code).map((row) => row.status),
      ledgerStatuses(code),
      `${code} must publish exactly its ledger statuses`
    );
  }
});

test('chat_error is the only code with two rows, and they differ in advice', () => {
  const twoRow = codes.filter((code) => ledgerStatuses(code).length > 1);
  assert.deepEqual(twoRow, ['chat_error']);
  const rows = errorContractFor('chat_error');
  assert.deepEqual(rows.map((row) => row.status), [429, 502]);
  // A 429 is throttled (wait out Retry-After); a 502 is a hard chat failure.
  const throttled = rows[0]!;
  const hard = rows[1]!;
  assert.equal(throttled.class, 'throttled');
  assert.equal(throttled.may_failover, false);
  assert.equal(throttled.advice, 'wait');
  assert.equal(throttled.retry_after, true);
  assert.equal(hard.class, 'terminal');
  assert.equal(hard.may_failover, false);
  assert.equal(hard.advice, 'none');
  assert.equal(hard.retry_after, false);
});

test('every row agrees with classifyFailure and the advice rule', () => {
  const adviceFor = (row: ErrorContractRow): ErrorAdvice => {
    if (row.class === 'throttled') return 'wait';
    if (row.status === 504) return 'reattach';
    return row.may_failover ? 'failover' : 'none';
  };
  for (const row of ERROR_CONTRACT) {
    const decision = classifyFailure({
      status: row.status,
      code: row.code,
      retryAfterSeconds: row.status === 429 ? 1 : undefined
    });
    assert.equal(row.class, decision.class, `${row.code}/${row.status} class`);
    assert.equal(row.may_failover, decision.mayFailover, `${row.code}/${row.status} failover`);
    assert.equal(row.advice, adviceFor(row), `${row.code}/${row.status} advice`);
    // Only a throttle carries Retry-After.
    assert.equal(row.retry_after, row.status === 429, `${row.code}/${row.status} retry_after`);
  }
});

test('a 503 availability failure is the only failover advice', () => {
  const failover = ERROR_CONTRACT.filter((row) => row.advice === 'failover');
  assert.ok(failover.length > 0);
  for (const row of failover) {
    assert.equal(row.status, 503, `${row.code} may failover with ${row.status}`);
    assert.equal(row.class, 'handle_unavailable');
    assert.equal(row.may_failover, true);
  }
  // A turn timeout is a turn still running in this account: re-attach, never
  // duplicate it on another handle.
  const timeout = ERROR_CONTRACT.find((row) => row.code === 'turn_timeout');
  assert.ok(timeout);
  assert.equal(timeout.status, 504);
  assert.equal(timeout.advice, 'reattach');
  assert.equal(timeout.may_failover, false);
});

test('the new H-045 codes are additive rows with their documented statuses', () => {
  assert.deepEqual(errorContractFor('invalid_cursor'), [
    {
      code: 'invalid_cursor',
      status: 400,
      class: 'terminal',
      may_failover: false,
      advice: 'none',
      retry_after: false
    }
  ]);
  assert.deepEqual(errorContractFor('tools_unsupported'), [
    {
      code: 'tools_unsupported',
      status: 400,
      class: 'terminal',
      may_failover: false,
      advice: 'none',
      retry_after: false
    }
  ]);
});

test('existing statuses did not move', () => {
  const statusOf = (code: GatewayErrorCode): number => {
    const rows = errorContractFor(code);
    assert.equal(rows.length, 1, `${code} should have one row`);
    return rows[0]!.status;
  };
  assert.equal(statusOf('unauthorized'), 401);
  assert.equal(statusOf('not_found'), 404);
  assert.equal(statusOf('invalid_body'), 400);
  assert.equal(statusOf('handle_disabled'), 403);
  assert.equal(statusOf('cross_handle_session'), 409);
  assert.equal(statusOf('busy'), 429);
  assert.equal(statusOf('chat_blocked'), 502);
  assert.equal(statusOf('handle_not_ready'), 503);
  assert.equal(statusOf('turn_timeout'), 504);
});

test('a throttled row always publishes the wait advice with Retry-After', () => {
  const throttled = ERROR_CONTRACT.filter((row) => row.status === 429);
  assert.ok(throttled.length >= 4);
  for (const row of throttled) {
    assert.equal(row.class, 'throttled', row.code);
    assert.equal(row.advice, 'wait', row.code);
    assert.equal(row.retry_after, true, row.code);
    assert.equal(row.may_failover, false, row.code);
  }
});
