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

/**
 * Who and where a snapshot is about: everything the event itself carries.
 *
 * Split from the flow's input so the builder cannot reach the git runner or the
 * deadline — a field named `identity` that also holds a subprocess launcher is
 * one a reader has to check rather than read.
 */
export interface SnapshotIdentity {
  readonly repository: string;
  readonly provider: string;
  readonly surface: string;
  readonly agentName: string;
  readonly developerId?: string;
  readonly installationId?: string;
  readonly sessionId?: string;
  readonly capturedAt: string;
}

/** Everything the snapshot flow needs to decide and build one event. */
export interface SnapshotFlowInput extends SnapshotIdentity {
  readonly cwd: string;
  readonly deadline: number;
  readonly run: GitRunner;
}

/** What the selection compares, and what the write-back records. */
export interface SelectionInput {
  readonly refs: readonly BranchRef[];
  readonly stored: SnapshotState;
  readonly defaultBranch?: string;
  readonly now: number;
}

/** Identity, base branch and the branches one event describes. */
export interface BuildSnapshotInput {
  readonly identity: SnapshotIdentity;
  readonly defaultBranch?: string;
  readonly branches: readonly SnapshotBranch[];
}

/** Everything one run of the flow needs beyond its own state. */
export interface SnapshotPipelineInput {
  readonly input: SnapshotFlowInput;
  readonly store: SnapshotStateReader;
  readonly queue: SnapshotQueue;
}

/** State threaded through the snapshot flow's stages. */
export interface SnapshotFlowState {
  readonly input: SnapshotFlowInput;
  readonly store: SnapshotStateReader;
  readonly queue: SnapshotQueue;
  /** The budgeted runner every stage uses; built once, where the budget is set. */
  readonly run: GitRunner;
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
