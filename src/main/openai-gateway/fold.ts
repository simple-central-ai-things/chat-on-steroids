/**
 * Message folding: an OpenAI message list into what CoS should receive.
 *
 * ChatGPT has no system role and keeps its own conversation history, so the
 * gateway sends only the delta CoS does not already have:
 *
 * - the **first message of a new chat** carries an optional
 *   `[Context for this conversation]` block (the client's system message)
 *   followed by the user text;
 * - **every later turn** sends only the new user delta. Prior assistant turns
 *   come from ChatGPT itself and are never re-sent.
 *
 * The conversation key is a sha256 over everything up to and including the
 * first user turn — the conversation opener plus its system context, which
 * is the part of the message list that is stable across turns. Callers may
 * override it with the `X-CoS-Session` header (the only way to force a
 * session boundary). Pure module: no CoS imports, tested with node:test.
 */
import { createHash } from 'node:crypto';

/** CoS's POST text ceiling (chars), checked here before send. */
export const MAX_TEXT = 64_000;
export const CONTEXT_MARKER = '[Context for this conversation]';
const ROLES = ['system', 'user', 'assistant'] as const;
export type Role = (typeof ROLES)[number];
export type NormalizedMessage = readonly [Role, string];

/** The message list is not shaped like an OpenAI chat conversation. */
export class FoldError extends Error {}

export function normalizeMessages(messages: unknown): NormalizedMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new FoldError('messages must be a non-empty list');
  }
  const normalized: NormalizedMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (typeof message !== 'object' || message === null) {
      throw new FoldError(`messages[${i}] must be an object`);
    }
    const role = (message as { role?: unknown }).role;
    const content = (message as { content?: unknown }).content;
    if (!ROLES.includes(role as Role)) {
      throw new FoldError(`messages[${i}].role must be one of ${ROLES.join(', ')}`);
    }
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new FoldError(
        `messages[${i}].content must be a non-empty string ` +
          '(content part lists are not supported; CoS takes plain text)',
      );
    }
    normalized.push([role as Role, content]);
  }
  return normalized;
}

/**
 * Stable key for one conversation: sha256 over everything up to and
 * including the first user turn — the system context and the opener.
 * Including the system message keeps two callers with the same opener but
 * different context in separate CoS sessions (shared private context is a
 * leak). True per-principal isolation requires the explicit `X-CoS-Session`
 * override, since LiteLLM does not forward caller identity.
 */
export function conversationKey(
  normalized: readonly NormalizedMessage[],
  override: string | null,
): string {
  if (override !== null && override.trim().length > 0) return override.trim();
  for (let i = 0; i < normalized.length; i++) {
    const message = normalized[i];
    if (message === undefined || message[0] !== 'user') continue;
    const payload = JSON.stringify(normalized.slice(0, i + 1));
    return createHash('sha256').update(payload, 'utf8').digest('hex');
  }
  throw new FoldError('messages must contain at least one user message');
}

/** The turn this request is about; it must be the last message. */
export function lastUserMessage(normalized: readonly NormalizedMessage[]): string {
  const last = normalized[normalized.length - 1];
  if (last === undefined || last[0] !== 'user') {
    throw new FoldError("the last message must have role 'user'");
  }
  return last[1];
}

/** All system messages joined, or null when the request has no context. */
export function systemText(normalized: readonly NormalizedMessage[]): string | null {
  const parts = normalized.filter(([role]) => role === 'system').map(([, content]) => content);
  return parts.length > 0 ? parts.join('\n\n') : null;
}

function checkText(text: string): string {
  if (text.length > MAX_TEXT) {
    throw new FoldError(`message text is ${text.length} chars; CoS accepts at most ${MAX_TEXT}`);
  }
  return text;
}

/** What goes out as the first message of a new chat.
 *
 * The client's system context is capped so the combined text never exceeds
 * CoS's admission ceiling: the user text is always preserved whole, and an
 * oversized context (e.g. a harness's full agent system prompt) is truncated
 * to fit. Without this, a large system prompt blew past CoS's 96k ceiling and
 * the send was refused with a too_big 502.
 */
export function foldFirst(
  normalized: readonly NormalizedMessage[],
  includeSystem: boolean,
): string {
  const userText = checkText(lastUserMessage(normalized));
  if (!includeSystem) return userText;
  const context = systemText(normalized);
  if (context === null) return userText;
  const prefix = `${CONTEXT_MARKER}\n`;
  const suffix = `\n\n${userText}`;
  const budget = MAX_TEXT - prefix.length - suffix.length;
  const ctx = context.trim();
  if (budget <= 0 || ctx.length <= budget) {
    // Fits (or the user text alone fills the budget — send it as-is).
    return budget <= 0 ? userText : `${prefix}${ctx}${suffix}`;
  }
  return `${prefix}${ctx.slice(0, budget)}${suffix}`;
}

/** What goes out on a later turn: only the new user message. */
export function foldDelta(normalized: readonly NormalizedMessage[]): string {
  return checkText(lastUserMessage(normalized));
}
