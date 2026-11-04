/**
 * Failure semantics — the error/status contract SCPM's failover relies on.
 *
 * CoS's outbox throws plain errors; control-actions.ts refusal() is the
 * reference for which literals are actionable (control-actions.ts:98-109).
 * This mapping re-expresses them as OpenAI-style errors for the gateway:
 *
 *   400  invalid OpenAI body, unknown model, unavailable effort, unknown
 *        handle, an identity this instance does not serve
 *   403  the handle named by the request is disabled by the operator
 *   409  id_conflict (a retry with a changed payload), a CoS session already
 *        bound to another handle's conversation
 *   429  busy / would_interrupt / session busy (Retry-After always set),
 *        chat_error with retryAt (Retry-After from the deadline)
 *   502  the upstream chat is unusable (no_chat, chat_blocked), a turn that
 *        ended without an answer, an input row that never got delivered
 *   503  CoS itself unavailable: shutting_down, queue_full, models_unknown,
 *        the catalog not ready, or a handle that is not proven ready
 *   504  the turn did not finish in TURN_TIMEOUT_SECONDS; it keeps running
 *        and a later request re-attaches to it by input id
 *
 * GATEWAY_ERRORS is the single status/code ledger. Handlers and tests both
 * read it, so a status can never drift from its code; every code maps to
 * exactly one HTTP status. Additive only — a new code is a new row here,
 * never a renumbering of an existing one.
 */
import { REASONING_EFFORTS, type ReasoningEffort } from './catalog.js';

/** A gateway failure with its OpenAI-style status and machine-readable code. */
export interface GatewayErrorData {
  status: number;
  code: string;
  message: string;
  retryAfterSeconds?: number;
}

/** One code's status(es) and a static message (or template) for that code. */
export interface GatewayErrorSpec {
  /**
   * The HTTP status(es) this code maps to. A single number for a fixed status;
   * an array only for `chat_error`, which is 429 when ChatGPT gave a Retry-After
   * deadline and 502 when it did not.
   */
  status: number | readonly number[];
  message: string;
}

/** The code -> { status, message } ledger. Additive; a code never changes status. */
export const GATEWAY_ERRORS = {
  unauthorized: { status: 401, message: 'bearer key required' },
  not_found: { status: 404, message: 'unknown route' },
  body_too_large: { status: 413, message: 'the request body is too large' },
  invalid_json: { status: 400, message: 'the request body is not valid JSON' },
  invalid_body: { status: 400, message: 'the request body is not a valid chat request' },
  invalid_cursor: { status: 400, message: 'the pagination cursor is not one this gateway issued' },
  tools_unsupported: {
    status: 400,
    message: 'tool and function calls are not supported by this gateway; send a plain chat completion'
  },
  invalid_reasoning_effort: { status: 400, message: 'reasoning_effort is not one of the efforts ChatGPT offers' },
  model_unknown: { status: 400, message: 'GET /v1/models lists the models this account offers' },
  effort_unavailable: { status: 400, message: 'the model does not offer that reasoning effort' },
  handle_unknown: { status: 400, message: 'the model identity names no handle of this deployment' },
  handle_mismatch: { status: 400, message: 'this instance serves a different handle' },
  handle_disabled: { status: 403, message: 'the handle is disabled by the operator' },
  cross_handle_session: { status: 409, message: 'that session belongs to another handle' },
  id_conflict: { status: 409, message: 'this id belongs to a different message' },
  cancelled: { status: 409, message: 'cancelled' },
  turn_stopped: { status: 409, message: 'the turn was stopped before it finished' },
  busy: { status: 429, message: 'another message for this chat is still awaiting delivery' },
  would_interrupt: { status: 429, message: 'the chat is answering right now; retry once the turn ends' },
  session_busy: { status: 429, message: 'one turn is still running for this conversation' },
  chat_error: { status: [429, 502] as const, message: 'the chat reported an error' },
  chat_blocked: { status: 502, message: 'Unblock this conversation before sending' },
  no_chat: { status: 502, message: 'This recording has no ChatGPT conversation' },
  send_failed: { status: 502, message: 'the send failed' },
  no_session: { status: 502, message: 'no session to follow' },
  internal: { status: 502, message: 'internal error' },
  turn_ended_without_answer: { status: 502, message: 'the turn ended without an answer' },
  not_delivered: { status: 502, message: 'the message was not delivered to ChatGPT' },
  models_unknown: { status: 503, message: "the app has not read this account's models yet; refresh them in the app" },
  shutting_down: { status: 503, message: 'The app is shutting down' },
  queue_full: { status: 503, message: 'The message queue is full' },
  models_not_ready: { status: 503, message: 'the model catalog is not ready yet' },
  handle_not_ready: { status: 503, message: 'this handle is not proven ready by live browser evidence' },
  handle_unavailable: { status: 503, message: 'no handle in the pool can serve this model right now' },
  handle_registry_invalid: { status: 503, message: 'the handle registry is invalid; this instance refuses to serve' },
  gateway_unconfigured: { status: 503, message: 'GATEWAY_API_KEY is not set; the gateway refuses all /v1/* traffic' },
  turn_timeout: { status: 504, message: 'the turn did not finish in time; it keeps running, retry to re-attach' }
} as const satisfies Record<string, GatewayErrorSpec>;

export type GatewayErrorCode = keyof typeof GATEWAY_ERRORS;

/** Build an error whose status is bound to its code by the ledger above. */
export function gatewayError(
  code: GatewayErrorCode,
  message?: string,
  retryAfterSeconds?: number,
): GatewayError {
  const spec = GATEWAY_ERRORS[code];
  const status = Array.isArray(spec.status) ? spec.status[0]! : spec.status;
  return new GatewayError(status, code, message ?? spec.message, retryAfterSeconds);
}

export class GatewayError extends Error implements GatewayErrorData {
  status: number;
  code: string;
  retryAfterSeconds?: number;
  constructor(status: number, code: string, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** OpenAI-style error body. */
export function errorBody(error: GatewayErrorData): {
  error: { message: string; type: string; code: string };
} {
  const type =
    error.status === 400 ? 'invalid_request_error'
    : error.status === 404 ? 'not_found_error'
    : error.status === 429 ? 'rate_limit_error'
    : error.status >= 500 ? 'server_error'
    : 'api_error';
  return { error: { message: error.message, type, code: error.code } };
}

/**
 * The outbox's plain errors, mapped to statuses (control-actions.ts:98-109,
 * re-expressed for OpenAI). Returns null for an error the caller must not
 * have hit (it is rethrown and surfaces as a generic 502).
 */
export function mapRefusal(error: unknown): GatewayErrorData | null {
  const message = error instanceof Error ? error.message : '';
  if (message === 'The app is shutting down') return refusal('shutting_down', message);
  if (message === 'Input cancelled') return refusal('cancelled', message);
  if (message.startsWith('One message is already awaiting delivery')) {
    return refusal('busy', 'another message for this chat is still awaiting delivery', 5);
  }
  if (message === 'Message id already belongs to different input') {
    return refusal('id_conflict', 'this id belongs to a different message');
  }
  if (message === 'Unblock this conversation before sending') return refusal('chat_blocked', message);
  if (message === 'This recording has no ChatGPT conversation') return refusal('no_chat', message);
  if (message === 'The message queue is full') return refusal('queue_full', message);
  return null;
}

function refusal(code: GatewayErrorCode, message?: string, retryAfterSeconds?: number): GatewayErrorData {
  return gatewayError(code, message, retryAfterSeconds);
}

/** A `chat_error` session event: retryable when ChatGPT gave a deadline. */
export function mapChatError(event: {
  message?: { text?: string };
  retryAt?: number;
  recoverable?: boolean;
}, now: number): GatewayErrorData {
  const message = event.message?.text ?? 'the chat reported an error';
  if (event.retryAt !== undefined && event.retryAt > now) {
    // With a deadline it is a retryable 429 carrying Retry-After.
    const [retryStatus] = GATEWAY_ERRORS.chat_error.status as readonly [number, number];
    return new GatewayError(retryStatus, 'chat_error', message,
      Math.max(1, Math.ceil((event.retryAt - now) / 1000)));
  }
  // Without a deadline it is a hard 502 (a chat_error with no Retry-After is
  // not retryable). The status is the ledger's second value for chat_error.
  const [, hardStatus] = GATEWAY_ERRORS.chat_error.status as readonly [number, number];
  return new GatewayError(hardStatus, 'chat_error', message);
}

/** A `turn_end` reached before any final assistant message. */
export function mapEndedWithoutAnswer(outcome: string | null | undefined): GatewayErrorData {
  return refusal('turn_ended_without_answer',
    'the turn ended without an answer (outcome: ' + (outcome ?? 'unknown') + ')');
}

/** The input row never got delivered: nothing will ever happen for that turn. */
export function mapUndelivered(rowError: string | null | undefined): GatewayErrorData {
  return refusal('not_delivered', rowError ?? 'the message was not delivered to ChatGPT');
}

/** An answer that only exists after the caller gave up; the turn keeps running. */
export function mapTurnTimeout(seconds: number): GatewayErrorData {
  return refusal('turn_timeout',
    `the turn did not finish within ${seconds}s; it keeps running, retry to re-attach`);
}

/** A second request for a session whose turn is still in flight. */
export function mapSessionBusy(waitSeconds: number): GatewayErrorData {
  return refusal('session_busy', 'one turn is still running for this conversation', waitSeconds);
}

/** Whether an unknown string is one of CoS's reasoning efforts. */
export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && (REASONING_EFFORTS as readonly string[]).includes(value);
}
