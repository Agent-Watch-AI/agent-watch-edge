import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { debugLog } from '../core/logger.js';
import {
  IDENTITY_FINGERPRINT_CHARS,
  QUEUE_FILE_SUFFIX,
  UNATTRIBUTED_PARTITION,
  UNCONFIGURED_PARTITION
} from './constants/transport.constants.js';

export { UNATTRIBUTED_PARTITION, UNCONFIGURED_PARTITION } from './constants/transport.constants.js';

/**
 * The queue directory one identity owns.
 *
 * A queue entry records a destination but never a bearer, so a single flat
 * directory lets whichever hook happens to drain it send every tenant's backlog
 * under its own token — the exact mis-attribution per-project roots exist to
 * prevent, and unreachable only while the machine has one identity. Giving each
 * identity its own directory makes a cross-tenant send impossible rather than
 * unlikely: a drain lists one partition and cannot see another. The cost is that
 * an idle tenant's backlog waits for that tenant's next hook, which is the right
 * trade — late is recoverable, mis-attributed is not.
 *
 * The name is a digest, not the token: this path appears in `ls`, in backups and
 * in every error message that quotes a file, none of which may carry a secret.
 * The queue bound in `delivery.maxQueueEvents` therefore applies per identity.
 *
 * @param queueRoot - The machine's queue directory.
 * @param token - Bearer this invocation would send with, when there is one.
 * @returns Absolute directory this identity may read and write.
 */
export function queuePartition(queueRoot: string, token: string | undefined): string {
  if (!token) return path.join(queueRoot, UNCONFIGURED_PARTITION);

  return path.join(queueRoot, createHash('sha256').update(token).digest('hex').slice(0, IDENTITY_FINGERPRINT_CHARS));
}

/**
 * Where a backlog nobody can claim waits for its owner to say what it is.
 *
 * @param queueRoot - The machine's queue directory.
 * @returns Absolute directory.
 */
export function unattributedQueue(queueRoot: string): string {
  return path.join(queueRoot, UNATTRIBUTED_PARTITION);
}

/**
 * How many entries are waiting there, so `status` and `doctor` can say so.
 *
 * @param queueRoot - The machine's queue directory.
 * @returns The entry count.
 */
export async function unattributedCount(queueRoot: string): Promise<number> {
  return (await entryNames(unattributedQueue(queueRoot))).length;
}

/**
 * Give the entries that belong to no partition a home, without guessing.
 *
 * Two sets qualify. A backlog written by a bridge that predates partitioning
 * sits loose in the queue root, and upgrading must neither strand it in a
 * directory nothing reads any more nor hand it to a tenant that may not own it.
 * A backlog written before setup sits in `unconfigured/` pinned to
 * ANY_DESTINATION, which is already a promise that the first identity
 * configured here takes it.
 *
 * Those two obligations only conflict when the machine already serves several
 * identities. When it serves one, that identity is provably the author of every
 * entry, so it adopts them and the upgrade is invisible. When it serves more,
 * the entries go to `unattributed/`, where they stay visible, intact and
 * delivered to nobody until the operator says whose they are — AGENTS.md's "when
 * ownership is unclear, refuse and tell the user", applied to a ledger rather
 * than to an agent config.
 *
 * Moving is a rename, which is atomic, so no lock is needed: a hook that loses
 * the race finds the entry already gone and moves on.
 *
 * @param queueRoot - The machine's queue directory.
 * @param token - Bearer this invocation would send with; without one there is
 *   no partition worth moving anything into yet.
 * @param sharedMachine - Whether other identities are configured here.
 * @returns How many entries were moved.
 */
export async function settleLegacyQueue(queueRoot: string, token: string | undefined, sharedMachine: boolean): Promise<number> {
  if (!token) return 0;

  const sources = [queueRoot, path.join(queueRoot, UNCONFIGURED_PARTITION)];
  const target = sharedMachine ? unattributedQueue(queueRoot) : queuePartition(queueRoot, token);
  let moved = 0;

  for (const source of sources) {
    moved += await drainInto(source, target);
  }

  if (moved > 0) debugLog(`queue: moved ${moved} unpartitioned entr(y|ies) to ${target}`);

  return moved;
}

/**
 * Move every entry of one directory into another, creating it on demand.
 *
 * @param source - Directory to empty.
 * @param target - Partition to fill.
 * @returns How many entries this call moved.
 */
async function drainInto(source: string, target: string): Promise<number> {
  const names = await entryNames(source);

  if (names.length === 0) return 0;

  await fs.mkdir(target, { recursive: true });

  let moved = 0;

  for (const name of names) {
    moved += await relocate(path.join(source, name), path.join(target, name));
  }

  return moved;
}

/**
 * Move one entry, treating a lost race as someone else's success.
 *
 * @param from - Current file.
 * @param to - Where it belongs.
 * @returns 1 when this call moved it, else 0.
 */
async function relocate(from: string, to: string): Promise<number> {
  try {
    await fs.rename(from, to);

    return 1;
  } catch {
    // A concurrent hook already claimed it, or it aged out from under us.
    // Either way it is not this call's to move and not this call's to lose.
    return 0;
  }
}

/**
 * Queue entry filenames directly in a directory; sub-directories are other
 * identities' partitions and never entries.
 *
 * @param dir - Directory to list.
 * @returns The names, or an empty list when the directory is absent.
 */
async function entryNames(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).filter((name) => name.endsWith(QUEUE_FILE_SUFFIX));
  } catch {
    return [];
  }
}
