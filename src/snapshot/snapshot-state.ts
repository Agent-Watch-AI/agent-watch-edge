import path from 'node:path';
import { asRecord } from '../core/object.js';
import { sha256Hex } from '../events/event-id.js';
import { writeFileAtomic } from '../storage/atomic-file.js';
import { readJsonFile } from '../storage/json-file.js';
import { SNAPSHOT_STATE_HASH_LENGTH } from './constants/snapshot.constants.js';
import type { SnapshotState, SnapshotStateEntry } from './types/snapshot.types.js';

export type { SnapshotState, SnapshotStateEntry } from './types/snapshot.types.js';

/**
 * What the last snapshot of each repository reported.
 *
 * The point of the whole file: a closing turn on a repository where nothing has
 * moved must cost one `for-each-ref` and no event at all. Without it every turn
 * would resend ten branches and the backend would spend a transaction per
 * branch confirming that it already knew.
 *
 * One file per repository, keyed by a hash of its identity so a remote URL
 * never becomes a path on disk. Read tolerantly and rewritten whole: this is a
 * cache, and losing it costs one redundant snapshot, which the backend absorbs.
 */
export class SnapshotStateStore {
  /**
   * Bind the store to its state root.
   *
   * @param snapshotsDir - Directory the per-repository files live in.
   */
  constructor(readonly snapshotsDir: string) {}

  /**
   * What was last sent for one repository.
   *
   * @param repository - Sanitized repository identity.
   * @returns The stored state, or an empty one when there is none or it is
   *   unreadable — an unreadable cache means "send everything", never a failure.
   */
  async read(repository: string): Promise<SnapshotState> {
    const result = await readJsonFile(this.file(repository));

    if (result.state !== 'ok') return emptyState();

    const record = asRecord(result.value);

    if (!record) return emptyState();

    return {
      defaultBranch: typeof record.defaultBranch === 'string' ? record.defaultBranch : undefined,
      branches: readEntries(record.branches)
    };
  }

  /**
   * Record what has just been queued.
   *
   * Written after the event reaches the queue and never before: a state file
   * updated ahead of a failed enqueue would mark a branch as sent that nobody
   * ever received, and nothing would ever offer it again.
   *
   * @param repository - Sanitized repository identity.
   * @param state - What was reported for it.
   */
  async write(repository: string, state: SnapshotState): Promise<void> {
    await writeFileAtomic(this.file(repository), JSON.stringify(state));
  }

  /**
   * Path of one repository's state file.
   *
   * @param repository - Sanitized repository identity.
   * @returns Absolute file path.
   */
  private file(repository: string): string {
    return path.join(this.snapshotsDir, `${sha256Hex(repository).slice(0, SNAPSHOT_STATE_HASH_LENGTH)}.json`);
  }
}

/**
 * Branch entries out of a stored record, ignoring anything malformed.
 *
 * @param value - The `branches` field as read from disk.
 * @returns Entries by branch name.
 */
function readEntries(value: unknown): Record<string, SnapshotStateEntry> {
  const record = asRecord(value);

  if (!record) return {};

  const entries: Record<string, SnapshotStateEntry> = {};

  for (const [name, raw] of Object.entries(record)) {
    const entry = asRecord(raw);

    if (!entry || typeof entry.headSha !== 'string') continue;

    entries[name] = {
      headSha: entry.headSha,
      lastSentAt: typeof entry.lastSentAt === 'number' ? entry.lastSentAt : 0
    };
  }

  return entries;
}

/**
 * The state of a repository nothing has been sent for.
 *
 * @returns An empty state, which selects every branch.
 */
function emptyState(): SnapshotState {
  return { branches: {} };
}
