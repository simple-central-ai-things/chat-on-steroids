/**
 * The retired whole-map `state.json` format — one file holding every
 * conversation, rewritten atomically on every persist.
 *
 * It is kept for exactly three jobs, all of them deliberate:
 *
 *   import    the one-shot migration source (store.ts reads it once and
 *             records the file's SHA-256 in `meta`).
 *   shadow    `state.export.json`, rewritten after every commit, is a
 *             recoverable copy in this same shape: it can rebuild an empty
 *             store, and it can be handed to an older build.
 *   rollback  `GatewayStateStore.rollbackToLegacy()` writes this shape back to
 *             `state.json` and retires the database, so downgrading is one
 *             operator action instead of an ad-hoc data conversion.
 *
 * The encoder is byte-compatible with the writer this replaced
 * (`JSON.stringify(payload, null, 1)`), so a file this module produces is what
 * the old build expects to find.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import path from 'node:path';
import type { LegacyConversationRow, LegacyStateMap } from './schema.js';

/** The file the pre-SQLite build read and wrote. */
export const LEGACY_STATE_FILE = 'state.json';

/** The recoverable export written beside the database after every commit. */
export const SHADOW_STATE_FILE = 'state.export.json';

export interface LegacyReadResult {
  /** The parsed map; empty when the file is missing or unreadable. */
  map: LegacyStateMap;
  /** Raw file bytes, null when the file does not exist. */
  bytes: string | null;
  /** Why the file could not be used, null when it parsed. */
  error: string | null;
}

/**
 * Read the legacy map. A missing file is not an error (a fresh install has
 * none); a present but unparsable file is reported so the migration can record
 * it instead of silently pretending the user had no conversations.
 */
export function readLegacyStateFile(file: string): LegacyReadResult {
  let bytes: string;
  try {
    bytes = readFileSync(file, 'utf8');
  } catch (error: unknown) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOENT') return { map: {}, bytes: null, error: null };
    return { map: {}, bytes: null, error: error instanceof Error ? error.message : 'unreadable' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes) as unknown;
  } catch (error: unknown) {
    return {
      map: {},
      bytes,
      error: error instanceof Error ? `invalid JSON: ${error.message}` : 'invalid JSON'
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { map: {}, bytes, error: 'the file does not hold a conversation map' };
  }
  const map: LegacyStateMap = {};
  for (const [key, row] of Object.entries(parsed as Record<string, unknown>)) {
    // The old loader skipped anything that was not an object; keep that
    // tolerance so a damaged entry cannot cost the rest of the file.
    if (typeof row === 'object' && row !== null && !Array.isArray(row)) {
      map[key] = row as LegacyConversationRow;
    }
  }
  return { map, bytes, error: null };
}

/** Encode the map exactly as the pre-SQLite writer did. */
export function encodeLegacyState(map: LegacyStateMap): string {
  return JSON.stringify(map, null, 1);
}

/**
 * Replace a state file atomically: write the whole text to `<file>.tmp`,
 * flush it, then rename over the target. A crash mid-write leaves the previous
 * file intact (and a stale `.tmp` that the next write replaces).
 */
export function writeStateFileAtomic(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const handle = openSync(tmp, 'w');
  try {
    writeSync(handle, text, null, 'utf8');
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  renameSync(tmp, file);
}
