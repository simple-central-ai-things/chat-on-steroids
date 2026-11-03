/**
 * Mapping between CoS's chat-model catalog and the OpenAI model view.
 *
 * CoS's catalog (src/main/chat-models.ts getChatModels(), typed in
 * src/shared/chat-models.ts ChatModelCatalog) is the picker catalog the app
 * read from ChatGPT's native model picker: `{state, observedAt, models:
 * [{id, label, efforts, aliases?}]}`. The gateway serves it on GET /v1/models
 * with PLAIN ids (no 'cos/' prefix) so LiteLLM canonicalization can merge it
 * with the other sources.
 *
 * `resolveModelChoice` mirrors control-actions.ts chosenModel() + shared
 * resolveChatModel(): exact execution id or lane alias wins, otherwise a
 * unique display-label match resolves; ambiguous or unknown names are a
 * client error. Reimplemented here (not imported from CoS) so this module
 * stays dependency-free and node:test-able; the semantics are pinned to
 * shared/chat-models.ts as of CoS v2.1.49.
 */
import { gatewayError } from './errors.js';

/** CoS's reasoning-effort vocabulary (shared/session.ts REASONING_EFFORTS). */
export const REASONING_EFFORTS = [
  'pro', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface ChatModelOption {
  id: string;
  label: string;
  efforts: readonly ReasoningEffort[];
  aliases?: readonly string[];
}

export interface ChatModelCatalog {
  state: 'unknown' | 'pending' | 'ready' | 'unavailable';
  requestedAt: number | null;
  observedAt: number | null;
  models: readonly ChatModelOption[];
  waiting?: string;
  error?: string;
}

export interface OpenAiModel {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
  /**
   * The reasoning efforts this model offers, as CoS observed them from
   * ChatGPT's picker. This is ALL the model card claims: no context window or
   * max-output figure is invented here (CoS does not know them). A request
   * that omits `reasoning_effort` (or sends null) does NOT pick one of these —
   * it lets ChatGPT choose on its composer auto lane.
   */
  efforts: readonly ReasoningEffort[];
}

/** The picker catalog as an OpenAI model list; plain ids, no 'cos/' prefix. */
export function openAiModels(catalog: ChatModelCatalog): OpenAiModel[] {
  const created = catalog.observedAt !== null ? Math.floor(catalog.observedAt / 1000) : 0;
  return catalog.models.map((option) => ({
    id: option.id,
    object: 'model' as const,
    created,
    owned_by: 'chat-on-steroids',
    efforts: option.efforts
  }));
}

const normalizeName = (value: string): string =>
  value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}.]/gu, '');

/** shared/chat-models.ts resolveChatModel(), pinned at v2.1.49. */
function resolveChoice(models: readonly ChatModelOption[], value: string): ChatModelOption | undefined {
  const exact = models.filter((choice) => choice.id === value || choice.aliases?.includes(value));
  if (exact.length > 0) return exact.length === 1 ? exact[0] : undefined;
  const bare = (text: string): string => normalizeName(text).replace(/^gpt(?=\d)/, '');
  const name = bare(value);
  const matches = name ? models.filter((choice) => bare(choice.label) === name) : [];
  return matches.length === 1 ? matches[0] : undefined;
}

export interface ModelSelection {
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
}

/**
 * Validate an OpenAI {model, reasoning_effort} pair against the catalog, as
 * control-actions.ts chosenModel() does: model and effort always travel
 * together; an omitted effort is forwarded as null — "confirm this model on
 * whatever lane the picker offers", exactly CoS's composer auto lane.
 *
 * The first offered effort is NOT a safe default: the page refuses to
 * confirm some account lanes by their exact (model, effort) pair (measured:
 * gpt-6 + "none" fails model-unconfirmed while gpt-6 + "medium" confirms),
 * so defaulting to efforts[0] would break every effort-less client request.
 *
 * No model in the request means "let ChatGPT keep its own selection" (both
 * null), the same as CoS's composer.
 */
export function resolveModelChoice(
  catalog: ChatModelCatalog,
  model: string | null | undefined,
  effort: ReasoningEffort | null | undefined,
): ModelSelection {
  if (model === undefined || model === null || model.trim().length === 0) {
    return { model: null, reasoningEffort: null };
  }
  if (catalog.state !== 'ready' || catalog.models.length === 0) {
    throw gatewayError('models_unknown');
  }
  const choice = resolveChoice(catalog.models, model);
  if (choice === undefined) {
    throw gatewayError('model_unknown');
  }
  if (effort !== undefined && effort !== null && !choice.efforts.includes(effort)) {
    throw gatewayError('effort_unavailable', choice.id + ' offers ' + choice.efforts.join(', '));
  }
  return { model: choice.id, reasoningEffort: effort ?? null };
}
