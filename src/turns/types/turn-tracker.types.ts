import type { AgentWatchConfig, ConfigLoadResult } from '../../config/types/config.types.js';
import type { Env } from '../../core/types/core.types.js';
import type { AgentWatchEvent } from '../../events/types/events.types.js';
import type { AgentWatchPaths } from '../../storage/types/storage.types.js';

export interface TrackTurnOptions {
  readonly agentId: string;
  /** Raw provider payload; source of the transcript path. */
  readonly rawPayload: unknown;
  /** Enriched + sanitized canonical events produced from this payload. */
  readonly events: readonly AgentWatchEvent[];
  readonly config: AgentWatchConfig;
  /**
   * The machine-global config as loaded, roots intact. `config` is the start
   * folder's effective config with its roots stripped, and a session started
   * above its repositories needs both: which tenant each repository beneath the
   * start folder belongs to, and that repository's own `.agentwatch.json`.
   */
  readonly globalConfig: ConfigLoadResult;
  readonly paths: AgentWatchPaths;
  readonly turnsDir: string;
  readonly locksDir: string;
  readonly env: Env;
  readonly cwd: string;
  /** Preview a Stop without appending, consuming, claiming, or sweeping state. */
  readonly readOnly?: boolean;
}

/** The window a closing turn may claim transcript usage from. */
export interface TurnWindow {
  readonly startedAt?: string;
  /**
   * Upper bound for transcript entries. Cut at the next prompt's start when
   * one raced into our window: those tokens belong to (and are counted by)
   * that turn, which is what keeps attribution exactly-once.
   */
  readonly untilIso: string;
}
