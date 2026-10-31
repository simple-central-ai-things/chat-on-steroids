/**
 * Failure semantics — the error/status contract SCPM's failover relies on.
 *
 * CoS's outbox throws plain errors; control-actions.ts refusal() is the
 * reference for which literals are actionable (control-actions.ts:98-109).
 * This mapping re-expresses them as OpenAI-style errors for the gateway:
 *
 *   400  invalid OpenAI body, unknown model, unavailable effort
 *   409  id_conflict (a retry with a changed payload)
 *   429  busy / would_interrupt / session busy (Retry-After always set),
 *        chat_error with retryAt (Retry-After from the deadline)
 *   502  the upstream chat is unusable (no_chat, chat_blocked), a turn that
 *        ended without an answer, an input row that never got delivered
 *   503  CoS itself unavailable: shutting_down, queue_full, models_unknown,
 *        or the catalog not ready
 *   504  the turn did not finish in TURN_TIMEOUT_SECONDS; it keeps running
 *        and a later request re-attaches to it by input id
 */
import { REASONING_EFFORTS, type ReasoningEffort } from './catalog.js';

/** A gateway failure with its OpenAI-style status and machine-readable code. */
export interface GatewayErrorData {
  status: number;
  code: string;
  message: string;
  retryAfterSeconds?: number;
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
  if (message === 'The app is shutting down') return refusal(503, 'shutting_down', message);
  if (message === 'Input cancelled') return refusal(409, 'cancelled', message);
  if (message.startsWith('One message is already awaiting delivery')) {
    return refusal(429, 'busy', 'another message for this chat is still awaiting delivery', 5);
  }
  if (message === 'Message id already belongs to different input') {
    return refusal(409, 'id_conflict', 'this id belongs to a different message');
  }
  if (message === 'Unblock this conversation before sending') return refusal(502, 'chat_blocked', message);
  if (message === 'This recording has no ChatGPT conversation') return refusal(502, 'no_chat', message);
  if (message === 'The message queue is full') return refusal(503, 'queue_full', message);
  return null;
}

function refusal(status: number, code: string, message: string, retryAfterSeconds?: number): GatewayErrorData {
  return { status, code, message, retryAfterSeconds };
}

/** A `chat_error` session event: retryable when ChatGPT gave a deadline. */
export function mapChatError(event: {
  message?: { text?: string };
  retryAt?: number;
  recoverable?: boolean;
}, now: number): GatewayErrorData {
  const message = event.message?.text ?? 'the chat reported an error';
  if (event.retryAt !== undefined && event.retryAt > now) {
    return refusal(429, 'chat_error', message, Math.max(1, Math.ceil((event.retryAt - now) / 1000)));
  }
  return refusal(502, 'chat_error', message);
}

/** A `turn_end` reached before any final assistant message. */
export function mapEndedWithoutAnswer(outcome: string | null | undefined): GatewayErrorData {
  return refusal(502, 'turn_ended_without_answer',
    'the turn ended without an answer (outcome: ' + (outcome ?? 'unknown') + ')');
}

/** The input row never got delivered: nothing will ever happen for that turn. */
export function mapUndelivered(rowError: string | null | undefined): GatewayErrorData {
  return refusal(502, 'not_delivered', rowError ?? 'the message was not delivered to ChatGPT');
}

/** An answer that only exists after the caller gave up; the turn keeps running. */
export function mapTurnTimeout(seconds: number): GatewayErrorData {
  return refusal(504, 'turn_timeout',
    `the turn did not finish within ${seconds}s; it keeps running, retry to re-attach`);
}

/** A second request for a session whose turn is still in flight. */
export function mapSessionBusy(waitSeconds: number): GatewayErrorData {
  return refusal(429, 'session_busy', 'one turn is still running for this conversation', waitSeconds);
}

/** Whether an unknown string is one of CoS's reasoning efforts. */
export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && (REASONING_EFFORTS as readonly string[]).includes(value);
}
