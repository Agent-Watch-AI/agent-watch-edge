import fs from 'node:fs/promises';
import { asRecord } from '../core/object.js';
import { writeFileAtomic } from '../storage/atomic-file.js';
import { SECRET_FILE_MODE } from '../storage/constants/storage.constants.js';
import type { AuthBlockState } from './types/transport.types.js';

/**
 * Persisted "this credential is rejected" flag for one identity.
 *
 * The state file lives in the identity's own state directory, whose name is
 * already the token digest, so the block is keyed by
 * `(destination, credential fingerprint)` without ever storing the token: a new
 * token lands in a different directory and a new endpoint fails the destination
 * check, which is exactly the "a change of fingerprint lifts the block" rule.
 *
 * It does **not** expire on a timer. A revoked token does not become valid by
 * waiting, and a timer is how a rejected credential stayed invisible for a week
 * of hooks in the first place. What the block stops is the *retrying*; the
 * records themselves stay queued, unconditionally.
 */
export class BackendAuthBlock {
  /**
   * Bind the block to its state file.
   *
   * @param file - Where the block is persisted.
   * @param now - Clock, injectable for tests.
   */
  constructor(
    private readonly file: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  /**
   * The block standing against one destination, if any.
   *
   * @param destination - The events URL this invocation would send to.
   * @returns The block, or undefined when sends may proceed.
   */
  async active(destination: string): Promise<AuthBlockState | undefined> {
    const block = await this.read();

    if (!block || block.destination !== destination) return undefined;

    return block;
  }

  /**
   * Record that this destination refused the credential.
   *
   * A block already standing for the same destination keeps its original
   * `since`: an administrator needs to know when the refusals started, not when
   * the last hook ran.
   *
   * @param destination - The events URL that refused.
   * @param status - The refusing HTTP status.
   */
  async raise(destination: string, status: number): Promise<void> {
    const standing = await this.active(destination);
    const block: AuthBlockState = {
      destination,
      status,
      since: standing?.since ?? this.now().toISOString()
    };

    try {
      await writeFileAtomic(this.file, JSON.stringify(block), SECRET_FILE_MODE);
    } catch {
      // Same rule as the cooldown: this runs on the hook path, and failing to
      // persist a diagnosis must never fail the agent's turn.
    }
  }

  /**
   * Lift the block — the backend accepted the credential.
   */
  async clear(): Promise<void> {
    try {
      await fs.rm(this.file, { force: true });
    } catch {
      // Awaited between a proven-good credential and the drain: a failure to
      // remove the file must not abort the pass that would empty the backlog.
    }
  }

  /**
   * The persisted block, whatever destination it names.
   *
   * @returns The block, or undefined when there is none to read.
   */
  private async read(): Promise<AuthBlockState | undefined> {
    try {
      const raw = asRecord(JSON.parse(await fs.readFile(this.file, 'utf8')));

      if (typeof raw?.['destination'] !== 'string' || typeof raw['status'] !== 'number' || typeof raw['since'] !== 'string') return undefined;

      return { destination: raw['destination'], status: raw['status'], since: raw['since'] };
    } catch {
      // No file, or one we cannot read: assume the credential is good. Failing
      // open costs one refused send; failing closed would silence telemetry on
      // an install that is working.
      return undefined;
    }
  }
}
