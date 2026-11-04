/**
 * Per-handle deployment registry and model identity (platform spec D1 / H-042).
 *
 * One CoS process is ONE ChatGPT account: its browser profile, its userData,
 * its keyring and its two ports (the gateway API port and the VNC viewer port)
 * all belong to that account. A *handle* is the operator's alias for one such
 * instance. Runs of several accounts are separate instances joined only by this
 * registry — never by a shared browser profile, userData directory or keyring,
 * because those three carry the account's cookie/session material and sharing
 * one would sign two accounts into the same store.
 *
 * This module is the offline authority for:
 *
 *  - `HandleRegistry.parse` — validation of the deployment's handle list. It
 *    rejects (never repairs) a definition whose handle name, ports or
 *    account-bearing paths collide with another handle.
 *  - `parseModelIdentity` / `resolveIdentity` — the `<model>@cos-<handle>`
 *    deployment identity and the rule that one instance serves exactly one
 *    handle; an identity naming another handle is a routing error, not a
 *    reason to touch that account.
 *  - `assessReadiness` — per-handle readiness from LIVE browser evidence. Only
 *    positive evidence on every signal is ready; anything unobserved is
 *    unknown, and unknown is NOT ready.
 *  - `buildDeploymentMap` — the `<model>@cos-<handle>` entries a deployment
 *    publishes, with readiness, and no account identity in them.
 *  - `scopedConversationKey` / `handleOfConversationKey` — conversation,
 *    session and retry keys are namespaced BY HANDLE, so a turn of one account
 *    can never be re-attached from another.
 *
 * Pure module (no CoS imports), so node:test exercises it without Electron.
 */
import { gatewayError, type GatewayErrorData } from './errors.js';

/** Handle names: lowercase DNS-ish, 2..32 chars, no leading digit. */
export const HANDLE_NAME_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

/** The deployment-identity separator: `<model>@cos-<handle>`. */
export const IDENTITY_MARKER = '@cos-';

/** The response header that says which handle served a request (alias only). */
export const SERVED_BY_HEADER = 'x-cos-handle';

/** One handle's own CoS instance, by its two published ports. */
export interface HandleInstance {
  /** The gateway's own API port for that instance (distinct per handle). */
  apiPort: number;
  /** The VNC viewer port for that instance (distinct per handle). */
  vncPort: number;
}

/** A handle as the deploy configuration spells it. */
export interface HandleDefinition {
  handle: string;
  instance: HandleInstance;
  /**
   * That account's browser profile directory. NEVER shared with another
   * handle: it holds the account's cookies.
   */
  browserProfile: string;
  /** That instance's userData root (state DB, sessions, browser proofs). */
  userData: string;
  /** The keyring/credential store that account's instance unlocks. */
  keyring: string;
  /**
   * Operator-facing account label (an email or an internal id). INTERNAL: it
   * is never serialized into an HTTP response, a deployment entry, a log line
   * or a served-by header; only the handle alias travels to clients.
   */
  account?: string;
  /**
   * Base model ids this handle serves (no `@cos-` suffix). Empty means "whatever
   * this account's own catalog offers".
   */
  models?: readonly string[];
  /** Disabled handles are refused with 403; they still take part in isolation checks. */
  enabled?: boolean;
  /** Pool order for a model this handle shares with others; lower serves first. */
  order?: number;
}

/** A validated handle. */
export interface Handle {
  readonly handle: string;
  readonly apiPort: number;
  readonly vncPort: number;
  readonly browserProfile: string;
  readonly userData: string;
  readonly keyring: string;
  readonly account: string | null;
  readonly models: readonly string[];
  readonly enabled: boolean;
  readonly order: number;
}

/** A handle list that cannot be deployed. `problems` names every violation. */
export class HandleRegistryError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`invalid handle registry: ${problems.join('; ')}`);
    this.name = 'HandleRegistryError';
    this.problems = problems;
  }
}

/**
 * A textual identity for an account-bearing path, used ONLY to prove two
 * handles do not share one. Case-folding and slash normalization make the check
 * conservative: two genuinely different directories that differ only by case
 * are refused rather than silently treated as distinct.
 */
function isolationKey(value: string): string {
  const slashed = value.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  const trimmed = slashed.length > 1 ? slashed.replace(/\/+$/, '') : slashed;
  return trimmed.toLowerCase();
}

function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 65535;
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * The validated handle registry. Construct with `parse`; the only way to get a
 * `Handle` is through a registry that passed every isolation check.
 */
export class HandleRegistry {
  private readonly byName: ReadonlyMap<string, Handle>;
  private readonly ordered: readonly Handle[];

  private constructor(handles: readonly Handle[]) {
    this.ordered = handles;
    this.byName = new Map(handles.map((handle) => [handle.handle, handle]));
  }

  /**
   * Validate a handle list. Accepts the deploy document's shape — an array, or
   * `{ handles: [...] }` — and throws `HandleRegistryError` listing every
   * problem instead of accepting a partially isolated deployment.
   */
  static parse(raw: unknown): HandleRegistry {
    const list = Array.isArray(raw)
      ? raw
      : typeof raw === 'object' && raw !== null && Array.isArray((raw as { handles?: unknown }).handles)
        ? (raw as { handles: unknown[] }).handles
        : null;
    if (list === null) {
      throw new HandleRegistryError(['handles must be a list of handle definitions']);
    }
    if (list.length === 0) {
      throw new HandleRegistryError(['handles must define at least one handle']);
    }
    const problems: string[] = [];
    const handles: Handle[] = [];
    list.forEach((entry, index) => {
      const where = `handles[${index}]`;
      if (typeof entry !== 'object' || entry === null) {
        problems.push(`${where} must be an object`);
        return;
      }
      const raw = entry as Record<string, unknown>;
      const handle = raw.handle;
      if (typeof handle !== 'string' || !HANDLE_NAME_PATTERN.test(handle)) {
        problems.push(`${where}.handle must match ${HANDLE_NAME_PATTERN.source}`);
      }
      const instance = raw.instance;
      let apiPort: number | null = null;
      let vncPort: number | null = null;
      if (typeof instance !== 'object' || instance === null) {
        problems.push(`${where}.instance must carry apiPort and vncPort`);
      } else {
        const ports = instance as Record<string, unknown>;
        if (!isPort(ports.apiPort)) problems.push(`${where}.instance.apiPort must be a port (1..65535)`);
        else apiPort = ports.apiPort;
        if (!isPort(ports.vncPort)) problems.push(`${where}.instance.vncPort must be a port (1..65535)`);
        else vncPort = ports.vncPort;
        if (apiPort !== null && vncPort !== null && apiPort === vncPort) {
          problems.push(`${where}.instance must use different ports for the API and VNC`);
        }
      }
      if (!isText(raw.browserProfile)) problems.push(`${where}.browserProfile must be a directory`);
      if (!isText(raw.userData)) problems.push(`${where}.userData must be a directory`);
      if (!isText(raw.keyring)) problems.push(`${where}.keyring must name the account's keyring`);
      if (raw.account !== undefined && raw.account !== null && typeof raw.account !== 'string') {
        problems.push(`${where}.account must be a string when present`);
      }
      let models: readonly string[] = [];
      if (raw.models !== undefined) {
        if (!Array.isArray(raw.models) || raw.models.some((model) => !isText(model))) {
          problems.push(`${where}.models must be a list of base model ids`);
        } else {
          models = raw.models as string[];
        }
      }
      if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
        problems.push(`${where}.enabled must be a boolean`);
      }
      if (raw.order !== undefined && (typeof raw.order !== 'number' || !Number.isFinite(raw.order))) {
        problems.push(`${where}.order must be a number`);
      }
      if (typeof handle !== 'string' || !HANDLE_NAME_PATTERN.test(handle) ||
          apiPort === null || vncPort === null ||
          !isText(raw.browserProfile) || !isText(raw.userData) || !isText(raw.keyring)) {
        return;
      }
      handles.push({
        handle,
        apiPort,
        vncPort,
        browserProfile: raw.browserProfile.trim(),
        userData: raw.userData.trim(),
        keyring: raw.keyring.trim(),
        account: typeof raw.account === 'string' ? raw.account : null,
        models,
        enabled: raw.enabled !== false,
        order: typeof raw.order === 'number' ? raw.order : index
      });
    });

    // A handle name claimed twice is reported even when one of the definitions
    // was otherwise invalid: two instances must not answer for one alias.
    const declared = new Map<string, number>();
    for (const entry of list) {
      const name = typeof entry === 'object' && entry !== null
        ? (entry as { handle?: unknown }).handle
        : null;
      if (typeof name === 'string' && name !== '') {
        declared.set(name, (declared.get(name) ?? 0) + 1);
      }
    }
    for (const [name, count] of declared) {
      if (count > 1) problems.push(`handle ${name} is defined twice`);
    }
    if (problems.length > 0) throw new HandleRegistryError(problems);

    // Isolation: every account-bearing field and every port belongs to exactly
    // one handle. A collision is a hard error — a shared browser profile would
    // sign two accounts into one store, and a shared port would make one
    // instance answer for another.
    const claims: Array<{ field: string; value: string; where: string }> = [];
    for (const handle of handles) {
      claims.push({ field: 'browserProfile', value: isolationKey(handle.browserProfile), where: handle.handle });
      claims.push({ field: 'userData', value: isolationKey(handle.userData), where: handle.handle });
      claims.push({ field: 'keyring', value: isolationKey(handle.keyring), where: handle.handle });
      // One account per instance: the same account label on two handles means
      // two instances signed into one account, which the spec forbids.
      if (handle.account !== null) {
        claims.push({ field: 'account', value: isolationKey(handle.account), where: handle.handle });
      }
    }
    const seen = new Map<string, string>();
    for (const claim of claims) {
      const key = `${claim.field}\u0000${claim.value}`;
      const owner = seen.get(key);
      if (owner !== undefined) {
        problems.push(`${claim.field} ${claim.value} is shared by handles ${owner} and ${claim.where}`);
      } else {
        seen.set(key, claim.where);
      }
    }
    // A port namespace is shared: an API port must never equal another handle's
    // VNC port either.
    const portOwner = new Map<string, string>();
    for (const handle of handles) {
      for (const [field, port] of [['apiPort', handle.apiPort], ['vncPort', handle.vncPort]] as const) {
        const owner = portOwner.get(String(port));
        if (owner !== undefined && owner !== handle.handle) {
          problems.push(`port ${port} (${field} of ${handle.handle}) is already used by ${owner}`);
        } else {
          portOwner.set(String(port), handle.handle);
        }
      }
    }
    const names = new Set<string>();
    for (const handle of handles) {
      if (names.has(handle.handle)) problems.push(`handle ${handle.handle} is defined twice`);
      names.add(handle.handle);
    }
    if (problems.length > 0) throw new HandleRegistryError(problems);
    return new HandleRegistry([...handles].sort(
      (a, b) => (a.order - b.order) || a.handle.localeCompare(b.handle)
    ));
  }

  /** One handle by name, or null. */
  get(name: string): Handle | null {
    return this.byName.get(name) ?? null;
  }

  /** Every handle in operator pool order. */
  list(): readonly Handle[] {
    return this.ordered;
  }

  /**
   * The handle this instance serves. Unknown and disabled handles are refused
   * here, so no caller can route a turn to an account the operator turned off.
   */
  local(name: string): Handle {
    const handle = this.byName.get(name);
    if (handle === undefined) {
      throw gatewayError('handle_unknown', `this deployment defines no handle named '${name}'`);
    }
    if (!handle.enabled) {
      throw gatewayError('handle_disabled', `handle '${name}' is disabled by the operator`);
    }
    return handle;
  }
}

/** A model string split into its base model and its handle (either may be null). */
export interface ParsedIdentity {
  model: string | null;
  handle: string | null;
  /** The `@cos-` marker was present but carried no handle. */
  malformed: boolean;
}

/**
 * Split a deployment identity. The marker is matched from the END so a model id
 * that itself contains an `@` survives; an empty handle after the marker is
 * malformed, never silently treated as a bare model.
 */
export function parseModelIdentity(value: string | null | undefined): ParsedIdentity {
  const text = (value ?? '').trim();
  if (text === '') return { model: null, handle: null, malformed: false };
  const at = text.toLowerCase().lastIndexOf(IDENTITY_MARKER);
  if (at < 0) return { model: text, handle: null, malformed: false };
  const model = text.slice(0, at).trim();
  const handle = text.slice(at + IDENTITY_MARKER.length).trim();
  if (handle === '') return { model: model === '' ? null : model, handle: null, malformed: true };
  return { model: model === '' ? null : model, handle, malformed: false };
}

/** The deployment identity a client writes: `<model>@cos-<handle>`. */
export function deploymentIdentity(model: string, handle: string): string {
  return `${model}${IDENTITY_MARKER}${handle}`;
}

/** What one instance concluded about a request it will serve. */
export interface ServedIdentity {
  /** The handle this request is served by (always this instance's own). */
  handle: Handle;
  /** The base model id to hand to CoS; null lets the picker keep its choice. */
  model: string | null;
}

/**
 * Resolve a client's `model` string against the registry for THIS instance.
 *
 * A known-but-foreign handle is a routing error, not an invitation: the
 * request is answered by the instance that owns that handle, which is the only
 * process that can reach that account. Nothing here ever names another
 * handle's account, profile or keyring.
 */
export function resolveIdentity(
  registry: HandleRegistry,
  localHandle: string,
  value: string | null | undefined,
): ServedIdentity {
  const local = registry.local(localHandle);
  const parsed = parseModelIdentity(value);
  if (parsed.malformed) {
    throw gatewayError('handle_unknown', `the model identity has no handle after '${IDENTITY_MARKER}'`);
  }
  if (parsed.handle === null) return { handle: local, model: parsed.model };
  const named = registry.get(parsed.handle);
  if (named === null) {
    throw gatewayError('handle_unknown', `this deployment defines no handle named '${parsed.handle}'`);
  }
  if (!named.enabled) {
    throw gatewayError('handle_disabled', `handle '${parsed.handle}' is disabled by the operator`);
  }
  if (named.handle !== local.handle) {
    throw gatewayError('handle_mismatch',
      `this instance serves handle '${local.handle}'; '${named.handle}' is served by its own instance`);
  }
  return { handle: local, model: parsed.model };
}

/** The live browser evidence one handle's readiness is computed from. */
export interface ReadinessEvidence {
  signedIn: boolean | null;
  browserRunning: boolean | null;
  extensionFresh: boolean | null;
}

/** A handle's serving status. Only `ready` may serve a turn. */
export type HandleStatus = 'ready' | 'not_ready' | 'unknown' | 'disabled';

/** One handle's readiness, with the evidence it was computed from. */
export interface HandleReadiness {
  handle: string;
  status: HandleStatus;
  /** True ONLY with positive live evidence on every signal. */
  ready: boolean;
  reason: string;
  evidence: ReadinessEvidence;
}

const NO_EVIDENCE: ReadinessEvidence = {
  signedIn: null,
  browserRunning: null,
  extensionFresh: null
};

/**
 * Per-handle readiness from live browser evidence. Unknown is NOT ready: a
 * quiet browser, a missing proof or an unheard-from extension proves nothing,
 * and serving on absence of evidence is how a turn silently goes nowhere.
 */
export function assessReadiness(
  handle: Handle,
  evidence: ReadinessEvidence | null,
): HandleReadiness {
  const live = evidence ?? NO_EVIDENCE;
  if (!handle.enabled) {
    return {
      handle: handle.handle, status: 'disabled', ready: false,
      reason: 'disabled by the operator', evidence: live
    };
  }
  const unobserved = (['signedIn', 'browserRunning', 'extensionFresh'] as const)
    .filter((signal) => live[signal] === null);
  if (unobserved.length > 0) {
    return {
      handle: handle.handle, status: 'unknown', ready: false,
      reason: `unobserved live evidence: ${unobserved.join(', ')}`, evidence: live
    };
  }
  const denied = (['signedIn', 'browserRunning', 'extensionFresh'] as const)
    .filter((signal) => live[signal] === false);
  if (denied.length > 0) {
    return {
      handle: handle.handle, status: 'not_ready', ready: false,
      reason: `live evidence says no: ${denied.join(', ')}`, evidence: live
    };
  }
  return { handle: handle.handle, status: 'ready', ready: true, reason: 'live browser evidence', evidence: live };
}

/** One `<model>@cos-<handle>` deployment entry. */
export interface DeploymentEntry {
  /** The full deployment identity a client may ask for. */
  model: string;
  baseModel: string;
  handle: string;
  status: HandleStatus;
  ready: boolean;
}

/**
 * The deployment map: one entry per (handle, model) pair, tagged with the
 * readiness this instance can actually prove. A handle this instance cannot
 * observe has unknown readiness — never ready — and carries no account detail.
 *
 * `modelsByHandle` supplies the base model ids known for each handle; a handle
 * absent from it falls back to the models its definition declares.
 */
export function buildDeploymentMap(
  registry: HandleRegistry,
  readiness: ReadonlyMap<string, HandleReadiness>,
  modelsByHandle: ReadonlyMap<string, readonly string[]> = new Map(),
): DeploymentEntry[] {
  const entries: DeploymentEntry[] = [];
  for (const handle of registry.list()) {
    const state = readiness.get(handle.handle)
      ?? assessReadiness(handle, null);
    const models = modelsByHandle.get(handle.handle) ?? handle.models;
    for (const model of models) {
      entries.push({
        model: deploymentIdentity(model, handle.handle),
        baseModel: model,
        handle: handle.handle,
        status: state.status,
        ready: state.ready
      });
    }
  }
  return entries;
}

/**
 * The only handle information an untrusted client may see: the alias and its
 * readiness. Account label, browser profile, userData and keyring are dropped
 * on purpose — this is the projection used for HTTP bodies and logging of the
 * served handle.
 */
export interface PublicHandleView {
  handle: string;
  status: HandleStatus;
  ready: boolean;
  reason: string;
}

export function publicHandleView(state: HandleReadiness): PublicHandleView {
  return { handle: state.handle, status: state.status, ready: state.ready, reason: state.reason };
}

/** The served-by header value: the alias, nothing else. */
export function servedByValue(handle: string): string {
  return handle;
}

/** The per-handle prefix of every conversation/session/retry key. */
export function scopedConversationKey(handle: string, key: string): string {
  return `cos:${handle}:${key}`;
}

/** The handle a stored conversation key belongs to, or null for a legacy key. */
export function handleOfConversationKey(key: string): string | null {
  if (!key.startsWith('cos:')) return null;
  const rest = key.slice(4);
  const colon = rest.indexOf(':');
  if (colon <= 0) return null;
  const handle = rest.slice(0, colon);
  return HANDLE_NAME_PATTERN.test(handle) ? handle : null;
}

/** Re-exported shape so callers can hold a decision without importing errors. */
export type HandleErrorData = GatewayErrorData;
