import type { AgentWatchConfig, CaptureConfig, ConfigLoadResult } from '../../config/types/config.types.js';
import type { FailOpenReason } from '../../enforcement/types/enforcement.types.js';
import type { Env } from '../../core/types/core.types.js';
import type { AgentWatchEvent } from '../../events/types/events.types.js';
import type { AgentWatchPaths } from '../../storage/types/storage.types.js';
import type { TurnSummaryEvent } from './turn-summary.types.js';

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
  /** Why this payload's prompt was allowed without a decision, when it was. */
  readonly failOpenReason?: FailOpenReason;
  /** Real roots of the checkouts this payload's shell command named; roots only. */
  readonly nominations?: readonly string[];
}

/** What one hook payload did to its turn. */
export interface TurnOutcome {
  /** The summary, when this payload closed a turn. */
  readonly summary?: TurnSummaryEvent;
  /** Local root of the checkout that summary reported. Never sent. */
  readonly workRoot?: string;
  /** That checkout's own capture policy, when it is not the hook folder's. */
  readonly capture?: CaptureConfig;
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
