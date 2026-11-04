/**
 * Handle pool failover (platform spec D1 / H-042).
 *
 * A pool is several handles that offer the same model identity; it exists so a
 * request can still be served when one handle is *unavailable* — its instance is
 * shutting down, its queue is full, or its browser evidence no longer proves it
 * is signed in. Failover is optional and deliberately narrow:
 *
 *   - ONLY a classified transient unavailability may move a request to another
 *     handle. A throttle (429), a client error, a stateful chat failure (502)
 *     and a turn timeout (504) never do: hopping accounts for a throttle would
 *     multiply the load it is asking us to shed, a 502 may already have been
 *     delivered into that account's conversation, and a 504 is a turn still
 *     running in it — moving it would ask a second account the same question.
 *   - `Retry-After` is honored, never shortened: a throttled pool answers
 *     `wait` with the deadline it was given, and the client retries.
 *   - an attempted handle is never tried twice for one request, so a pool can
 *     not loop.
 *
 * This module is a pure decision layer. The process that actually serves a
 * handle is the instance that owns it (one account per instance), so the pool
 * plan is consumed by the router in front of the instances; this file makes the
 * decision testable offline and keeps every instance's own refusals honest.
 */
import type { Handle, HandleReadiness, HandleStatus } from './handles.js';

/** The three ways a failure decides the pool's next move. */
export type FailureClass = 'throttled' | 'handle_unavailable' | 'terminal';

/** The fields of a gateway failure the classifier reads. */
export interface FailureSignal {
  status: number;
  code: string;
  retryAfterSeconds?: number;
}

export interface FailureDecision {
  class: FailureClass;
  /** Whether another handle may serve the same request. */
  mayFailover: boolean;
  /** The deadline the client was given (from Retry-After), never invented. */
  retryAfterSeconds?: number;
  reason: string;
}

/**
 * The 503 codes that mean "this instance cannot serve right now" rather than
 * "this request is wrong". Kept as a list so a new 503 code is a deliberate
 * decision here, not an accidental failover.
 */
export const UNAVAILABLE_CODES: readonly string[] = [
  'shutting_down',
  'queue_full',
  'models_unknown',
  'models_not_ready',
  'gateway_unconfigured',
  'handle_registry_invalid',
  'handle_not_ready',
  'handle_unavailable'
];

/**
 * Classify one failure for pool purposes.
 *
 *  - 429 → throttled: wait out Retry-After; never hop accounts.
 *  - 503 availability → handle_unavailable: the next ready handle may serve it,
 *    because nothing of the request was accepted here.
 *  - 504 → terminal: the turn is STILL RUNNING in that account; the client
 *    re-attaches (same handle, same turn id) instead of duplicating it.
 *  - everything else → terminal: the request is at fault, the chat refused it
 *    in a stateful way, or the failure may already have reached the account.
 */
export function classifyFailure(error: FailureSignal): FailureDecision {
  if (error.status === 429) {
    return {
      class: 'throttled',
      mayFailover: false,
      ...(error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
      reason: 'the account is throttled; honoring Retry-After instead of moving the request'
    };
  }
  if (error.status === 503) {
    const known = UNAVAILABLE_CODES.includes(error.code);
    return {
      class: 'handle_unavailable',
      mayFailover: true,
      reason: known
        ? `this instance cannot serve (${error.code}); another handle may`
        : `this instance cannot serve (${error.code})`
    };
  }
  if (error.status === 504) {
    return {
      class: 'terminal',
      mayFailover: false,
      reason: 'the turn keeps running in this account; re-attach instead of duplicating it'
    };
  }
  return {
    class: 'terminal',
    mayFailover: false,
    reason: `the failure (${error.status} ${error.code}) is not a handle availability problem`
  };
}

/** One handle's place in a model's pool. */
export interface PoolCandidate {
  handle: string;
  status: HandleStatus;
  ready: boolean;
  order: number;
}

/**
 * The pool for one base model: every handle that declares it, in operator
 * order, with the readiness this instance can prove for it. A handle this
 * instance cannot observe is `unknown` and therefore not ready.
 */
export function poolCandidates(
  handles: readonly Handle[],
  model: string | null,
  readiness: ReadonlyMap<string, HandleReadiness>,
): PoolCandidate[] {
  return handles
    .filter((handle) => handle.enabled &&
      (model === null || handle.models.length === 0 || handle.models.includes(model)))
    .map((handle) => {
      const state = readiness.get(handle.handle);
      return {
        handle: handle.handle,
        status: state?.status ?? 'unknown',
        ready: state?.ready === true,
        order: handle.order
      };
    })
    .sort((a, b) => (a.order - b.order) || a.handle.localeCompare(b.handle));
}

/** Only the handles that may serve a turn now (unknown is not ready). */
export function readyPool(pool: readonly PoolCandidate[]): PoolCandidate[] {
  return pool.filter((candidate) => candidate.ready);
}

/** What the pool does after one handle failed a request. */
export interface FailoverStep {
  action: 'retry_next' | 'wait' | 'stop';
  /** The handle to try next, for `retry_next`. */
  handle?: string;
  /** The Retry-After the client must honor, for `wait`. */
  retryAfterSeconds?: number;
  reason: string;
}

/**
 * Decide the next pool move: retry on the next ready handle, tell the client to
 * wait, or stop. `attempted` is every handle already tried for this request
 * (including the one that just failed), so no handle is tried twice.
 */
export function planFailover(
  pool: readonly PoolCandidate[],
  attempted: readonly string[],
  error: FailureSignal,
): FailoverStep {
  const decision = classifyFailure(error);
  if (decision.class === 'throttled') {
    return {
      action: 'wait',
      ...(decision.retryAfterSeconds !== undefined ? { retryAfterSeconds: decision.retryAfterSeconds } : {}),
      reason: decision.reason
    };
  }
  if (!decision.mayFailover) return { action: 'stop', reason: decision.reason };
  const next = pool.find((candidate) => candidate.ready && !attempted.includes(candidate.handle));
  if (next === undefined) {
    return { action: 'stop', reason: `${decision.reason}; no ready handle is left in the pool` };
  }
  return { action: 'retry_next', handle: next.handle, reason: decision.reason };
}
