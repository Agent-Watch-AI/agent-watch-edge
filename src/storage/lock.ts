import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { LOCK_ACQUIRE_ATTEMPTS, STALE_LOCK_MS } from './constants/storage.constants.js';
import type { ReleaseLock } from './types/storage.types.js';

export type { ReleaseLock } from './types/storage.types.js';

/**
 * Best-effort advisory lock built on `O_CREAT|O_EXCL`.
 *
 * Hook processes are short-lived and can die abruptly, so a lock older than
 * STALE_LOCK_MS is broken and retried once — otherwise one crashed hook would
 * stall every later one for good.
 *
 * @param locksDir - Directory lock files live in; created if absent.
 * @param name - Lock name; one file per name.
 * @param now - Clock, injectable for tests.
 * @returns A release function, or undefined when the lock is held elsewhere.
 */
export async function acquireLock(locksDir: string, name: string, now: () => Date = () => new Date()): Promise<ReleaseLock | undefined> {
  await fs.mkdir(locksDir, { recursive: true });

  const lockPath = path.join(locksDir, `${name}.lock`);

  for (let attempt = 0; attempt < LOCK_ACQUIRE_ATTEMPTS; attempt++) {
    const acquired = await tryCreateLock(lockPath, now);

    if (acquired === 'held') return () => fs.rm(lockPath, { force: true });

    if (acquired === 'taken') return undefined;
  }

  return undefined;
}

/**
 * One attempt at creating the lock file, breaking it when it is stale.
 *
 * @param lockPath - Lock file path.
 * @param now - Clock used for the stamp and the staleness check.
 * @returns `held` on success, `taken` when someone else owns a fresh lock,
 *   `retry` when a stale lock was broken and the caller should try again.
 */
async function tryCreateLock(lockPath: string, now: () => Date): Promise<'held' | 'taken' | 'retry'> {
  try {
    const handle = await fs.open(lockPath, 'wx');

    await handle.writeFile(JSON.stringify({ pid: process.pid, at: now().toISOString() }));
    await handle.close();

    return 'held';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

    return breakIfStale(lockPath, now);
  }
}

/**
 * Remove a lock whose owner is presumed dead.
 *
 * @param lockPath - Lock file path.
 * @param now - Clock the age is measured against.
 * @returns `retry` when the lock was broken or vanished, `taken` when it is
 *   still fresh.
 */
async function breakIfStale(lockPath: string, now: () => Date): Promise<'taken' | 'retry'> {
  try {
    const stat = await fs.stat(lockPath);

    if (now().getTime() - stat.mtimeMs <= STALE_LOCK_MS) return 'taken';

    await fs.rm(lockPath, { force: true });

    return 'retry';
  } catch {
    // The lock vanished between open and stat; the next attempt can have it.
    return 'retry';
  }
}
