/**
 * The gateway state store's schema (SQLite, schema version 1) and the row
 * types the DAO speaks.
 *
 * One row per fact, one owner per row:
 *
 *   conversations  the fold key -> CoS session binding, the consumed turn
 *                  sequence and the sent-user count. `turn_seq` is the
 *                  authority the next turn is planned from.
 *   in_flight      the one turn occupying a conversation's slot. Present
 *                  exactly while the gateway still owes that turn an outcome
 *                  (a 504 timeout or a restart leaves it); absent once the
 *                  outcome is known. This is the re-attach marker, so it is
 *                  its own row instead of a column that could drift.
 *   turns          one row per logical turn, keyed by the stable `turn_id`
 *                  (see store.ts), carrying its sequence, the CoS session,
 *                  CoS's native turn id when an anchor carried one, the
 *                  outcome and the attempt count.
 *   sessions       the CoS session id -> conversation key binding, with the
 *                  first/last time the gateway saw it. Read-only evidence for
 *                  listing (H-045); never a second authority for the slot.
 *   outbox         the delivery/retry state of the CoS outbox row behind a
 *                  turn: attempts, the last error and a reserved retry
 *                  deadline. The CoS outbox itself still owns the row; this
 *                  table only remembers what the gateway asked for.
 *   meta           schema and migration markers (one-shot JSON import, shadow
 *                  recovery).
 *
 * STRICT tables keep a wrong write a loud error instead of a silently
 * coerced value. Every table is created with IF NOT EXISTS so an interrupted
 * first open is safe to repeat.
 */

/** Bumped only with a compatible, additive migration (see store.ts). */
export const SCHEMA_VERSION = 1;

/**
 * Everything the gateway remembers about one conversation. This is the row
 * shape of `conversations` joined with `in_flight`, and the type the turn
 * manager holds in memory (`SessionInfo` is an alias of it), so there is no
 * second mapping to drift.
 */
export interface ConversationState {
  /** The CoS session the fold key maps to; null until the first send lands. */
  sessionId: string | null;
  /** Authored user messages the gateway admitted for this conversation. */
  sentUsers: number;
  /** The stable turn id of the turn still in flight, if any. */
  turnInput: string | null;
  turnStartedAt: number | null;
  /**
   * The per-conversation turn sequence. While a turn is in flight it names
   * that turn (a retry re-derives the same turn id from it); otherwise it is
   * the next sequence to assign. A consumed sequence never comes back.
   */
  turnSeq: number;
}

/** A logical turn's lifecycle. `in_flight` is the only non-terminal state. */
export type TurnState = 'in_flight' | 'answered' | 'failed' | 'timeout' | 'settled';

/**
 * One conversation as the read-only listing reads it: the persisted row plus
 * the in-flight slot and the last write time. Listing never mutates state and
 * never resolves a CoS session; it is the H-043 store's public read shape.
 */
export interface ListedConversation {
  conversationKey: string;
  sessionId: string | null;
  sentUsers: number;
  turnSeq: number;
  /** Epoch milliseconds of the last committed write to the row. */
  updatedAt: number;
  inFlightTurnId: string | null;
  inFlightStartedAt: number | null;
}

/** One turn's position in the `(seq, started_at, turn_id)` listing order. */
export interface TurnCursor {
  seq: number;
  startedAt: number;
  turnId: string;
}

/** One persisted turn row. */
export interface StoredTurn {
  turnId: string;
  conversationKey: string;
  seq: number;
  sessionId: string | null;
  /** CoS's own turn id, once an anchor carried one (never the store's key). */
  nativeTurnId: string | null;
  state: TurnState;
  startedAt: number;
  finishedAt: number | null;
  attempts: number;
  lastError: string | null;
}

/** The delivery state of the CoS outbox row the gateway filed for a turn. */
export type OutboxState = 'queued' | 'sending' | 'sent' | 'timeout' | 'failed' | 'answered';

/** One persisted outbox/retry row. */
export interface StoredOutboxRow {
  inputId: string;
  turnId: string;
  conversationKey: string;
  state: OutboxState;
  attempts: number;
  /**
   * Reserved for a future retry scheduler. The re-attach path retries
   * immediately (it re-plans the same turn id), so it stays null today.
   */
  nextAttemptAt: number | null;
  lastError: string | null;
  updatedAt: number;
}

/** A conversation row as the shadow export / legacy file spells it. */
export interface LegacyConversationRow {
  session_id?: string | null;
  sent_users?: number;
  turn_input?: string | null;
  turn_started?: number | null;
  turn_seq?: number;
}

/** The retired whole-map `state.json` shape: fold key -> conversation row. */
export type LegacyStateMap = Record<string, LegacyConversationRow>;

/** The one-shot JSON import marker (`meta` row `json_import`). */
export interface ImportRecord {
  /** `running` is what an interrupted migration leaves behind. */
  state: 'running' | 'done' | 'failed';
  /** The file the rows came from, or null when there was nothing to import. */
  source: string | null;
  sha256: string | null;
  conversations: number;
  inFlight: number;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
}

export const META_JSON_IMPORT = 'json_import';
export const META_SHADOW_RECOVERY = 'shadow_recovery';

/**
 * Every statement is idempotent. `turns` deliberately has no UNIQUE
 * (conversation_key, seq): a rolled-back-then-reimported store can legitimately
 * show one sequence twice, and a constraint there would turn a replay into a
 * failed send. The turn id is the key; the index only speeds up reads.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS conversations (
  conversation_key TEXT PRIMARY KEY,
  session_id       TEXT,
  sent_users       INTEGER NOT NULL DEFAULT 0,
  turn_seq         INTEGER NOT NULL DEFAULT 0,
  updated_at       INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS sessions (
  session_id       TEXT PRIMARY KEY,
  conversation_key TEXT NOT NULL,
  first_seen_at    INTEGER NOT NULL,
  last_seen_at     INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS turns (
  turn_id          TEXT PRIMARY KEY,
  conversation_key TEXT NOT NULL,
  seq              INTEGER NOT NULL,
  session_id       TEXT,
  native_turn_id   TEXT,
  state            TEXT NOT NULL,
  started_at       INTEGER NOT NULL,
  finished_at      INTEGER,
  attempts         INTEGER NOT NULL DEFAULT 1,
  last_error       TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS turns_by_conversation ON turns (conversation_key, seq);

CREATE TABLE IF NOT EXISTS in_flight (
  conversation_key TEXT PRIMARY KEY,
  turn_id          TEXT NOT NULL,
  started_at       INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS outbox (
  input_id         TEXT PRIMARY KEY,
  turn_id          TEXT NOT NULL,
  conversation_key TEXT NOT NULL,
  state            TEXT NOT NULL,
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  INTEGER,
  last_error       TEXT,
  updated_at       INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS outbox_by_turn ON outbox (turn_id);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
`;

/** The domain tables an import replaces, in child-first order. */
export const DOMAIN_TABLES = ['in_flight', 'outbox', 'turns', 'sessions', 'conversations'] as const;
