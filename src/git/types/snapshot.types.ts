/** One branch as `for-each-ref` reported it, before any log ran. */
export interface BranchRef {
  readonly name: string;
  readonly headSha: string;
  readonly lastCommitAt?: string;
}

/** One commit in a branch's delta against its default branch. */
export interface BranchCommit {
  readonly sha: string;
  readonly subject: string;
  readonly authoredAt?: string;
}

/** A branch with the commits that are its own. */
export interface SnapshotBranch extends BranchRef {
  readonly commits: readonly BranchCommit[];
}

export interface CollectRefsOptions {
  readonly cwd: string;
  readonly branchCount: number;
}

export interface CollectCommitsOptions {
  readonly cwd: string;
  readonly defaultBranch?: string;
  readonly commitCount: number;
}
