import type { RepoSnapshotEvent } from '../../events/types/repo-snapshot.types.js';
import type { BranchRef, SnapshotBranch } from '../../git/types/snapshot.types.js';
import type { GitRunner } from '../../git/types/git.types.js';

/** What was last reported about one branch. */
export interface SnapshotStateEntry {
  readonly headSha: string;
  /** Epoch milliseconds, so an unchanged branch is still re-offered eventually. */
  readonly lastSentAt: number;
}

/** What was last reported about one repository. */
export interface SnapshotState {
  /**
   * The default branch the last send computed its deltas against.
   *
   * Part of the state, not incidental: a clone that could not name its trunk
   * sent every branch with no commits, and once `origin/HEAD` appears those
   * branches have to be re-sent even though no head moved.
   */
  readonly defaultBranch?: string;
  readonly branches: Record<string, SnapshotStateEntry>;
}

/** Everything the snapshot flow needs to decide and build one event. */
export interface SnapshotFlowInput {
  readonly cwd: string;
  readonly repository: string;
  readonly provider: string;
  readonly surface: string;
  readonly agentName: string;
  readonly developerId?: string;
  readonly installationId?: string;
  readonly sessionId?: string;
  readonly capturedAt: string;
  readonly deadline: number;
  readonly run: GitRunner;
}

/** State threaded through the snapshot flow's stages. */
export interface SnapshotFlowState {
  readonly input: SnapshotFlowInput;
  readonly store: SnapshotStateReader;
  readonly queue: SnapshotQueue;
  readonly stored?: SnapshotState;
  readonly defaultBranch?: string;
  readonly refs: readonly BranchRef[];
  readonly selected: readonly BranchRef[];
  readonly branches: readonly SnapshotBranch[];
  readonly event?: RepoSnapshotEvent;
}

/** The cache the flow reads and writes; narrowed so tests need no filesystem. */
export interface SnapshotStateReader {
  read(repository: string): Promise<SnapshotState>;
  write(repository: string, state: SnapshotState): Promise<void>;
}

/** The one thing the flow asks of the offline queue. */
export interface SnapshotQueue {
  enqueue(events: readonly RepoSnapshotEvent[]): Promise<void>;
}
