import type { AgentWatchConfig } from '../../config/types/config.types.js';

export interface EnrichOptions {
  readonly config: AgentWatchConfig;
  /** Working directory reported by the agent's hook payload. */
  readonly cwd: string;
  /** Developer home directory; rewritten to `~` inside captured content. */
  readonly home?: string;
  readonly gitTimeoutMs?: number;
}

/** One literal-to-placeholder substitution applied to captured text. */
export interface PathRule {
  readonly pattern: RegExp;
  readonly replacement: string;
}

/**
 * Pre-compiled path substitutions for one enrichment pass.
 *
 * Built once per call and reused for every string of every event: the rules
 * depend only on the repository root and the home directory, and compiling
 * them per string is what made path rewriting the most expensive part of the
 * hook (STYLEGUIDE 3.1).
 */
export interface PathRewriter {
  readonly rules: readonly PathRule[];
}
