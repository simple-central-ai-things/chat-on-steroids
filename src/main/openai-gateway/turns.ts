/**
 * Conversation mapping and turn orchestration over the CoS internals.
 *
 * A stable conversation key (fold.conversationKey) maps to a CoS session id.
 * There is one in-flight turn per gateway session: a second request for a
 * busy session queues behind it and gets 429 + Retry-After when it cannot
 * wait. The outbox input id is derived (uuid5) from conversation key + a
 * per-conversation turn sequence number + turn text + model + effort, so a
 * retry of the same logical turn never double-sends (CoS's outbox replays
 * the row) while two legitimate identical messages in one conversation get
 * distinct turns. The sequence is assigned once when the turn is planned
 * and persisted with the in-flight marker; only finishTurn consumes it.
 *
 * The mapping survives an app restart: it is kept as a whole JSON state map
 * under CoS's userData (every persist writes ALL conversations atomically),
 * and an in-flight turn persisted there is re-attached on the next request
 * (re-plan by input id, events after the anchor) instead of opening a fresh
 * chat or sending the message twice. The in-flight marker is cleared only
 * after the turn's outcome is known — a 504 timeout keeps it so the retry
 * re-attaches to the running turn.
 *
 * All CoS-internal calls arrive through the `CosInternals` interface, so
 * node:test exercises this module with stubs and no Electron process.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { foldDelta, foldFirst, FoldError, type NormalizedMessage } from './fold.js';
import {
  mapChatError,
  mapEndedWithoutAnswer,
  mapRefusal,
  mapSessionBusy,
  mapUndelivered,
  type GatewayErrorData,
  GatewayError
} from './errors.js';
import type { ChatModelCatalog, ReasoningEffort } from './catalog.js';

/** The InputArgs fields the gateway sets (src/main/session/input.ts inputArgs). */
export interface CosInputArgs {
  id: string;
  sessionId: string | null;
  text: string;
  mode: 'auto';
  dueAt: number;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  authoredSource: 'text';
}

/** The outbox row fields the gateway reads (entrySchema subset). */
export interface CosInputRow {
  id: string;
  sessionId: string | null;
  state: 'queued' | 'browser' | 'tool' | 'sent' | 'cancelled' | 'failed' | 'decision';
  text: string;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  directTurn?: { id: string; startedAt: number } | null;
  error?: string;
}

/** sessionInputPolicy result, as far as the gateway cares (input.ts:239). */
export interface CosPolicy {
  directTurn?: { id: string; startedAt: number } | null;
}

/** A session event row, as far as the gateway cares (shared/session.ts SessionEvent). */
export interface CosEvent {
  seq: number;
  kind: string;
  inputId?: string;
  /** ChatGPT's own turn id when the extension could read it (BaseEvent.turnId). */
  turnId?: string;
  final?: boolean;
  message?: { text?: string };
  retryAt?: number;
  recoverable?: boolean;
  outcome?: string;
}

export interface CosEventsPage {
  events: readonly CosEvent[];
  /** Exclusive cursor for the next read (read-model.ts readSessionEvents). */
  nextFrom: number;
}

/**
 * The CoS internals the gateway calls in-process. createCosInternals() in
 * internals.ts implements this against the real exports; tests inject stubs.
 */
export interface CosInternals {
  /** src/main/session/start-input.ts:76 — durable admission, not delivery. */
  sendDesktopInput(input: CosInputArgs): Promise<CosInputRow>;
  /** start-input.ts:58 — withdraw a row that was not handed over. */
  cancelInput(id: string): Promise<boolean>;
  /** src/main/session/input.ts:1099 — the durable outbox rows. */
  listInputs(): Promise<CosInputRow[]>;
  /** input.ts:239 — the composer/admission delivery policy. */
  sessionInputPolicy(sessionId: string): Promise<CosPolicy>;
  /** src/main/session/read-model.ts:35 — null when CoS has no such session. */
  readSession(sessionId: string): Promise<unknown | null>;
  /** read-model.ts:85 — events from a publication cursor. */
  readSessionEvents(
    sessionId: string,
    options: { from: number; kinds: readonly string[]; limit?: number },
  ): Promise<CosEventsPage | null>;
  /** src/main/session/recorder.ts:176 — wakeups, not a substitute for reads. */
  onSessionChange(listener: (change: { sessionIds: readonly string[] }) => void): () => void;
  /** src/main/chat-models.ts:69 — the picker catalog. */
  getChatModels(): ChatModelCatalog;
  /**
   * browser-proof.ts — the last sign-in proof of the ChatGPT browser (yes /
   * no / unknown). A read-only projection: null means "never observed",
   * which is distinct from signedOut.
   */
  externalBrowserProof(): { browserId: string; version: string; signedIn: boolean | null } | null;
}

export interface TurnManagerOptions {
  /** TURN_TIMEOUT_SECONDS default; a timeout keeps the turn running. */
  turnTimeoutMs?: number;
  /** How long a queued request waits for the session's in-flight turn. */
  queueWaitMs?: number;
  /** Fallback poll interval; onSessionChange wakes the wait earlier. */
  pollMs?: number;
  /**
   * Keep wait timers referenced. In the app the timers are unref'd so a pending
   * gateway turn never keeps the process alive; tests run with the gateway as
   * the only workload and need the timers to hold the loop.
   */
  refTimers?: boolean;
  now?: () => number;
}

const INPUT_NAMESPACE = '6f1e2b3a-9d4c-5e8f-a1b2-c3d4e5f60718';
const TURN_KINDS = ['assistant_message', 'turn_end', 'chat_error'] as const;
const ANCHOR_KINDS = ['user_message'] as const;

/** The session has an in-flight turn and the caller could not wait it out. */
export class SessionBusy extends Error {
  retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super('session busy; one turn is still running');
    this.name = 'SessionBusy';
    this.retryAfterSeconds = retryAfterSeconds;
  }
  toError(): GatewayErrorData {
    return mapSessionBusy(this.retryAfterSeconds);
  }
}

/** The deadline passed before the turn (or its anchor) completed. */
export class TurnTimeout extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TurnTimeout';
  }
}

/** A `chat_error` event or a turn that ended without an answer. */
export class TurnError extends Error {
  retryAt?: number;
  recoverable?: boolean;
  outcome?: string;
  constructor(message: string, fields: { retryAt?: number; recoverable?: boolean; outcome?: string } = {}) {
    super(message);
    this.name = 'TurnError';
    this.retryAt = fields.retryAt;
    this.recoverable = fields.recoverable;
    this.outcome = fields.outcome;
  }
  toError(): GatewayErrorData {
    return this.outcome !== undefined
      ? mapEndedWithoutAnswer(this.outcome)
      : mapChatError({ message: { text: this.message }, retryAt: this.retryAt, recoverable: this.recoverable }, Date.now());
  }
}

/** Everything the gateway remembers about one conversation. */
export interface SessionInfo {
  sessionId: string | null;
  sentUsers: number;
  /** The derived input id of the turn still in flight, if any. */
  turnInput: string | null;
  turnStartedAt: number | null;
  /**
   * The per-conversation turn sequence. While a turn is in flight it names
   * that turn (a retry re-derives the same input id from it); otherwise it
   * is the next sequence to assign. A consumed sequence never comes back.
   */
  turnSeq: number;
}

interface SessionInfoJson {
  session_id?: string | null;
  sent_users?: number;
  turn_input?: string | null;
  turn_started?: number | null;
  turn_seq?: number;
}

function encodeInfo(info: SessionInfo): SessionInfoJson {
  return {
    session_id: info.sessionId,
    sent_users: info.sentUsers,
    turn_input: info.turnInput,
    turn_started: info.turnStartedAt,
    turn_seq: info.turnSeq
  };
}

function decodeInfo(raw: SessionInfoJson): SessionInfo {
  return {
    sessionId: typeof raw.session_id === 'string' ? raw.session_id : null,
    sentUsers: typeof raw.sent_users === 'number' ? raw.sent_users : 0,
    turnInput: typeof raw.turn_input === 'string' ? raw.turn_input : null,
    turnStartedAt: typeof raw.turn_started === 'number' ? raw.turn_started : null,
    turnSeq: typeof raw.turn_seq === 'number' ? raw.turn_seq : 0
  };
}

/**
 * A deterministic UUIDv5 for one logical turn, so retries replay, never
 * double-send. The per-conversation sequence keeps two legitimate identical
 * messages apart: same text, next sequence, fresh id.
 */
export function turnInputId(
  key: string,
  seq: number,
  text: string,
  model: string | null,
  effort: ReasoningEffort | null,
): string {
  const payload = [key, seq, text, model ?? '', effort ?? ''].join('|');
  return uuidv5(INPUT_NAMESPACE, payload);
}

function uuidv5(namespace: string, name: string): string {
  const bytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const digest = createHash('sha1').update(bytes).update(name, 'utf8').digest();
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x50;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** What one request does to the conversation's turn slot. */
export interface TurnPlan {
  /** The text this turn sends. */
  text: string;
  /** True when this request retries the persisted in-flight turn. */
  replaying: boolean;
  /** The turn sequence this plan was assigned. */
  seq: number;
  /** The deterministic input id for this turn. */
  inputId: string;
}

export class TurnManager {
  private readonly internals: CosInternals;
  private readonly stateFile: string;
  private readonly turnTimeoutMs: number;
  private readonly queueWaitMs: number;
  private readonly pollMs: number;
  private readonly refTimers: boolean;
  private readonly now: () => number;
  private readonly states = new Map<string, SessionInfo>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly wakeups = new Map<string, Set<() => void>>();
  private loaded = false;
  private unsubscribe: (() => void) | null = null;

  constructor(internals: CosInternals, stateDir: string, options: TurnManagerOptions = {}) {
    this.internals = internals;
    this.stateFile = path.join(stateDir, 'state.json');
    this.turnTimeoutMs = options.turnTimeoutMs ?? 600_000;
    this.queueWaitMs = options.queueWaitMs ?? 60_000;
    this.pollMs = options.pollMs ?? 250;
    this.refTimers = options.refTimers ?? false;
    this.now = options.now ?? Date.now;
    this.unsubscribe = internals.onSessionChange((change) => this.wake(change.sessionIds));
  }

  /** Wake every waiter polling a session that just changed (recorder.ts onSessionChange). */
  wake(sessionIds: readonly string[]): void {
    for (const id of sessionIds) {
      for (const finish of this.wakeups.get(id) ?? []) finish();
    }
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  // ------------------------------------------------------------- persistence

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(readFileSync(this.stateFile, 'utf8')) as Record<string, unknown>;
      for (const [key, info] of Object.entries(raw)) {
        if (typeof info === 'object' && info !== null) this.states.set(key, decodeInfo(info as SessionInfoJson));
      }
    } catch {
      // No state yet (or an unreadable file): start empty.
    }
  }

  /**
   * Persist the WHOLE session map atomically (tmp file + rename). Persisting
   * one conversation must never drop another's mapping — a concurrent
   * conversation's state is written alongside the changed one.
   */
  persist(): void {
    this.ensureLoaded();
    if (this.states.size === 0) return;
    mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const payload: Record<string, SessionInfoJson> = {};
    for (const [key, info] of this.states) payload[key] = encodeInfo(info);
    const tmp = this.stateFile + '.tmp';
    writeFileSync(tmp, JSON.stringify(payload, null, 1));
    renameSync(tmp, this.stateFile);
  }

  // ------------------------------------------------------------------- locks

  /**
   * Per-conversation turn lock with a bounded wait. Claim is a synchronous
   * check-and-set, so two waiters can never claim the same turn; a claim
   * that cannot happen before the deadline is a SessionBusy.
   */
  private async acquireLock(key: string): Promise<() => void> {
    const deadline = this.now() + this.queueWaitMs;
    for (;;) {
      if (this.locks.get(key) === undefined) {
        let release: (() => void) | null = null;
        const marker = new Promise<void>((resolve) => { release = resolve; });
        this.locks.set(key, marker);
        return () => {
          release!();
          this.locks.delete(key);
        };
      }
      if (this.now() >= deadline) {
        throw new SessionBusy(Math.ceil(this.queueWaitMs / 1000));
      }
      await new Promise<void>((resolve) => {
        this.timer(this.pollMs, resolve);
      });
    }
  }

  // ---------------------------------------------------------------- acquire

  /**
   * Take the per-conversation turn slot. Settling a persisted in-flight turn
   * is NOT done here: planTurn must first decide whether the caller retries
   * that turn (re-attach by input id) or sends a different one (settle, then
   * send). The caller holds the returned release until the turn's outcome is
   * known (a timeout keeps the persisted marker so a later request
   * re-attaches).
   */
  async acquire(key: string): Promise<{ info: SessionInfo; release: () => void }> {
    this.ensureLoaded();
    const info = this.states.get(key) ?? {
      sessionId: null, sentUsers: 0, turnInput: null, turnStartedAt: null, turnSeq: 0
    };
    this.states.set(key, info);
    const release = await this.acquireLock(key);
    try {
      // The session may be gone from CoS; a live one keeps its history.
      // A gone session leaves nothing to re-attach to: clear the marker.
      if (info.sessionId !== null) {
        const detail = await this.internals.readSession(info.sessionId);
        if (detail === null || detail === undefined) {
          info.sessionId = null;
          info.turnInput = null;
          info.turnStartedAt = null;
        }
      }
      this.persist();
      return { info, release };
    } catch (error) {
      release();
      throw error;
    }
  }

  /**
   * Wait for a persisted in-flight turn (a 504 or a restart left it) to end
   * before a DIFFERENT turn may send. A retry of the in-flight turn never
   * settles: planTurn re-plans it by input id and followTurn re-attaches.
   * Raises SessionBusy when the turn does not settle in time; an unsettled
   * marker is never cleared, so nothing is double-sent.
   */
  async settleLeftover(info: SessionInfo): Promise<void> {
    if (info.turnInput === null || info.sessionId === null) return;
    try {
      await this.settle(info);
    } catch (error) {
      if (error instanceof TurnTimeout) throw new SessionBusy(Math.ceil(this.queueWaitMs / 1000));
      throw error;
    }
    info.turnInput = null;
    info.turnStartedAt = null;
    this.persist();
  }

  /** Wait out an in-flight turn left behind by a restart or a timeout. */
  private async settle(info: SessionInfo): Promise<void> {
    const deadline = this.now() + this.turnTimeoutMs;
    const anchor = await this.findAnchor(info.sessionId!, info.turnInput!, deadline);
    if (anchor === null) return; // the row never delivered; nothing is running
    await this.waitTurn(info.sessionId!, anchor.seq + 1, deadline, false, anchor.turnId);
  }

  /**
   * Choose this turn's text and sequence; detect a retry of the persisted
   * in-flight turn. Read-only: the sequence is consumed by sendTurn (new
   * turn) or finishTurn (settled turn), never here, so a refused send does
   * not burn a sequence.
   */
  planTurn(
    key: string,
    normalized: readonly NormalizedMessage[],
    model: string | null,
    effort: ReasoningEffort | null,
    includeSystem: boolean,
  ): TurnPlan {
    this.ensureLoaded();
    const info = this.states.get(key);

    if (info !== undefined && info.sessionId !== null && info.turnInput !== null) {
      // A turn is still recorded in flight (a 504 or a restart left it). A
      // retry of that turn re-attaches by input id; anything else is a new
      // turn on the next sequence.
      const candidates: string[] = [];
      try { candidates.push(foldDelta(normalized)); } catch (error) { if (!(error instanceof FoldError)) throw error; }
      try { candidates.push(foldFirst(normalized, includeSystem)); } catch (error) { if (!(error instanceof FoldError)) throw error; }
      for (const text of new Set(candidates)) {
        const inputId = turnInputId(key, info.turnSeq, text, model, effort);
        if (inputId === info.turnInput) {
          return { text, replaying: true, seq: info.turnSeq, inputId };
        }
      }
      const text = foldDelta(normalized);
      const seq = info.turnSeq + 1;
      return { text, replaying: false, seq, inputId: turnInputId(key, seq, text, model, effort) };
    }

    const text = info === undefined || info.sessionId === null
      ? foldFirst(normalized, includeSystem)
      : foldDelta(normalized);
    const seq = info?.turnSeq ?? 0;
    return { text, replaying: false, seq, inputId: turnInputId(key, seq, text, model, effort) };
  }

  /**
   * Clear the in-flight turn slot once its outcome is known and recorded,
   * and consume its sequence so the next turn derives a fresh input id. A
   * 504 timeout never calls this: the marker and sequence persist so a
   * retry re-attaches to the running turn instead of re-sending.
   */
  finishTurn(info: SessionInfo): void {
    info.turnInput = null;
    info.turnStartedAt = null;
    info.turnSeq += 1;
    this.persist();
  }

  // -------------------------------------------------------------------- send

  /**
   * Admit a planned turn through the outbox. A retry of a known row is
   * answered here, because the outbox compares the whole request, `dueAt`
   * included, and a retry a moment later would not match
   * (control-actions.ts:139-141).
   */
  async sendTurn(
    info: SessionInfo,
    plan: TurnPlan,
    selection: { model: string | null; reasoningEffort: ReasoningEffort | null },
  ): Promise<{ replayed: boolean; inputId: string; sessionId: string }> {
    const inputId = plan.inputId;

    const existing = (await this.internals.listInputs()).find((row) => row.id === inputId);
    if (existing !== undefined) {
      // A new chat's first message is filed under its own id.
      const expectedSession = info.sessionId ?? inputId;
      if (existing.sessionId !== expectedSession || existing.text !== plan.text ||
          existing.model !== selection.model || existing.reasoningEffort !== selection.reasoningEffort) {
        throw new GatewayError(409, 'id_conflict', 'this id belongs to a different message');
      }
      info.turnSeq = plan.seq;
      return { replayed: true, inputId, sessionId: existing.sessionId ?? inputId };
    }

    if (info.sessionId !== null) {
      // A send into an answer being written ends that part of the turn; the
      // gateway never consents to that (no interrupt parameter in v1).
      const policy = await this.internals.sessionInputPolicy(info.sessionId);
      if (policy.directTurn !== null && policy.directTurn !== undefined) {
        throw new GatewayError(429, 'would_interrupt',
          'the chat is answering right now; retry once the turn ends', 5);
      }
    }

    const input: CosInputArgs = {
      id: inputId,
      sessionId: info.sessionId,
      text: plan.text,
      mode: 'auto',
      dueAt: this.now(),
      model: selection.model,
      reasoningEffort: selection.reasoningEffort,
      authoredSource: 'text'
    };
    let row: CosInputRow;
    try {
      row = await this.internals.sendDesktopInput(input);
    } catch (error) {
      throw mapRefusal(error) ?? new GatewayError(502, 'send_failed',
        error instanceof Error ? error.message : 'the send failed');
    }
    // The outbox decides for itself whether this send stops an answer. A turn
    // that began while the message was being admitted was never agreed to.
    if (row.directTurn !== null && row.directTurn !== undefined) {
      await this.internals.cancelInput(row.id);
      throw new GatewayError(429, 'would_interrupt',
        'the chat began answering while the message was being admitted; it was withdrawn', 5);
    }

    if (info.sessionId === null) info.sessionId = row.sessionId ?? inputId;
    info.sentUsers += 1;
    info.turnInput = inputId;
    // The in-flight turn's sequence, persisted so a retry re-derives the
    // same input id instead of opening a second send.
    info.turnSeq = plan.seq;
    info.turnStartedAt = this.now();
    this.persist();
    return { replayed: false, inputId, sessionId: info.sessionId };
  }

  // ------------------------------------------------------------- turn watcher

  /**
   * Locate the `user_message` event carrying our input id (the turn's anchor).
   * Returns the anchor event (its seq plus, when CoS recorded it, its turnId),
   * or null when the input row never got delivered — nothing will ever happen
   * for that turn. Raises TurnTimeout when the anchor never appears before the
   * deadline.
   *
   * The anchor is the only event tied to our inputId, but its journal position
   * is not reliable: CoS records it at its residence seq, which can sit AFTER
   * the turn_end (observed live for a turn queued hours before delivery). So
   * the follow must not order by seq after the anchor — it keys by the turnId
   * the anchor carries (shared by the turn's turn_end and final answer).
   */
  async findAnchor(
    sessionId: string,
    inputId: string,
    deadline: number,
  ): Promise<{ seq: number; turnId?: string } | null> {
    let fromSeq = 0;
    for (;;) {
      if (this.now() >= deadline) throw new TurnTimeout('the message was never recorded as sent');
      const page = await this.internals.readSessionEvents(sessionId, {
        from: fromSeq, kinds: ANCHOR_KINDS, limit: 400
      });
      if (page !== null && page !== undefined) {
        for (const event of page.events) {
          if (event.inputId === inputId) return { seq: event.seq, turnId: event.turnId };
        }
        if (page.nextFrom > fromSeq) {
          fromSeq = page.nextFrom;
          continue;
        }
      }
      // No newer user_message on this page: check the outbox row before sleeping.
      const row = (await this.internals.listInputs()).find((candidate) => candidate.id === inputId);
      if (row !== undefined && (row.state === 'failed' || row.state === 'cancelled')) return null;
      await this.sleep(sessionId);
    }
  }

  /**
   * Follow a turn to its end. Returns the final `assistant_message` text.
   * Raises TurnError on a `chat_error` event or a `turn_end` with no answer,
   * TurnTimeout when the deadline passes first.
   *
   * When the turn's `turnId` is known (the anchor carried it), completion is
   * keyed by that id instead of by journal order: the final answer and the
   * turn_end are matched to the id wherever they sit in the session, so a
   * turn whose events were recorded before its late-landing anchor still
   * resolves to its recorded answer instead of waiting out the deadline.
   * Without a turnId the positional scan from `fromSeq` stands (older
   * journals that recorded no turn id cannot be keyed any other way).
   */
  async waitTurn(
    sessionId: string,
    fromSeq: number,
    deadline: number,
    needAnswer: boolean,
    turnId?: string,
  ): Promise<string | null> {
    // Keyed mode scans the whole journal — the turn's rows may sit anywhere
    // (their seq order versus the anchor is exactly what broke). Positional
    // mode keeps the original from-cursor start.
    let cursor = turnId === undefined ? fromSeq : 0;
    let answer: string | null = null;
    for (;;) {
      if (this.now() >= deadline) throw new TurnTimeout('the turn did not finish in time');
      const page = await this.internals.readSessionEvents(sessionId, {
        from: cursor, kinds: TURN_KINDS, limit: 400
      });
      if (page !== null && page !== undefined) {
        for (const event of page.events) {
          // Keyed mode attributes every row to its turn id; an untagged row
          // cannot be ours and is skipped. Positional mode uses all rows.
          if (turnId !== undefined && event.turnId !== turnId) continue;
          if (event.kind === 'assistant_message' && event.final === true) {
            answer = event.message?.text ?? '';
          } else if (event.kind === 'chat_error') {
            throw new TurnError(event.message?.text ?? 'the chat reported an error', {
              retryAt: event.retryAt,
              recoverable: event.recoverable
            });
          } else if (event.kind === 'turn_end') {
            if (answer !== null || !needAnswer) return answer;
            throw new TurnError('ended without an answer', { outcome: event.outcome });
          }
        }
        if (page.nextFrom > cursor) {
          cursor = page.nextFrom;
          continue;
        }
      }
      await this.sleep(sessionId);
    }
  }

  /** Follow the whole turn: anchor, then the answer for that turn's id. */
  async followTurn(info: SessionInfo, inputId: string): Promise<string> {
    const sessionId = info.sessionId;
    if (sessionId === null) throw new GatewayError(502, 'no_session', 'no session to follow');
    const deadline = this.now() + this.turnTimeoutMs;
    const anchor = await this.findAnchor(sessionId, inputId, deadline);
    if (anchor === null) {
      const row = (await this.internals.listInputs()).find((candidate) => candidate.id === inputId);
      throw mapUndelivered(row?.error);
    }
    return (await this.waitTurn(sessionId, anchor.seq + 1, deadline, true, anchor.turnId)) ?? '';
  }

  /** A wait timer that is unref'd unless the manager was told to hold the loop. */
  private timer(ms: number, fn: () => void): NodeJS.Timeout {
    const handle = setTimeout(fn, ms);
    if (!this.refTimers) handle.unref?.();
    return handle;
  }

  private async sleep(sessionId: string): Promise<void> {
    return new Promise<void>((resolve) => {
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.wakeups.get(sessionId)?.delete(finish);
        resolve();
      };
      const timer = this.timer(this.pollMs, finish);
      const waiters = this.wakeups.get(sessionId) ?? new Set<() => void>();
      waiters.add(finish);
      this.wakeups.set(sessionId, waiters);
    });
  }
}

/** A completion id for one answered turn. */
export function completionId(): string {
  return `chatcmpl-${randomUUID()}`;
}
