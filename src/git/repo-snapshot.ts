import {
  ASSUMED_DEFAULT_BRANCHES,
  GIT_FIELD_SEPARATOR,
  GIT_ORIGIN_HEAD_ARGS,
  GIT_TIMEOUT_MS,
  gitBranchDeltaArgs,
  gitRecentBranchesArgs,
  gitVerifyRefArgs
} from './constants/git.constants.js';
import type { GitRunner } from './types/git.types.js';
import type { BranchCommit, BranchRef, CollectCommitsOptions, CollectRefsOptions } from './types/snapshot.types.js';

export type { BranchCommit, BranchRef, SnapshotBranch } from './types/snapshot.types.js';

/** `origin/HEAD` is reported as `origin/main`; the branch is what comes after. */
const REMOTE_PREFIX = 'origin/';

/**
 * The recently committed branches and their heads, in one git process.
 *
 * Deliberately separate from {@link collectBranchCommits}: the heads are what
 * the cache diff needs, and running the per-branch logs before that diff would
 * spend ten processes on every closing turn to discover that nothing changed.
 *
 * @param options - Where to look and how many branches to take.
 * @param run - Git runner; injectable for tests.
 * @returns The branches, newest commit first. Empty outside a repository.
 */
export async function collectBranchRefs(options: CollectRefsOptions, run: GitRunner): Promise<BranchRef[]> {
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const output = await run(gitRecentBranchesArgs(options.branchCount), options.cwd, timeoutMs);

  if (!output) return [];

  return output
    .split('\n')
    .map((line) => parseBranchRef(line))
    .filter((ref): ref is BranchRef => ref !== undefined);
}

/**
 * What this repository calls its trunk.
 *
 * `origin/HEAD` first, because it is what the remote says; a local `main` or
 * `master` second, for a clone that never fetched the symbolic ref. Undefined
 * when neither answers — and undefined is meaningful, not a failure: a branch
 * with no base to subtract is sent with no commits rather than with the
 * repository's whole history.
 *
 * @param cwd - Repository directory.
 * @param run - Git runner.
 * @param timeoutMs - Budget per git process.
 * @returns The default branch name, or undefined.
 */
export async function resolveDefaultBranch(cwd: string, run: GitRunner, timeoutMs = GIT_TIMEOUT_MS): Promise<string | undefined> {
  const origin = await run(GIT_ORIGIN_HEAD_ARGS, cwd, timeoutMs);

  if (origin) return origin.startsWith(REMOTE_PREFIX) ? origin.slice(REMOTE_PREFIX.length) : origin;

  for (const candidate of ASSUMED_DEFAULT_BRANCHES) {
    if (await run(gitVerifyRefArgs(candidate), cwd, timeoutMs)) return candidate;
  }

  return undefined;
}

/**
 * The commits one branch has that its default branch does not.
 *
 * @param branch - Branch to describe.
 * @param options - Base branch, cap and budget.
 * @param run - Git runner.
 * @returns The delta commits, newest first. Empty when there is no base to
 *   subtract, which is the honest answer: the alternative is reporting the
 *   trunk's commits as this branch's work.
 */
export async function collectBranchCommits(
  branch: string,
  options: CollectCommitsOptions,
  run: GitRunner
): Promise<BranchCommit[]> {
  if (!options.defaultBranch || options.defaultBranch === branch) return [];

  const output = await run(
    gitBranchDeltaArgs(options.defaultBranch, branch, options.commitCount),
    options.cwd,
    options.timeoutMs ?? GIT_TIMEOUT_MS
  );

  if (!output) return [];

  return output
    .split('\n')
    .map((line) => parseCommit(line))
    .filter((commit): commit is BranchCommit => commit !== undefined);
}

/**
 * One `for-each-ref` record.
 *
 * @param line - `name<sep>sha<sep>date`.
 * @returns The branch, or undefined for a line missing a name or a head.
 */
function parseBranchRef(line: string): BranchRef | undefined {
  const [name, headSha, lastCommitAt] = line.split(GIT_FIELD_SEPARATOR);

  if (!name || !headSha) return undefined;

  return { name, headSha, lastCommitAt: lastCommitAt || undefined };
}

/**
 * One `log` record.
 *
 * A commit with an empty subject is dropped rather than sent: an empty title is
 * nothing for the grouping agent to read, and a work unit standing for it would
 * be a row with no content.
 *
 * @param line - `sha<sep>subject<sep>date`.
 * @returns The commit, or undefined for a line carrying no subject.
 */
function parseCommit(line: string): BranchCommit | undefined {
  const [sha, subject, authoredAt] = line.split(GIT_FIELD_SEPARATOR);

  if (!sha || !subject) return undefined;

  return { sha, subject, authoredAt: authoredAt || undefined };
}
