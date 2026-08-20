import fs from 'node:fs/promises';
import { asRecord } from '../core/object.js';
import { writeFileAtomic } from '../storage/atomic-file.js';
import { SECRET_FILE_MODE } from '../storage/constants/storage.constants.js';

/**
 * Persisted circuit breaker for the in-hook direct send.
 *
 * Hooks are separate short-lived processes, so "the backend is down" has to live
 * on disk: after a failed send, later hooks skip the direct attempt — and its
 * timeout — entirely until the cooldown expires, queueing events instead. In
 * memory this signal would be forgotten before the next hook even started.
 */
export class BackendCooldown {
  /**
   * Bind the breaker to its state file.
   *
   * @param file - Where the cooldown deadline is persisted.
   * @param now - Clock, injectable for tests.
   */
  constructor(
    private readonly file: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  /**
   * Whether direct sends should currently be skipped.
   *
   * @returns True while the cooldown is in force.
   */
  async active(): Promise<boolean> {
    try {
      const until = asRecord(JSON.parse(await fs.readFile(this.file, 'utf8')))?.['until'];

      return typeof until === 'number' && until > this.now().getTime();
    } catch {
      // No file, or one we cannot read: assume the backend is healthy. Failing
      // open here costs one timeout; failing closed would silence telemetry.
      return false;
    }
  }

  /**
   * Start a cooldown.
   *
   * @param durationMs - How long to skip direct sends for.
   */
  async trip(durationMs: number): Promise<void> {
    try {
      await writeFileAtomic(this.file, JSON.stringify({ until: this.now().getTime() + durationMs }), SECRET_FILE_MODE);
    } catch {
      // The cooldown is an optimization; failing to persist it must not break
      // the hook.
    }
  }

  /**
   * End the cooldown after a successful send.
   */
  async clear(): Promise<void> {
    await fs.rm(this.file, { force: true });
  }
}
