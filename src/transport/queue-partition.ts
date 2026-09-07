import fs from 'node:fs/promises';
import path from 'node:path';
import { debugLog } from '../core/logger.js';
import { sha256Hex } from '../events/event-id.js';
import type { AgentWatchPaths } from '../storage/types/storage.types.js';
import {
  COOLDOWN_FILE_NAME,
  DELIVERY_STATS_FILE_NAME,
  IDENTITY_FINGERPRINT_CHARS,
  IDENTITY_STATE_DIR_NAME,
  UNATTRIBUTED_PARTITION,
  UNCONFIGURED_PARTITION
} from './constants/transport.constants.js';
import { listQueueFiles } from './queue.js';

/** Everything on disk that belongs to one identity's delivery. */
export interface IdentityPaths {
  /** Its queue partition. */
  readonly queueDir: string;
  /** Its backend circuit breaker. */
  readonly cooldownFile: string;
  /** Its permanent-loss tally. */
  readonly statsFile: string;
}

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
  return path.join(queueRoot, partitionName(token));
}

/**
 * Where one identity's delivery lives: queue partition, backend cooldown and
 * loss tally. All three per identity for the same reason — one tenant's backend
 * outage must not put the other tenant's hooks into cooldown, and `status` must
 * not report two tenants' losses as one number.
 *
 * @param paths - The machine's paths.
 * @param token - Bearer this invocation would send with, when there is one.
 * @returns Absolute paths for this identity.
 */
export function identityPaths(paths: AgentWatchPaths, token: string | undefined): IdentityPaths {
  const stateDir = path.join(paths.dataDir, IDENTITY_STATE_DIR_NAME, partitionName(token));

  return {
    queueDir: queuePartition(paths.queueDir, token),
    cooldownFile: path.join(stateDir, COOLDOWN_FILE_NAME),
    statsFile: path.join(stateDir, DELIVERY_STATS_FILE_NAME)
  };
}

/**
 * The directory name standing for one identity.
 *
 * @param token - Bearer, when there is one.
 * @returns A digest prefix, or the shared name for "no token yet".
 */
function partitionName(token: string | undefined): string {
  if (!token) return UNCONFIGURED_PARTITION;

  return sha256Hex(token).slice(0, IDENTITY_FINGERPRINT_CHARS);
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
  return (await listQueueFiles(unattributedQueue(queueRoot))).length;
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

  const target = sharedMachine ? unattributedQueue(queueRoot) : queuePartition(queueRoot, token);
  const sources = [queueRoot, path.join(queueRoot, UNCONFIGURED_PARTITION)];
  const moved = (await Promise.all(sources.map((source) => moveEntries(source, target)))).reduce((sum, n) => sum + n, 0);

  if (moved > 0) debugLog(`queue: moved ${moved} unpartitioned entr(y|ies) to ${target}`);

  return moved;
}

/**
 * Move every entry of one directory into another, creating it on demand. A
 * rename that fails is a race lost to a concurrent hook, or an entry that aged
 * out from under us: either way not this call's to move and not its to lose.
 *
 * @param source - Directory to empty.
 * @param target - Partition to fill.
 * @returns How many entries this call moved.
 */
async function moveEntries(source: string, target: string): Promise<number> {
  const names = await listQueueFiles(source);

  if (names.length === 0) return 0;

  await fs.mkdir(target, { recursive: true });

  let moved = 0;

  for (const name of names) {
    try {
      await fs.rename(path.join(source, name), path.join(target, name));
      moved++;
    } catch {
      // Claimed by a concurrent hook, or gone.
    }
  }

  return moved;
}
