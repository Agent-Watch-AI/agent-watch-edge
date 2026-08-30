import type { z } from 'zod';
import type { agentInstallSchema, installStateSchema } from '../schemas/storage.schema.js';

/** Every filesystem location AgentWatch owns, derived once per command. */
export interface AgentWatchPaths {
  /** Configuration (endpoint, token, capture flags). */
  readonly configDir: string;
  readonly configFile: string;
  /** Record of exactly what setup wrote into agent configs. */
  readonly installStateFile: string;
  /** Mutable state: queue, locks, backups. */
  readonly dataDir: string;
  readonly queueDir: string;
  readonly locksDir: string;
  readonly backupsDir: string;
  /** Per-session accumulator state for turn summaries. */
  readonly turnsDir: string;
  /** Per-repository record of the last snapshot sent, so the next one is a diff. */
  readonly snapshotsDir: string;
}

/**
 * Outcome of a tolerant JSON read. `missing` and `invalid` are distinct on
 * purpose: a file we cannot parse must never be overwritten.
 */
export type JsonReadResult =
  | { readonly state: 'missing' }
  | { readonly state: 'invalid'; readonly error: string }
  | { readonly state: 'ok'; readonly value: unknown };

/** Releases a held advisory lock. */
export type ReleaseLock = () => Promise<void>;

export type AgentInstallState = z.infer<typeof agentInstallSchema>;
export type InstallState = z.infer<typeof installStateSchema>;
