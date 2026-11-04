/**
 * Read-only conversation and turn listing (platform spec D4 / H-045).
 *
 * This is the STRICTLY ADDITIVE read surface over the H-043 state store: it
 * answers what the gateway already recorded, and nothing more. It never
 * resolves a CoS session, sends a message, opens a browser or mutates state —
 * there is deliberately no browser-action endpoint here.
 *
 * Scope is the same one `POST /v1/chat/completions` uses: a handle-scoped
 * instance publishes only `cos:<handle>:` conversations, and a single-account
 * (legacy) instance publishes only keys with no handle prefix. A conversation
 * from outside the scope is indistinguishable from a missing one, so a listing
 * can never be used to enumerate another account's conversations.
 *
 * Pagination is keyset, never offset:
 *
 *   conversations  ordered by `conversation_key`, the cursor is the last
 *                  published key (exclusive), base64url-encoded so a session
 *                  override with arbitrary characters survives a URL.
 *   turns          ordered by `(seq, started_at, turn_id)`, an opaque composite
 *                  cursor; the total order means a page boundary can never skip
 *                  or repeat a row.
 *
 * A cursor this gateway did not issue is a 400 `invalid_cursor`, never a silent
 * restart from the beginning.
 */
import type { ListedConversation, StoredTurn } from './state/schema.js';
import { gatewayError } from './errors.js';
import { handleOfConversationKey } from './handles.js';
import type { TurnManager } from './turns.js';

/** Default/maximum page sizes; larger is a client error, never clamped. */
export const CONVERSATIONS_DEFAULT_LIMIT = 20;
export const CONVERSATIONS_MAX_LIMIT = 100;
export const TURNS_DEFAULT_LIMIT = 50;
export const TURNS_MAX_LIMIT = 200;

const CONVERSATION_CURSOR_PREFIX = 'c1.';
const TURN_CURSOR_PREFIX = 't1.';

/** One conversation as the public API publishes it (timestamps in seconds). */
export interface ConversationView {
  id: string;
  object: 'conversation';
  session: string | null;
  sent_users: number;
  turn_seq: number;
  updated_at: number;
  in_flight: { turn_id: string; started_at: number } | null;
}

/** One turn as the public API publishes it. */
export interface TurnView {
  id: string;
  object: 'turn';
  conversation: string;
  seq: number;
  session: string | null;
  native_turn_id: string | null;
  state: StoredTurn['state'];
  started_at: number;
  finished_at: number | null;
  attempts: number;
  last_error: string | null;
}

export interface ConversationPage {
  object: 'list';
  data: ConversationView[];
  has_more: boolean;
  next_cursor: string | null;
}

export interface TurnPage {
  object: 'list';
  data: TurnView[];
  has_more: boolean;
  next_cursor: string | null;
}

/**
 * Whether a stored key belongs to this instance's listing scope. `localHandle`
 * is null in single-account mode, where only un-prefixed legacy keys belong.
 */
export function conversationInScope(key: string, localHandle: string | null): boolean {
  const owner = handleOfConversationKey(key);
  return localHandle === null ? owner === null : owner === localHandle;
}

export function encodeConversationCursor(key: string): string {
  return CONVERSATION_CURSOR_PREFIX + Buffer.from(key, 'utf8').toString('base64url');
}

export function decodeConversationCursor(value: string): string {
  if (!value.startsWith(CONVERSATION_CURSOR_PREFIX)) throw gatewayError('invalid_cursor');
  const encoded = value.slice(CONVERSATION_CURSOR_PREFIX.length);
  const decoded = Buffer.from(encoded, 'base64url');
  const key = decoded.toString('utf8');
  // Re-encoding proves the value is the canonical form this gateway issued;
  // Buffer.from tolerates junk that would otherwise decode to a shorter key.
  if (key === '' || Buffer.from(key, 'utf8').toString('base64url') !== encoded) {
    throw gatewayError('invalid_cursor');
  }
  return key;
}

export function encodeTurnCursor(turn: { seq: number; startedAt: number; turnId: string }): string {
  const payload = JSON.stringify([turn.seq, turn.startedAt, turn.turnId]);
  return TURN_CURSOR_PREFIX + Buffer.from(payload, 'utf8').toString('base64url');
}

export function decodeTurnCursor(value: string): { seq: number; startedAt: number; turnId: string } {
  if (!value.startsWith(TURN_CURSOR_PREFIX)) throw gatewayError('invalid_cursor');
  const encoded = value.slice(TURN_CURSOR_PREFIX.length);
  const raw = Buffer.from(encoded, 'base64url');
  if (raw.toString('base64url') !== encoded) throw gatewayError('invalid_cursor');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw gatewayError('invalid_cursor');
  }
  if (!Array.isArray(parsed) || parsed.length !== 3 ||
      typeof parsed[0] !== 'number' || !Number.isSafeInteger(parsed[0]) ||
      typeof parsed[1] !== 'number' || !Number.isFinite(parsed[1]) ||
      typeof parsed[2] !== 'string' || parsed[2] === '') {
    throw gatewayError('invalid_cursor');
  }
  return { seq: parsed[0], startedAt: parsed[1], turnId: parsed[2] };
}

/** A page-size query value: an integer in `1..max`, or a 400 `invalid_body`. */
export function pageLimit(query: URLSearchParams, fallback: number, max: number): number {
  const raw = query.get('limit');
  if (raw === null) return fallback;
  if (!/^[0-9]+$/.test(raw)) {
    throw gatewayError('invalid_body', `limit must be an integer between 1 and ${max}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw gatewayError('invalid_body', `limit must be an integer between 1 and ${max}`);
  }
  return value;
}

export function conversationView(conversation: ListedConversation): ConversationView {
  return {
    id: conversation.conversationKey,
    object: 'conversation',
    session: conversation.sessionId,
    sent_users: conversation.sentUsers,
    turn_seq: conversation.turnSeq,
    updated_at: seconds(conversation.updatedAt),
    in_flight: conversation.inFlightTurnId === null
      ? null
      : {
          turn_id: conversation.inFlightTurnId,
          started_at: seconds(conversation.inFlightStartedAt ?? 0)
        }
  };
}

export function turnView(turn: StoredTurn): TurnView {
  return {
    id: turn.turnId,
    object: 'turn',
    conversation: turn.conversationKey,
    seq: turn.seq,
    session: turn.sessionId,
    native_turn_id: turn.nativeTurnId,
    state: turn.state,
    started_at: seconds(turn.startedAt),
    finished_at: turn.finishedAt === null ? null : seconds(turn.finishedAt),
    attempts: turn.attempts,
    last_error: turn.lastError
  };
}

/** One page of conversations in this instance's scope. */
export function listConversations(
  manager: TurnManager,
  localHandle: string | null,
  query: URLSearchParams,
): ConversationPage {
  const limit = pageLimit(query, CONVERSATIONS_DEFAULT_LIMIT, CONVERSATIONS_MAX_LIMIT);
  const rawCursor = query.get('cursor');
  const after = rawCursor === null ? null : decodeConversationCursor(rawCursor);
  const page = manager.conversationsPage({
    after,
    limit,
    accept: (conversation) => conversationInScope(conversation.conversationKey, localHandle)
  });
  const last = page.conversations[page.conversations.length - 1];
  return {
    object: 'list',
    data: page.conversations.map(conversationView),
    has_more: page.hasMore,
    next_cursor: page.hasMore && last !== undefined ? encodeConversationCursor(last.conversationKey) : null
  };
}

/**
 * One page of a conversation's turns. A conversation outside this instance's
 * scope is a 404: it is never revealed to exist on another account.
 */
export function listTurns(
  manager: TurnManager,
  localHandle: string | null,
  conversationKey: string,
  query: URLSearchParams,
): TurnPage {
  if (!conversationInScope(conversationKey, localHandle) || !manager.hasConversation(conversationKey)) {
    throw gatewayError('not_found', 'no such conversation');
  }
  const limit = pageLimit(query, TURNS_DEFAULT_LIMIT, TURNS_MAX_LIMIT);
  const rawCursor = query.get('cursor');
  const after = rawCursor === null ? null : decodeTurnCursor(rawCursor);
  const page = manager.turnsPage(conversationKey, { after, limit });
  const last = page.turns[page.turns.length - 1];
  return {
    object: 'list',
    data: page.turns.map(turnView),
    has_more: page.hasMore,
    next_cursor: page.hasMore && last !== undefined ? encodeTurnCursor(last) : null
  };
}

/** Store timestamps are epoch milliseconds; the public API publishes seconds. */
function seconds(milliseconds: number): number {
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : 0;
}
