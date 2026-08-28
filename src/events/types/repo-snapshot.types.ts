import type { AgentWatchEvent } from './events.types.js';

/** One commit of a branch's delta, as the backend receives it. */
export interface RepoSnapshotCommit {
  readonly sha: string;
  readonly subject: string;
  readonly authored_at?: string;
}

/** One branch of a snapshot, with the commits that are its own. */
export interface RepoSnapshotBranch {
  readonly name: string;
  readonly head_sha: string;
  readonly last_commit_at?: string;
  readonly commits: readonly RepoSnapshotCommit[];
}

/**
 * What one repository looked like on this machine at one moment.
 *
 * The third product record, and the only one that is not about spend: it is
 * what lets a backend with no tracker connected know that a piece of work
 * exists at all. Sent only when something changed, so a quiet repository costs
 * nothing.
 */
export interface RepoSnapshotEvent extends AgentWatchEvent<'repo.snapshot'> {
  readonly provider: string;
  readonly surface: string;
  readonly repository: string;
  readonly developer_id?: string;
  readonly default_branch?: string;
  /** When the working copy was read. The backend orders snapshots by this. */
  readonly captured_at: string;
  readonly branches: readonly RepoSnapshotBranch[];
}
