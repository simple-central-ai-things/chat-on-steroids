/**
 * The one CoS-touching file in the gateway: it binds the module's
 * CosInternals interface to CoS's real main-process exports. Everything else
 * in the module is dependency-free so node:test can exercise it with stubs.
 *
 * Compiled into CoS at src/main/openai-gateway/, so these relative imports
 * resolve inside the app:
 *
 *   sendDesktopInput  — src/main/session/start-input.ts:76 (durable admission)
 *   cancelDesktopInput— src/main/session/start-input.ts:58 (withdraw a row)
 *   listInputs        — src/main/session/input.ts:1099 (the durable outbox)
 *   sessionInputPolicy— src/main/session/input.ts:239 (delivery policy)
 *   readSession       — src/main/session/read-model.ts:35
 *   readSessionEvents — src/main/session/read-model.ts:85 (from-cursor feed)
 *   onSessionChange   — src/main/session/recorder.ts:176 (turn wakeups)
 *   getChatModels     — src/main/chat-models.ts:69 (the picker catalog)
 *   externalBrowserProof — src/main/browser-proof.ts (last ChatGPT sign-in proof)
 *
 * Pinned to CoS v2.1.49. A CoS upgrade that moves or renames any of these
 * fails the build (the wire patch stops applying, or these imports stop
 * resolving) — rebase patch/wire-openai-server.patch against the new tag.
 */
import { sendDesktopInput, cancelDesktopInput } from '../session/start-input.js';
import { listInputs, sessionInputPolicy } from '../session/input.js';
import { readSession, readSessionEvents } from '../session/read-model.js';
import { onSessionChange } from '../session/recorder.js';
import { getChatModels } from '../chat-models.js';
import { externalBrowserProof } from '../browser-proof.js';
import type { SessionEventKind } from '../../shared/session.js';
import type { CosInternals } from './turns.js';

export function createCosInternals(): CosInternals {
  return {
    sendDesktopInput: (input) => sendDesktopInput(input),
    cancelInput: (id) => cancelDesktopInput(id),
    listInputs: () => listInputs(),
    sessionInputPolicy: (sessionId) => sessionInputPolicy(sessionId),
    readSession: (sessionId) => readSession(sessionId),
    readSessionEvents: (sessionId, options) => readSessionEvents(sessionId, {
      from: options.from,
      // The kinds the gateway asks for are all members of CoS's SessionEventKind.
      kinds: options.kinds as readonly SessionEventKind[],
      limit: options.limit
    }),
    onSessionChange: (listener) => onSessionChange((change) => listener({
      sessionIds: change.sessionIds ?? []
    })),
    getChatModels: () => getChatModels(),
    externalBrowserProof: () => externalBrowserProof()
  };
}
