import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const STALE_LOCK_MS = 30_000;

/**
 * Best-effort advisory lock using O_CREAT|O_EXCL. Short-lived hook processes
 * can die abruptly, so locks older than STALE_LOCK_MS are broken.
 * Returns a release function, or undefined if the lock is held elsewhere.
 */
export async function acquireLock(locksDir: string, name: string, now: () => Date = () => new Date()): Promise<(() => Promise<void>) | undefined> {
  await fs.mkdir(locksDir, { recursive: true });
  const lockPath = path.join(locksDir, `${name}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: now().toISOString() }));
      await handle.close();
      return async () => {
        await fs.rm(lockPath, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const stat = await fs.stat(lockPath);
        if (now().getTime() - stat.mtimeMs > STALE_LOCK_MS) {
          await fs.rm(lockPath, { force: true });
          continue; // retry once after breaking a stale lock
        }
      } catch {
        continue; // lock vanished between open and stat; retry
      }
      return undefined;
    }
  }
  return undefined;
}
