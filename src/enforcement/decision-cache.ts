import crypto from 'node:crypto';
import { asRecord } from '../core/object.js';
import { writeFileAtomic } from '../storage/atomic-file.js';
import { SECRET_FILE_MODE } from '../storage/constants/storage.constants.js';
import { readJsonFile } from '../storage/json-file.js';
import { MAX_CACHE_ENTRIES } from './constants/enforcement.constants.js';
import { cachedDecisionSchema } from './schemas/enforcement.schema.js';
import type { CachedDecision, EnforcementDecision } from './types/enforcement.types.js';

/**
 * The decision, memoised on disk for the TTL the platform caches it for.
 *
 * Hooks are separate short-lived processes, so "this developer is allowed" has
 * to survive between them or the check would be a round trip per turn. Every
 * failure — a missing file, an unparseable one, an entry this code cannot read,
 * a write that fails — is a miss: the cache exists to save a request, never to
 * decide anything.
 */
export class DecisionCache {
  /**
   * Bind the cache to its file.
   *
   * @param file - Where decisions are persisted.
   * @param now - Clock, injectable for tests.
   */
  constructor(
    private readonly file: string,
    private readonly now: () => Date
  ) {}

  /**
   * The unexpired decision for one key.
   *
   * @param key - Key from {@link decisionKey}.
   * @returns The decision, or undefined on a miss.
   */
  async read(key: string): Promise<EnforcementDecision | undefined> {
    const entries = await this.entries();

    return usableEntry(entries[key], this.now().getTime())?.decision;
  }

  /**
   * Store one decision, pruning what has expired.
   *
   * @param key - Key from {@link decisionKey}.
   * @param decision - The decision to keep.
   * @param ttlMs - How long it stays usable.
   */
  async write(key: string, decision: EnforcementDecision, ttlMs: number): Promise<void> {
    const at = this.now().getTime();
    const next = { ...liveEntries(await this.entries(), at), [key]: { decision, expiresAt: at + ttlMs } };

    try {
      // 0600: an entry holds the alert's sentence, which names a person and
      // what they spent.
      await writeFileAtomic(this.file, JSON.stringify(bounded(next)), SECRET_FILE_MODE);
    } catch {
      // A decision that cannot be stored is still a decision: the caller has
      // its answer and the next hook simply asks again.
    }
  }

  /**
   * Raw entries of the cache file.
   *
   * @returns The entries, or an empty bag when the file is absent or unusable.
   */
  private async entries(): Promise<Record<string, unknown>> {
    const result = await readJsonFile(this.file);

    if (result.state !== 'ok') return {};

    return asRecord(result.value) ?? {};
  }
}

/**
 * The cache key for one question.
 *
 * Hashed rather than composed in the clear: the file would otherwise hold the
 * backend token and the developer's email next to a dollar figure, and neither
 * is needed to read an entry back. Including the URL and the token means a
 * re-pointed or re-credentialed Edge starts with a cold cache instead of
 * answering from another backend's decisions.
 *
 * @param url - The decision endpoint.
 * @param token - Edge token the question is asked with.
 * @param developerId - Identity the question is about.
 * @returns The key.
 */
export function decisionKey(url: string, token: string, developerId: string): string {
  return crypto.createHash('sha256').update(`${url}|${token}|${developerId}`).digest('hex');
}

/**
 * One entry, if it both validates and is still live.
 *
 * The whole fail-open invariant rests on this test — an entry an older version
 * wrote, a key that collided, something edited by hand must read as a miss
 * rather than as an answer — so it exists once and both readers go through it.
 *
 * @param value - Raw entry from the file.
 * @param at - Current epoch milliseconds.
 * @returns The entry, or undefined when it cannot be used.
 */
function usableEntry(value: unknown, at: number): CachedDecision | undefined {
  const parsed = cachedDecisionSchema.safeParse(value);

  if (!parsed.success || parsed.data.expiresAt <= at) return undefined;

  return parsed.data;
}

/**
 * The entries that are still usable, validated on the way through.
 *
 * @param entries - Raw entries of the file.
 * @param at - Current epoch milliseconds.
 * @returns Only the usable entries.
 */
function liveEntries(entries: Record<string, unknown>, at: number): Record<string, CachedDecision> {
  const out: Record<string, CachedDecision> = {};

  for (const [key, value] of Object.entries(entries)) {
    const entry = usableEntry(value, at);

    if (!entry) continue;

    out[key] = entry;
  }

  return out;
}

/**
 * The newest entries, when a pathological setup has grown the file.
 *
 * @param entries - Entries about to be written.
 * @returns At most {@link MAX_CACHE_ENTRIES} of them, the longest-lived first.
 */
function bounded(entries: Record<string, CachedDecision>): Record<string, CachedDecision> {
  const pairs = Object.entries(entries);

  if (pairs.length <= MAX_CACHE_ENTRIES) return entries;

  const out: Record<string, CachedDecision> = {};
  const kept = pairs.sort((left, right) => right[1].expiresAt - left[1].expiresAt).slice(0, MAX_CACHE_ENTRIES);

  for (const [key, value] of kept) out[key] = value;

  return out;
}
