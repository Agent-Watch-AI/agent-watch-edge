import fs from 'node:fs/promises';
import { writeFileAtomic } from '../storage/atomic-file.js';

/**
 * Persisted circuit breaker for the in-hook direct send. Hooks are separate
 * short-lived processes, so the "backend is down" signal must live on disk:
 * after a failed send, subsequent hooks skip the direct attempt (and its
 * timeout) entirely until the cooldown expires, queueing events instead.
 */
export class BackendCooldown {
  constructor(
    private readonly file: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  async active(): Promise<boolean> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8')) as { until?: unknown };
      return typeof raw.until === 'number' && raw.until > this.now().getTime();
    } catch {
      return false;
    }
  }

  async trip(durationMs: number): Promise<void> {
    try {
      await writeFileAtomic(this.file, JSON.stringify({ until: this.now().getTime() + durationMs }), 0o600);
    } catch {
      // Cooldown is an optimization; failing to persist it must not break the hook.
    }
  }

  async clear(): Promise<void> {
    await fs.rm(this.file, { force: true });
  }
}
