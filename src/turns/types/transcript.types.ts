/** Token usage read out of an agent's own transcript. */
export interface TurnUsage {
  readonly model?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  /** Transcript message ids summed into this usage; the exactly-once ledger. */
  readonly messageIds?: readonly string[];
}

/**
 * How hard to try before trusting a transcript snapshot.
 *
 * Agents flush their transcript asynchronously, so the final assistant entry
 * may not be on disk when the Stop hook fires.
 */
export interface ReadTurnUsageRetry {
  /** Total read attempts, including the first one. */
  readonly attempts: number;
  readonly delayMs: number;
  /**
   * A stable snapshot is only trusted after this much time has passed: early
   * usage in a multi-tool turn stabilizes instantly while the final entry may
   * still be seconds away.
   */
  readonly minSettleMs?: number;
}

/**
 * Reads one turn's usage from a provider transcript.
 *
 * @param transcriptPath - Path the provider reported.
 * @param startedAt - ISO timestamp the turn began at.
 * @param untilIso - Upper bound; entries after it belong to another turn.
 * @param excludeMessageIds - Messages another turn has already claimed.
 */
export type TranscriptReader = (
  transcriptPath: string,
  startedAt: string,
  untilIso: string,
  excludeMessageIds: ReadonlySet<string>
) => Promise<TurnUsage | undefined>;

/** One assistant entry's usage, keyed by message id during accumulation. */
export interface TranscriptUsageEntry {
  readonly model?: string;
  readonly usage: Readonly<Record<string, unknown>>;
}
