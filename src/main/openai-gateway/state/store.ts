/**
 * Typed gateway state: a DAO over `node:sqlite`, no ORM.
 *
 * ## Spike result (pinned runtime, 2026-11-04)
 *
 * `node:sqlite` was verified against the build this branch actually ships,
 * not against a guess:
 *
 *   Electron 44.3.0 embeds Node 24.20.0 (`ELECTRON_RUN_AS_NODE=1
 *   node_modules/electron/dist/electron -e "process.versions"`), and the
 *   offline gateway suite runs on Node 22 (`.github/workflows/
 *   cos-gateway-tests.yml`). Both expose `node:sqlite` with
 *   `DatabaseSync`, `StatementSync` and the asynchronous `backup()`.
 *
 * Verified on Node 24.20.0 (pinned Electron), Node 22.23.2 (CI) and Node
 * 24.9.0: `PRAGMA journal_mode = WAL` returns `wal` and persists, STRICT
 * tables accept the schema below, `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`
 * behave, `backup(db, target)` produces a readable consistent copy of a live
 * WAL database, and `PRAGMA integrity_check` answers `ok`.
 *
 * Decision: **a hand-written DAO, no ORM and no new dependency.** The whole
 * store is six tables with explicit SQL, so an ORM would add a package, a
 * native-build/electron-rebuild step, a license/notices entry and a second
 * mapping between rows and types — for no query the DAO does not already
 * write by hand. The DAO is the only file in the gateway that imports
 * `node:sqlite`; everything above it speaks the row types in schema.ts.
 *
 * Constraints this file holds itself to:
 *
 *   - positional `?` parameters only (named-parameter binding changed between
 *     Node versions; positional binding has not);
 *   - one prepared-statement cache, so a hot path does not recompile SQL;
 *   - `PRAGMA synchronous = FULL`: a turn marker that survives a 504 or a
 *     restart is the point of this store, so a committed marker is flushed
 *     before the call returns. Write volume is tiny (one small row per turn);
 *   - `node:sqlite` is still flagged experimental upstream. That risk is
 *     contained: the schema is versioned, the DAO is isolated, and
 *     `rollbackToLegacy()` hands the directory back to the JSON build.
 *
 * ## The stable turn key
 *
 * `turn_id` is the gateway's stable identity for one logical turn: the
 * deterministic UUIDv5 `turnInputId(conversation, seq, text, model, effort)`.
 * A retry of the same turn re-derives the same id, so re-attachment after a
 * 504 or a restart is a lookup, not a guess. That id is also the CoS outbox
 * row id the gateway files, which is why `outbox.input_id` equals it. CoS's
 * own (ChatGPT) turn id arrives later, on the `user_message` anchor, and is
 * recorded as `native_turn_id` evidence for the keyed follow (fork `cc5aa19`)
 * — it is never the store's key, because it does not exist when the turn is
 * planned and must not decide which row a retry owns.
 *
 * ## Migration, shadow export, rollback
 *
 *   open      create/migrate the schema, then import the legacy `state.json`
 *             exactly once (marker in `meta`), then recover from the shadow
 *             export if the database holds no conversation at all.
 *   commit    every mutation is one transaction, followed by a rewritten
 *             `state.export.json` (the old file shape, atomically replaced).
 *             The export is therefore never behind the database by more than
 *             one failed write, and it can rebuild an empty store.
 *   backup    `backupTo()` uses SQLite's online backup API; `restore()` retires
 *             the current files and installs the copy, then verifies it.
 *   rollback  `rollbackToLegacy()` writes the projection back to `state.json`
 *             and retires the database files (renamed, never deleted), so the
 *             previous build owns the directory again.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { backup, DatabaseSync, type StatementSync } from 'node:sqlite';
import {
  encodeLegacyState,
  LEGACY_STATE_FILE,
  readLegacyStateFile,
  SHADOW_STATE_FILE,
  writeStateFileAtomic
} from './legacy-json.js';
import {
  DOMAIN_TABLES,
  META_JSON_IMPORT,
  META_SHADOW_RECOVERY,
  SCHEMA_SQL,
  SCHEMA_VERSION,
  type ConversationState,
  type ImportRecord,
  type LegacyConversationRow,
  type LegacyStateMap,
  type ListedConversation,
  type OutboxState,
  type StoredOutboxRow,
  type StoredTurn,
  type TurnCursor,
  type TurnState
} from './schema.js';

export const DB_FILE = 'state.db';

export interface OpenGatewayStateOptions {
  /** The gateway's state directory (CoS: `<userData>/openai-gateway`). */
  dir: string;
  /** Clock for row timestamps; tests pin it. */
  now?: () => number;
  /**
   * Test hook for an interrupted migration: throw after this many imported
   * conversations. The marker transaction has already committed, so the next
   * open sees `running` and retries — exactly what a killed process leaves.
   */
  interruptMigrationAfter?: number;
}

export interface BeginTurnInput {
  turnId: string;
  conversationKey: string;
  seq: number;
  sessionId: string | null;
  startedAt: number;
}

export class GatewayStateStore {
  readonly dir: string;
  readonly dbFile: string;
  readonly legacyFile: string;
  readonly shadowFile: string;

  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly statements = new Map<string, StatementSync>();
  private closed = false;

  private constructor(dir: string, now: () => number) {
    this.dir = dir;
    this.now = now;
    this.dbFile = path.join(dir, DB_FILE);
    this.legacyFile = path.join(dir, LEGACY_STATE_FILE);
    this.shadowFile = path.join(dir, SHADOW_STATE_FILE);
    this.db = new DatabaseSync(this.dbFile);
  }

  /** Open (or create) the store and finish any pending migration. */
  static open(options: OpenGatewayStateOptions): GatewayStateStore {
    mkdirSync(options.dir, { recursive: true });
    const store = new GatewayStateStore(options.dir, options.now ?? Date.now);
    try {
      store.start(options.interruptMigrationAfter);
    } catch (error: unknown) {
      store.close();
      throw error;
    }
    return store;
  }

  /**
   * Install a backup over the current files and open it. The files it
   * replaces are renamed aside (never deleted), so a bad restore is still
   * recoverable from the directory itself.
   */
  static restore(options: { dir: string; backup: string; now?: () => number }): GatewayStateStore {
    mkdirSync(options.dir, { recursive: true });
    const dbFile = path.join(options.dir, DB_FILE);
    const stamp = new Date((options.now ?? Date.now)()).toISOString().replace(/[:.]/g, '-');
    retire(dbFile, `replaced-${stamp}`);
    copyFileSync(options.backup, dbFile);
    const store = new GatewayStateStore(options.dir, options.now ?? Date.now);
    try {
      store.start(undefined);
      store.verifyIntegrity();
    } catch (error: unknown) {
      store.close();
      throw error;
    }
    return store;
  }

  // ------------------------------------------------------------------- open

  private start(interruptMigrationAfter: number | undefined): void {
    this.db.exec('PRAGMA busy_timeout = 5000');
    // WAL lets a read (the shadow export, a future listing route) run beside
    // the writer without blocking it; it also makes the file-level backup a
    // consistent snapshot instead of a torn page copy.
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = FULL');
    this.migrate(interruptMigrationAfter);
    this.exportShadow();
  }

  private migrate(interruptMigrationAfter: number | undefined): void {
    const version = this.userVersion();
    if (version > SCHEMA_VERSION) {
      throw new Error(
        `gateway state store schema ${version} is newer than this build (${SCHEMA_VERSION}); ` +
        'downgrade with rollbackToLegacy() or use the matching build'
      );
    }
    if (version < SCHEMA_VERSION) {
      this.transaction(() => {
        this.db.exec(SCHEMA_SQL);
        this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      });
    }
    this.importLegacyOnce(interruptMigrationAfter);
    // A database with no conversation and an export on disk means the
    // database was lost (or replaced by an empty one): rebuild it. The export
    // is in the legacy shape, so it is imported by the same routine.
    if (this.count('conversations') === 0) {
      this.importStateFile(META_SHADOW_RECOVERY, this.shadowFile, undefined);
    }
  }

  private userVersion(): number {
    const row = this.stmt('PRAGMA user_version').get() as { user_version?: unknown } | undefined;
    const value = row?.user_version;
    return typeof value === 'number' ? value : Number(value ?? 0);
  }

  private verifyIntegrity(): void {
    const row = this.stmt('PRAGMA integrity_check').get() as { integrity_check?: unknown } | undefined;
    const verdict = row?.integrity_check;
    if (verdict !== 'ok') {
      throw new Error(`gateway state store failed its integrity check: ${String(verdict)}`);
    }
    if (this.userVersion() > SCHEMA_VERSION) {
      throw new Error('the restored store was written by a newer schema version');
    }
  }

  // -------------------------------------------------------------- migration

  private importLegacyOnce(interruptMigrationAfter: number | undefined): void {
    this.importStateFile(META_JSON_IMPORT, this.legacyFile, interruptMigrationAfter);
  }

  /**
   * One-shot import of a state file, in two phases:
   *
   *   1. its own committed transaction writes the `running` marker, so a
   *      process killed during phase 2 leaves evidence;
   *   2. one transaction clears the domain tables and writes every imported
   *      row together with the `done` marker.
   *
   * An open that finds `running` (or `failed`) therefore retries: phase 2
   * starts by clearing the tables, so a half-imported store cannot survive.
   * A `done` marker is final — a later edit to the source file is ignored.
   */
  private importStateFile(
    markerKey: string,
    file: string,
    interruptMigrationAfter: number | undefined
  ): void {
    if (this.importRecord(markerKey)?.state === 'done') return;
    const read = readLegacyStateFile(file);
    if (read.bytes === null) {
      // Nothing to import. Record it for the legacy marker (so the one-shot
      // is visibly complete); the shadow recovery stays unmarked so a later
      // export can still rebuild a lost store.
      if (markerKey === META_JSON_IMPORT) {
        this.writeImportRecord(markerKey, {
          state: 'done', source: null, sha256: null, conversations: 0, inFlight: 0,
          startedAt: this.now(), finishedAt: this.now(), error: null
        });
      }
      return;
    }
    const source = path.basename(file);
    const sha256 = createHash('sha256').update(read.bytes, 'utf8').digest('hex');
    const startedAt = this.now();
    if (read.error !== null) {
      // Availability first: a damaged file must not stop the gateway from
      // starting. The marker says `failed`, so a corrected file is retried on
      // the next open instead of being silently ignored forever.
      this.writeImportRecord(markerKey, {
        state: 'failed', source, sha256, conversations: 0, inFlight: 0,
        startedAt, finishedAt: this.now(), error: read.error
      });
      return;
    }
    this.writeImportRecord(markerKey, {
      state: 'running', source, sha256, conversations: 0, inFlight: 0,
      startedAt, finishedAt: null, error: null
    });
    const entries = Object.entries(read.map);
    this.transaction(() => {
      for (const table of DOMAIN_TABLES) this.db.exec(`DELETE FROM ${table}`);
      let conversations = 0;
      let inFlight = 0;
      for (const [key, row] of entries) {
        const state = conversationFromLegacy(row);
        this.writeConversation(key, state);
        if (state.turnInput !== null) {
          this.writeImportedTurn(key, state);
          inFlight += 1;
        }
        conversations += 1;
        if (interruptMigrationAfter !== undefined && conversations >= interruptMigrationAfter) {
          throw new Error('simulated interruption while importing the legacy state');
        }
      }
      this.writeImportRecord(markerKey, {
        state: 'done', source, sha256, conversations, inFlight,
        startedAt, finishedAt: this.now(), error: null
      });
    });
  }

  /** The import marker, or null when this marker was never written. */
  importRecord(markerKey: string = META_JSON_IMPORT): ImportRecord | null {
    const raw = this.metaValue(markerKey);
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<ImportRecord>;
      return {
        state: parsed.state === 'done' || parsed.state === 'failed' ? parsed.state : 'running',
        source: typeof parsed.source === 'string' ? parsed.source : null,
        sha256: typeof parsed.sha256 === 'string' ? parsed.sha256 : null,
        conversations: typeof parsed.conversations === 'number' ? parsed.conversations : 0,
        inFlight: typeof parsed.inFlight === 'number' ? parsed.inFlight : 0,
        startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : 0,
        finishedAt: typeof parsed.finishedAt === 'number' ? parsed.finishedAt : null,
        error: typeof parsed.error === 'string' ? parsed.error : null
      };
    } catch {
      return null;
    }
  }

  private writeImportRecord(markerKey: string, record: ImportRecord): void {
    this.stmt(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(markerKey, JSON.stringify(record));
  }

  private metaValue(key: string): string | null {
    const row = this.stmt('SELECT value FROM meta WHERE key = ?').get(key) as
      { value?: unknown } | undefined;
    return typeof row?.value === 'string' ? row.value : null;
  }

  // ----------------------------------------------------------- conversations

  /** Every conversation the store knows, with its in-flight slot resolved. */
  loadConversations(): Map<string, ConversationState> {
    const rows = this.stmt(CONVERSATION_SELECT).all() as unknown as RawConversationRow[];
    const states = new Map<string, ConversationState>();
    for (const row of rows) {
      const key = row.conversation_key;
      if (typeof key !== 'string') continue;
      states.set(key, conversationFromRow(row));
    }
    return states;
  }

  /**
   * Persist one conversation: its binding, its consumed sequence and its
   * in-flight slot, in one transaction. Another conversation's row is never
   * touched, so a concurrent conversation cannot be dropped (the reason the
   * JSON store rewrote the whole map).
   */
  saveConversation(key: string, state: ConversationState): void {
    this.transaction(() => this.writeConversation(key, state));
    this.exportShadow();
  }

  /** Persist several conversations in one transaction (a full flush). */
  saveAll(states: ReadonlyMap<string, ConversationState>): void {
    if (states.size === 0) return;
    this.transaction(() => {
      for (const [key, state] of states) this.writeConversation(key, state);
    });
    this.exportShadow();
  }

  private writeConversation(key: string, state: ConversationState): void {
    const at = this.now();
    this.stmt(
      `INSERT INTO conversations (conversation_key, session_id, sent_users, turn_seq, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(conversation_key) DO UPDATE SET
         session_id = excluded.session_id,
         sent_users = excluded.sent_users,
         turn_seq   = excluded.turn_seq,
         updated_at = excluded.updated_at`
    ).run(key, state.sessionId, state.sentUsers, state.turnSeq, at);
    this.syncInFlight(key, state);
    this.syncSession(key, state, at);
  }

  /** The slot is one fact: present exactly while a turn is still owed. */
  private syncInFlight(key: string, state: ConversationState): void {
    if (state.turnInput === null) {
      this.stmt('DELETE FROM in_flight WHERE conversation_key = ?').run(key);
      return;
    }
    this.stmt(
      `INSERT INTO in_flight (conversation_key, turn_id, started_at) VALUES (?, ?, ?)
       ON CONFLICT(conversation_key) DO UPDATE SET
         turn_id = excluded.turn_id,
         started_at = excluded.started_at`
    ).run(key, state.turnInput, state.turnStartedAt ?? 0);
  }

  private syncSession(key: string, state: ConversationState, at: number): void {
    if (state.sessionId === null) return;
    this.stmt(
      `INSERT INTO sessions (session_id, conversation_key, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         conversation_key = excluded.conversation_key,
         last_seen_at = excluded.last_seen_at`
    ).run(state.sessionId, key, at, at);
  }

  private writeImportedTurn(key: string, state: ConversationState): void {
    if (state.turnInput === null) return;
    this.stmt(
      `INSERT INTO turns
         (turn_id, conversation_key, seq, session_id, native_turn_id, state, started_at, finished_at, attempts, last_error)
       VALUES (?, ?, ?, ?, NULL, 'in_flight', ?, NULL, 1, NULL)
       ON CONFLICT(turn_id) DO UPDATE SET
         state = 'in_flight',
         session_id = excluded.session_id,
         started_at = excluded.started_at,
         finished_at = NULL`
    ).run(
      state.turnInput,
      key,
      state.turnSeq,
      state.sessionId,
      state.turnStartedAt ?? this.now()
    );
  }

  // ------------------------------------------------------------------- turns

  /** A turn was admitted to the outbox: record it and occupy the slot. */
  beginTurn(input: BeginTurnInput): void {
    this.transaction(() => {
      this.stmt(
        `INSERT INTO turns
           (turn_id, conversation_key, seq, session_id, native_turn_id, state, started_at, finished_at, attempts, last_error)
         VALUES (?, ?, ?, ?, NULL, 'in_flight', ?, NULL, 1, NULL)
         ON CONFLICT(turn_id) DO UPDATE SET
           state = 'in_flight',
           session_id = excluded.session_id,
           started_at = excluded.started_at,
           finished_at = NULL,
           attempts = attempts + 1`
      ).run(input.turnId, input.conversationKey, input.seq, input.sessionId, input.startedAt);
      this.upsertOutbox({
        inputId: input.turnId,
        turnId: input.turnId,
        conversationKey: input.conversationKey,
        state: 'sent',
        attempts: 1,
        nextAttemptAt: null,
        lastError: null
      });
    });
    this.exportShadow();
  }

  /** A retry rode the existing outbox row instead of sending again. */
  noteTurnAttempt(turnId: string): void {
    this.transaction(() => {
      this.stmt('UPDATE turns SET attempts = attempts + 1 WHERE turn_id = ?').run(turnId);
      this.stmt(
        `UPDATE outbox SET attempts = attempts + 1, state = 'sending', updated_at = ? WHERE input_id = ?`
      ).run(this.now(), turnId);
    });
    this.exportShadow();
  }

  /** CoS's own turn id, once the anchor carried one (evidence, not the key). */
  recordNativeTurnId(turnId: string, nativeTurnId: string): void {
    this.stmt('UPDATE turns SET native_turn_id = ? WHERE turn_id = ?').run(nativeTurnId, turnId);
  }

  /** Record a terminal outcome for a turn and mirror it into the outbox row. */
  recordTurnOutcome(
    turnId: string,
    outcome: Exclude<TurnState, 'in_flight'>,
    detail: { error?: string | null } = {}
  ): void {
    const error = detail.error ?? null;
    const at = this.now();
    this.transaction(() => {
      this.stmt(
        `UPDATE turns SET state = ?, finished_at = ?, last_error = COALESCE(?, last_error) WHERE turn_id = ?`
      ).run(outcome, at, error, turnId);
      // A stopped turn is the outbox's `cancelled`: called back, never sent.
      const outboxState: OutboxState = outcome === 'timeout' ? 'timeout'
        : outcome === 'failed' ? 'failed'
        : outcome === 'stopped' ? 'cancelled'
        : 'answered';
      this.stmt(
        `UPDATE outbox SET state = ?, last_error = COALESCE(?, last_error), updated_at = ? WHERE input_id = ?`
      ).run(outboxState, error, at, turnId);
    });
    this.exportShadow();
  }

  turn(turnId: string): StoredTurn | null {
    const row = this.stmt('SELECT * FROM turns WHERE turn_id = ?').get(turnId) as
      RawTurnRow | undefined;
    return row === undefined ? null : turnFromRow(row);
  }

  turnsFor(conversationKey: string): StoredTurn[] {
    const rows = this.stmt(
      'SELECT * FROM turns WHERE conversation_key = ? ORDER BY seq, started_at'
    ).all(conversationKey) as unknown as RawTurnRow[];
    return rows.map(turnFromRow);
  }

  /** The conversation's slot row, or null when no turn is owed. */
  inFlight(conversationKey: string): { turnId: string; startedAt: number } | null {
    const row = this.stmt('SELECT turn_id, started_at FROM in_flight WHERE conversation_key = ?').get(
      conversationKey
    ) as { turn_id?: unknown; started_at?: unknown } | undefined;
    if (typeof row?.turn_id !== 'string') return null;
    return { turnId: row.turn_id, startedAt: typeof row.started_at === 'number' ? row.started_at : 0 };
  }

  outboxRow(inputId: string): StoredOutboxRow | null {
    const row = this.stmt('SELECT * FROM outbox WHERE input_id = ?').get(inputId) as
      RawOutboxRow | undefined;
    return row === undefined ? null : outboxFromRow(row);
  }

  outboxRows(): StoredOutboxRow[] {
    const rows = this.stmt('SELECT * FROM outbox ORDER BY updated_at, input_id').all() as unknown as
      RawOutboxRow[];
    return rows.map(outboxFromRow);
  }

  private upsertOutbox(input: {
    inputId: string;
    turnId: string;
    conversationKey: string;
    state: OutboxState;
    attempts: number;
    nextAttemptAt: number | null;
    lastError: string | null;
  }): void {
    this.stmt(
      `INSERT INTO outbox
         (input_id, turn_id, conversation_key, state, attempts, next_attempt_at, last_error, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(input_id) DO UPDATE SET
         state = excluded.state,
         attempts = MAX(outbox.attempts, excluded.attempts),
         next_attempt_at = excluded.next_attempt_at,
         last_error = COALESCE(excluded.last_error, outbox.last_error),
         updated_at = excluded.updated_at`
    ).run(
      input.inputId, input.turnId, input.conversationKey, input.state,
      input.attempts, input.nextAttemptAt, input.lastError, this.now()
    );
  }

  // ------------------------------------------------------------ public reads

  /**
   * One page of conversations in `conversation_key` order, after `after`
   * (exclusive). Rows are scanned in bounded chunks and filtered by `accept`,
   * so a handle-scoped listing never materializes the whole table, and an
   * empty chunk can never end the scan while a later chunk still matches.
   *
   * Read-only: no write and no shadow export. `hasMore` is true only when an
   * accepted row exists past the returned page, which is exactly the case the
   * exclusive cursor can continue from.
   */
  conversationsPage(options: {
    after?: string | null;
    limit: number;
    accept?: (conversation: ListedConversation) => boolean;
  }): { conversations: ListedConversation[]; hasMore: boolean } {
    this.assertOpen();
    const accept = options.accept ?? (() => true);
    const limit = Math.max(1, options.limit);
    const conversations: ListedConversation[] = [];
    let after = options.after ?? null;
    for (;;) {
      const rows = (after === null
        ? this.stmt(LISTING_FIRST_SELECT).all(LISTING_CHUNK)
        : this.stmt(LISTING_AFTER_SELECT).all(after, LISTING_CHUNK)) as unknown as RawConversationRow[];
      if (rows.length === 0) break;
      for (const row of rows) {
        const conversation = listedFromRow(row);
        if (conversation === null) continue;
        after = conversation.conversationKey;
        if (!accept(conversation)) continue;
        if (conversations.length === limit) return { conversations, hasMore: true };
        conversations.push(conversation);
      }
      if (rows.length < LISTING_CHUNK) break;
    }
    return { conversations, hasMore: false };
  }

  /** Whether a conversation row exists, without reading its state. */
  hasConversation(conversationKey: string): boolean {
    this.assertOpen();
    return this.stmt('SELECT 1 AS present FROM conversations WHERE conversation_key = ?')
      .get(conversationKey) !== undefined;
  }

  /**
   * One page of a conversation's turns in `(seq, started_at, turn_id)` order,
   * after `after` (exclusive). The composite cursor is a total order, so a
   * page boundary can never skip or repeat a row even when two turns share a
   * sequence. Read-only.
   */
  turnsPage(
    conversationKey: string,
    options: { after?: TurnCursor | null; limit: number },
  ): { turns: StoredTurn[]; hasMore: boolean } {
    this.assertOpen();
    const limit = Math.max(1, options.limit);
    const after = options.after ?? null;
    const rows = (after === null
      ? this.stmt(TURN_PAGE_FIRST_SELECT).all(conversationKey, limit + 1)
      : this.stmt(TURN_PAGE_AFTER_SELECT).all(
          conversationKey,
          after.seq, after.seq, after.startedAt,
          after.seq, after.startedAt, after.turnId,
          limit + 1
        )) as unknown as RawTurnRow[];
    const turns = rows.map(turnFromRow);
    return { turns: turns.slice(0, limit), hasMore: turns.length > limit };
  }

  // ---------------------------------------------------------------- sessions

  /** The conversation a CoS session belongs to, or null when unseen. */
  conversationForSession(sessionId: string): string | null {
    const row = this.stmt('SELECT conversation_key FROM sessions WHERE session_id = ?').get(sessionId) as
      { conversation_key?: unknown } | undefined;
    return typeof row?.conversation_key === 'string' ? row.conversation_key : null;
  }

  // ----------------------------------------------------------- shadow export

  /** The database projected into the retired whole-map shape. */
  shadowProjection(): LegacyStateMap {
    const rows = this.stmt(CONVERSATION_SELECT).all() as unknown as RawConversationRow[];
    const map: LegacyStateMap = {};
    for (const row of rows) {
      const key = row.conversation_key;
      if (typeof key !== 'string') continue;
      const state = conversationFromRow(row);
      map[key] = {
        session_id: state.sessionId,
        sent_users: state.sentUsers,
        turn_input: state.turnInput,
        turn_started: state.turnStartedAt,
        turn_seq: state.turnSeq
      };
    }
    return map;
  }

  /** Rewrite `state.export.json` from the committed rows. */
  exportShadow(): void {
    writeStateFileAtomic(this.shadowFile, encodeLegacyState(this.shadowProjection()));
  }

  /** Read the export as it sits on disk (what a downgrade would consume). */
  readShadow(): LegacyStateMap {
    return readLegacyStateFile(this.shadowFile).map;
  }

  // --------------------------------------------------- backup / rollback

  /** A consistent copy of the live database (SQLite's online backup API). */
  async backupTo(target: string): Promise<void> {
    mkdirSync(path.dirname(target), { recursive: true });
    await backup(this.db, target);
  }

  /**
   * Hand the directory back to the JSON build: write the projection to
   * `state.json`, close, and rename the database files aside. A later open of
   * this build imports that `state.json` again (the marker lived in the
   * retired database), so the round trip is lossless.
   */
  rollbackToLegacy(): void {
    const map = this.shadowProjection();
    writeStateFileAtomic(this.legacyFile, encodeLegacyState(map));
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-');
    this.close();
    for (const file of [this.dbFile, `${this.dbFile}-wal`, `${this.dbFile}-shm`]) {
      retire(file, `rolled-back-${stamp}`);
    }
  }

  // ------------------------------------------------------------------ close

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
    this.db.close();
  }

  // ---------------------------------------------------------------- helpers

  private count(table: (typeof DOMAIN_TABLES)[number]): number {
    const row = this.stmt(`SELECT count(*) AS c FROM ${table}`).get() as { c?: unknown } | undefined;
    return typeof row?.c === 'number' ? row.c : Number(row?.c ?? 0);
  }

  private transaction(run: () => void): void {
    this.assertOpen();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      run();
      this.db.exec('COMMIT');
    } catch (error: unknown) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // The transaction is already gone (a failed BEGIN or a closed handle);
        // the original error is the one worth reporting.
      }
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('the gateway state store is closed');
  }

  private stmt(sql: string): StatementSync {
    const cached = this.statements.get(sql);
    if (cached !== undefined) return cached;
    const prepared = this.db.prepare(sql);
    this.statements.set(sql, prepared);
    return prepared;
  }
}

/** Retire a file by renaming it beside itself; nothing is ever deleted. */
function retire(file: string, suffix: string): void {
  if (!existsSync(file)) return;
  renameSync(file, `${file}.${suffix}`);
}

/** conversations LEFT JOIN in_flight: the slot is resolved in the same read. */
const CONVERSATION_SELECT = `
SELECT c.conversation_key, c.session_id, c.sent_users, c.turn_seq, c.updated_at,
       f.turn_id AS in_flight_turn, f.started_at AS in_flight_started
FROM conversations c
LEFT JOIN in_flight f ON f.conversation_key = c.conversation_key
ORDER BY c.conversation_key
`;

/**
 * The read-only listing projection. Same join as CONVERSATION_SELECT, but the
 * budget comes from LIMIT so a page is bounded before any filtering happens.
 */
const LISTING_SELECT = `
SELECT c.conversation_key, c.session_id, c.sent_users, c.turn_seq, c.updated_at,
       f.turn_id AS in_flight_turn, f.started_at AS in_flight_started
FROM conversations c
LEFT JOIN in_flight f ON f.conversation_key = c.conversation_key
`;

const LISTING_FIRST_SELECT = `${LISTING_SELECT}
ORDER BY c.conversation_key
LIMIT ?
`;

const LISTING_AFTER_SELECT = `${LISTING_SELECT}
WHERE c.conversation_key > ?
ORDER BY c.conversation_key
LIMIT ?
`;

/** Rows read per scan chunk; a page may have to cross several to fill up. */
const LISTING_CHUNK = 200;

const TURN_PAGE_FIRST_SELECT = `
SELECT * FROM turns
WHERE conversation_key = ?
ORDER BY seq, started_at, turn_id
LIMIT ?
`;

const TURN_PAGE_AFTER_SELECT = `
SELECT * FROM turns
WHERE conversation_key = ?
  AND (seq > ? OR (seq = ? AND started_at > ?) OR (seq = ? AND started_at = ? AND turn_id > ?))
ORDER BY seq, started_at, turn_id
LIMIT ?
`;

interface RawConversationRow {
  conversation_key?: unknown;
  session_id?: unknown;
  sent_users?: unknown;
  turn_seq?: unknown;
  updated_at?: unknown;
  in_flight_turn?: unknown;
  in_flight_started?: unknown;
}

interface RawTurnRow {
  turn_id?: unknown;
  conversation_key?: unknown;
  seq?: unknown;
  session_id?: unknown;
  native_turn_id?: unknown;
  state?: unknown;
  started_at?: unknown;
  finished_at?: unknown;
  attempts?: unknown;
  last_error?: unknown;
}

interface RawOutboxRow {
  input_id?: unknown;
  turn_id?: unknown;
  conversation_key?: unknown;
  state?: unknown;
  attempts?: unknown;
  next_attempt_at?: unknown;
  last_error?: unknown;
  updated_at?: unknown;
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function integer(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function conversationFromRow(row: RawConversationRow): ConversationState {
  return {
    sessionId: text(row.session_id),
    sentUsers: integer(row.sent_users, 0),
    turnInput: text(row.in_flight_turn),
    turnStartedAt: row.in_flight_turn === null || row.in_flight_turn === undefined
      ? null
      : integer(row.in_flight_started, 0),
    turnSeq: integer(row.turn_seq, 0)
  };
}

function listedFromRow(row: RawConversationRow): ListedConversation | null {
  const conversationKey = text(row.conversation_key);
  if (conversationKey === null) return null;
  return {
    conversationKey,
    sessionId: text(row.session_id),
    sentUsers: integer(row.sent_users, 0),
    turnSeq: integer(row.turn_seq, 0),
    updatedAt: integer(row.updated_at, 0),
    inFlightTurnId: text(row.in_flight_turn),
    inFlightStartedAt: row.in_flight_turn === null || row.in_flight_turn === undefined
      ? null
      : integer(row.in_flight_started, 0)
  };
}

/** The retired loader's tolerance, kept so an import matches what it read. */
function conversationFromLegacy(row: LegacyConversationRow): ConversationState {
  return {
    sessionId: typeof row.session_id === 'string' ? row.session_id : null,
    sentUsers: typeof row.sent_users === 'number' ? row.sent_users : 0,
    turnInput: typeof row.turn_input === 'string' ? row.turn_input : null,
    turnStartedAt: typeof row.turn_started === 'number' ? row.turn_started : null,
    turnSeq: typeof row.turn_seq === 'number' ? row.turn_seq : 0
  };
}

function turnFromRow(row: RawTurnRow): StoredTurn {
  const state = row.state;
  return {
    turnId: text(row.turn_id) ?? '',
    conversationKey: text(row.conversation_key) ?? '',
    seq: integer(row.seq, 0),
    sessionId: text(row.session_id),
    nativeTurnId: text(row.native_turn_id),
    state: state === 'answered' || state === 'failed' || state === 'timeout' || state === 'settled' ||
      state === 'stopped'
      ? state
      : 'in_flight',
    startedAt: integer(row.started_at, 0),
    finishedAt: typeof row.finished_at === 'number' ? row.finished_at : null,
    attempts: integer(row.attempts, 0),
    lastError: text(row.last_error)
  };
}

function outboxFromRow(row: RawOutboxRow): StoredOutboxRow {
  const state = row.state;
  return {
    inputId: text(row.input_id) ?? '',
    turnId: text(row.turn_id) ?? '',
    conversationKey: text(row.conversation_key) ?? '',
    state: state === 'queued' || state === 'sending' || state === 'sent' ||
      state === 'timeout' || state === 'failed' || state === 'answered' || state === 'cancelled'
      ? state
      : 'queued',
    attempts: integer(row.attempts, 0),
    nextAttemptAt: typeof row.next_attempt_at === 'number' ? row.next_attempt_at : null,
    lastError: text(row.last_error),
    updatedAt: integer(row.updated_at, 0)
  };
}
