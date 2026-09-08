import fs from 'node:fs/promises';
import { writeFileAtomic } from './atomic-file.js';
import { SECRET_FILE_MODE } from './constants/storage.constants.js';

/**
 * Whether a periodic cleanup is due, claiming it when it is.
 *
 * Both sweeps this gates — expired session state and expired queue entries —
 * cost a directory walk plus a `stat` per file, and both run on the coding
 * agent's hook path, where they were paid on *every* closing turn to discover
 * that nothing had aged out yet. The marker's own mtime is the whole clock: one
 * `stat` on the common path.
 *
 * Deliberately unlocked. Two hooks can both decide a sweep is due and both run
 * it; every removal a sweep makes is idempotent, so the cost of the race is one
 * redundant walk and the cost of a lock would be paid on every hook.
 *
 * @param marker - File whose mtime records the last sweep.
 * @param intervalMs - Minimum gap between sweeps.
 * @param nowMs - This invocation's clock reading.
 * @returns True when the caller should sweep now.
 */
export async function claimSweep(marker: string, intervalMs: number, nowMs: number): Promise<boolean> {
  const last = await lastSweptMs(marker);

  if (last !== undefined && nowMs - last < intervalMs) return false;

  try {
    // Through the same write every other file in the state directory uses: it
    // renames a 0600 temp file over the target, so a marker somebody
    // pre-created as a symlink is replaced rather than followed, and the state
    // root — which `AGENTWATCH_DATA_DIR` can point at a shared temp directory —
    // never holds a default-mode file this package created.
    await writeFileAtomic(marker, '', SECRET_FILE_MODE);

    return true;
  } catch {
    // The state directory is unwritable, which every other write will report.
    // Sweeping anyway would then run on every hook, which is the cost this
    // exists to remove.
    return false;
  }
}

/**
 * When the last sweep finished, by the marker's mtime.
 *
 * @param marker - The marker file.
 * @returns Epoch milliseconds, or undefined when nothing has swept yet.
 */
async function lastSweptMs(marker: string): Promise<number | undefined> {
  try {
    return (await fs.stat(marker)).mtimeMs;
  } catch {
    return undefined;
  }
}
