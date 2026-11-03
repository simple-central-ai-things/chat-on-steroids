/**
 * A fake CosInternals for node:test: an in-memory outbox, session event
 * logs and catalog, mirroring the CoS behaviors the gateway relies on
 * (durable admission, new-chat sessionId === input id, from-cursor event
 * pages, onSessionChange wakeups).
 */
import type {
  ChatModelCatalog
} from '../../src/main/openai-gateway/catalog.js';
import type {
  CosEvent,
  CosEventsPage,
  CosInputArgs,
  CosInputRow,
  CosInternals,
  CosPolicy
} from '../../src/main/openai-gateway/turns.js';

export class FakeCos implements CosInternals {
  readonly inputs = new Map<string, CosInputRow>();
  readonly sessions = new Map<string, CosEvent[]>();
  readonly sent: CosInputArgs[] = [];
  readonly policyCalls: string[] = [];
  catalog: ChatModelCatalog = { state: 'ready', requestedAt: null, observedAt: 1730000000000, models: [] };
  /** When true, sendDesktopInput rejects with this message. */
  sendError: string | null = null;
  private nextSeq = 0;
  private changeListener: ((change: { sessionIds: readonly string[] }) => void) | null = null;

  addSession(sessionId: string): void {
    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, []);
  }

  /** Append an event row; the recorder notifies once per burst in the real app. */
  appendEvent(sessionId: string, event: Omit<CosEvent, 'seq'>): CosEvent {
    const row: CosEvent = { ...event, seq: ++this.nextSeq };
    this.addSession(sessionId);
    this.sessions.get(sessionId)!.push(row);
    return row;
  }

  /** What the recorder's onSessionChange would deliver for the newest events. */
  notify(sessionId: string): void {
    this.changeListener?.({ sessionIds: [sessionId] });
  }

  async sendDesktopInput(input: CosInputArgs): Promise<CosInputRow> {
    if (this.sendError !== null) throw new Error(this.sendError);
    this.sent.push(input);
    // The outbox opens a chat for a message without a session; its id is the
    // message id (src/main/session/input.ts enqueueInput). The session row
    // exists from admission, like in CoS.
    const sessionId = input.sessionId ?? input.id;
    this.addSession(sessionId);
    const row: CosInputRow = {
      id: input.id,
      sessionId,
      state: 'sent',
      text: input.text,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      directTurn: null
    };
    this.inputs.set(input.id, row);
    return row;
  }

  async cancelInput(id: string): Promise<boolean> {
    const row = this.inputs.get(id);
    if (row === undefined) return false;
    this.inputs.delete(id);
    return true;
  }

  async listInputs(): Promise<CosInputRow[]> {
    return [...this.inputs.values()].map((row) => ({ ...row }));
  }

  setPolicy(sessionId: string, policy: CosPolicy): void {
    this.policies.set(sessionId, policy);
  }
  private readonly policies = new Map<string, CosPolicy>();

  async sessionInputPolicy(sessionId: string): Promise<CosPolicy> {
    this.policyCalls.push(sessionId);
    return this.policies.get(sessionId) ?? { directTurn: null };
  }

  async readSession(sessionId: string): Promise<unknown | null> {
    return this.sessions.has(sessionId) ? { id: sessionId } : null;
  }

  async readSessionEvents(
    sessionId: string,
    options: { from: number; kinds: readonly string[]; limit?: number },
  ): Promise<CosEventsPage | null> {
    const events = this.sessions.get(sessionId);
    if (events === undefined) return null;
    const limit = options.limit ?? Number.MAX_SAFE_INTEGER;
    const page = events
      .filter((event) => event.seq >= options.from && options.kinds.includes(event.kind))
      .slice(0, limit);
    const nextFrom = page.reduce((cursor, event) => Math.max(cursor, event.seq + 1), options.from);
    return { events: page, nextFrom };
  }

  onSessionChange(listener: (change: { sessionIds: readonly string[] }) => void): () => void {
    this.changeListener = listener;
    return () => {
      if (this.changeListener === listener) this.changeListener = null;
    };
  }

  getChatModels(): ChatModelCatalog {
    return this.catalog;
  }

  /** The external browser's last sign-in proof; null = never observed. */
  browserProof: { browserId: string; version: string; signedIn: boolean | null; since?: number | null } | null = null;

  externalBrowserProof(): { browserId: string; version: string; signedIn: boolean | null; since: number | null } | null {
    if (this.browserProof === null) return null;
    return {
      browserId: this.browserProof.browserId,
      version: this.browserProof.version,
      signedIn: this.browserProof.signedIn,
      since: this.browserProof.since ?? null
    };
  }

  /** Live browser/extension evidence the gateway /v1/status reports. */
  liveEvidence: { browserRunning: boolean | null; extensionFresh: boolean | null } = {
    browserRunning: null,
    extensionFresh: null
  };

  liveChatGptEvidence(): Promise<{ browserRunning: boolean | null; extensionFresh: boolean | null }> {
    return Promise.resolve({ ...this.liveEvidence });
  }
}

/** Deliver a full turn for an admitted input, the way CoS would. */
export function deliverTurn(
  fake: FakeCos,
  inputId: string,
  answer: string,
  outcome: string = 'completed',
): void {
  const row = fake.inputs.get(inputId);
  if (row === undefined) throw new Error('deliverTurn: unknown input id');
  const sessionId = row.sessionId!;
  fake.appendEvent(sessionId, { kind: 'user_message', message: { text: '...' }, inputId });
  fake.appendEvent(sessionId, { kind: 'assistant_message', final: true, message: { text: answer } });
  fake.appendEvent(sessionId, { kind: 'turn_end', outcome });
  fake.notify(sessionId);
}
