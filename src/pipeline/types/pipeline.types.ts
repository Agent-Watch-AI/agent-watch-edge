import type { AgentWatchConfig } from '../../config/types/config.types.js';
import type { Env } from '../../core/types/core.types.js';
import type { AgentWatchEvent } from '../../events/types/events.types.js';
import type { AgentProvider } from '../../providers/types/provider.types.js';
import type { AgentWatchPaths } from '../../storage/types/storage.types.js';
import type { TurnSummaryEvent } from '../../turns/types/turn-summary.types.js';
import type { DeliveryOutcome } from '../../transport/types/transport.types.js';

/** Everything the hook flow needs to start. */
export interface HookPipelineInput {
  readonly provider: AgentProvider;
  readonly env: Env;
  readonly paths: AgentWatchPaths;
  /** The machine-global configuration, before the repository overlay. */
  readonly globalConfig: AgentWatchConfig;
  /** Decoded hook payload. */
  readonly payload: unknown;
  /** Preview only: append nothing, consume nothing, send nothing. */
  readonly dryRun: boolean;
}

/**
 * The state every stage of the hook flow reads and extends.
 *
 * One immutable value threaded through the stages, so each stage is a pure
 * function of what came before it and the flow reads top to bottom.
 */
export interface HookPipelineState extends HookPipelineInput {
  /** Where the payload happened; resolved in the first stage. */
  readonly cwd: string;
  /** Global config with the repository overlay applied. */
  readonly config: AgentWatchConfig;
  /** Canonical events the provider adapter produced. */
  readonly events: readonly AgentWatchEvent[];
  /** The turn summary, when this payload closed a turn. */
  readonly summary?: TurnSummaryEvent;
  /** Records this run intends to send; empty on a dry run. */
  readonly outbound: readonly TurnSummaryEvent[];
  /** What delivery did, when it ran.  */
  readonly delivery?: DeliveryOutcome;
}
