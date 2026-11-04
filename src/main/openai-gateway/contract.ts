/**
 * The published failure contract (platform spec D4 / H-045).
 *
 * `GATEWAY_ERRORS` (errors.ts) is the single code -> status ledger the gateway
 * enforces. `failover.ts` decides what a pool in front of the instances (SCPM)
 * may do with one failure. This module derives the wire-visible contract from
 * BOTH, so a published row can never disagree with what the gateway actually
 * answers or with what the router actually does:
 *
 *   code          the machine-readable `error.code`
 *   status        the HTTP status that code maps to
 *   class         throttled | handle_unavailable | terminal (failover.ts)
 *   may_failover  whether another handle may serve the same request
 *   advice        wait -> honor Retry-After, failover -> try another handle,
 *                 reattach -> the turn keeps running, poll it again,
 *                 none -> the request itself is at fault
 *   retry_after   whether the answer carries a `Retry-After` header
 *
 * A code with two statuses (`chat_error`: 429 with a deadline, 502 without)
 * publishes one row per status, because the router's move differs between
 * them. Additive only: a new code is a new `GATEWAY_ERRORS` row, and this
 * contract follows it without a second edit. `ERROR_CONTRACT_VERSION` is
 * bumped only when the row SHAPE changes, never when a code is added.
 */
import { GATEWAY_ERRORS, type GatewayErrorCode } from './errors.js';
import { classifyFailure, type FailureClass } from './failover.js';

export const ERROR_CONTRACT_VERSION = 1;

/** What the published contract tells a router or a client to do next. */
export type ErrorAdvice = 'wait' | 'failover' | 'reattach' | 'none';

/** One (code, status) row of the published contract. */
export interface ErrorContractRow {
  code: GatewayErrorCode;
  status: number;
  class: FailureClass;
  may_failover: boolean;
  advice: ErrorAdvice;
  retry_after: boolean;
}

/** Every `(code, status)` pair the gateway can answer, in ledger order. */
export const ERROR_CONTRACT: readonly ErrorContractRow[] = Object.freeze(
  (Object.keys(GATEWAY_ERRORS) as GatewayErrorCode[]).flatMap((code) => {
    const spec = GATEWAY_ERRORS[code];
    const declared: number | readonly number[] = spec.status;
    const statuses: readonly number[] = typeof declared === 'number' ? [declared] : declared;
    return statuses.map((status) => contractRow(code, status));
  })
);

/** The rows published for one code (one, or two for `chat_error`). */
export function errorContractFor(code: GatewayErrorCode): readonly ErrorContractRow[] {
  return ERROR_CONTRACT.filter((row) => row.code === code);
}

function contractRow(code: GatewayErrorCode, status: number): ErrorContractRow {
  const decision = classifyFailure({ status, code, retryAfterSeconds: status === 429 ? 1 : undefined });
  const advice: ErrorAdvice =
    decision.class === 'throttled' ? 'wait'
    : status === 504 ? 'reattach'
    : decision.mayFailover ? 'failover'
    : 'none';
  return {
    code,
    status,
    class: decision.class,
    may_failover: decision.mayFailover,
    advice,
    // A throttle always answers Retry-After; nothing else does.
    retry_after: status === 429
  };
}
