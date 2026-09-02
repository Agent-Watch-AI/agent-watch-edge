import fs from 'node:fs/promises';
import path from 'node:path';
import { debugLog } from '../core/logger.js';
import { writeFileAtomic } from '../storage/atomic-file.js';
import { readJsonFile } from '../storage/json-file.js';
import { sha256Hex } from '../events/event-id.js';
import {
  GATE_BRANCH_REF_PREFIX,
  GATE_GITDIR_PREFIX,
  GATE_MAX_WALK_DEPTH,
  GATE_REMOTE_MEMO_DIR,
  GATE_REMOTE_MEMO_TTL_MS,
  GIT_REMOTE_ARGS,
  GIT_TIMEOUT_MS
} from './constants/git.constants.js';
import { runGit } from './git-context.js';
import { normalizeRemote } from './remote-sanitize.js';
import type { GateCheckout, GateCheckoutOptions, GitRunner } from './types/git.types.js';

export type { GateCheckout } from './types/git.types.js';

/**
 * Where a gated prompt is happening, as much of it as can be had cheaply.
 *
 * The platform needs a repository and a branch to judge a feature cap, and the
 * gate is the one place in this package measured in milliseconds: it runs before
 * any git context has been collected, between a developer pressing enter and
 * their agent starting. So this reads the working copy instead of asking git —
 * an upward walk for `.git`, then one small file — and pays for a subprocess
 * once per checkout rather than once per prompt.
 *
 * Both fields or neither. A branch alone identifies nothing, because every
 * repository has a `main`, and the platform drops a half-stated pair anyway.
 *
 * Never throws, and answers `undefined` for everything it cannot establish:
 * outside a repository, on a detached HEAD (which names no branch to charge), in
 * a repository with no usable remote, or on any read that fails. The turn is
 * then judged on the developer alone, exactly as it is today.
 *
 * @param options - Working directory, the data directory the memo lives in, and
 *   overrides for the timeout and the git runner.
 * @returns The checkout, or undefined.
 */
export async function readGateCheckout(options: GateCheckoutOptions): Promise<GateCheckout | undefined> {
  try {
    const gitDir = await findGitDir(options.cwd);

    if (!gitDir) return undefined;

    const branch = await readBranch(gitDir.gitDir);

    if (!branch) return undefined;

    const repository = await resolveRepository(gitDir.root, options);

    if (!repository) return undefined;

    return { repository, branch };
  } catch (error) {
    debugLog('gate checkout unavailable:', error);

    return undefined;
  }
}

/** A repository root and the git directory that serves it. */
interface GitLocation {
  readonly root: string;
  readonly gitDir: string;
}

/**
 * The nearest `.git` at or above a directory.
 *
 * A `.git` *file* rather than a directory is a linked worktree, and it names the
 * real git directory on its one line. Agents work in worktrees often enough that
 * not following it would silently drop the whole case.
 *
 * @param startDir - Directory the payload happened in.
 * @returns The location, or undefined outside a repository.
 */
async function findGitDir(startDir: string): Promise<GitLocation | undefined> {
  let dir = path.resolve(startDir);

  for (let depth = 0; depth < GATE_MAX_WALK_DEPTH; depth++) {
    const candidate = path.join(dir, '.git');
    const found = await readGitEntry(dir, candidate);

    if (found) return found;

    const parent = path.dirname(dir);

    if (parent === dir) return undefined;

    dir = parent;
  }

  return undefined;
}

/**
 * One candidate `.git`, as a directory or as a worktree's pointer file.
 *
 * @param root - The directory holding the candidate.
 * @param candidate - Path of the candidate itself.
 * @returns The location, or undefined when there is nothing usable here.
 */
async function readGitEntry(root: string, candidate: string): Promise<GitLocation | undefined> {
  let stat;

  try {
    stat = await fs.stat(candidate);
  } catch {
    // Not here, or not readable; keep walking.
    return undefined;
  }

  if (stat.isDirectory()) return { root, gitDir: candidate };

  if (!stat.isFile()) return undefined;

  const pointer = (await fs.readFile(candidate, 'utf8')).trim();

  if (!pointer.startsWith(GATE_GITDIR_PREFIX)) return undefined;

  const target = pointer.slice(GATE_GITDIR_PREFIX.length).trim();

  return { root, gitDir: path.resolve(root, target) };
}

/**
 * The checked-out branch, from `HEAD`.
 *
 * A symbolic ref names a branch; a bare object id is a detached HEAD, which is
 * work belonging to no branch and therefore to no feature.
 *
 * @param gitDir - The git directory serving this working copy.
 * @returns The branch, or undefined when HEAD names none.
 */
async function readBranch(gitDir: string): Promise<string | undefined> {
  const head = (await fs.readFile(path.join(gitDir, 'HEAD'), 'utf8')).trim();

  if (!head.startsWith(GATE_BRANCH_REF_PREFIX)) return undefined;

  return head.slice(GATE_BRANCH_REF_PREFIX.length).trim() || undefined;
}

/**
 * The repository's canonical name, memoised per checkout.
 *
 * The one subprocess here, and the reason it is bounded rather than permanent:
 * a remote changes approximately never, but `git remote set-url` does happen,
 * and a memo with no expiry would pin a checkout to its old repository for good.
 *
 * A memo that cannot be read or written costs a subprocess, never an answer.
 *
 * @param root - Repository root.
 * @param options - Data directory, timeout and runner overrides.
 * @returns The normalized remote, or undefined when there is none.
 */
async function resolveRepository(
  root: string,
  options: GateCheckoutOptions
): Promise<string | undefined> {
  const now = options.now?.().getTime() ?? Date.now();
  const file = memoFile(options.dataDir, root);
  const remembered = await readMemo(file, now);

  if (remembered) return remembered;

  const run: GitRunner = options.run ?? runGit;
  const raw = await run(GIT_REMOTE_ARGS, root, options.timeoutMs ?? GIT_TIMEOUT_MS);
  const repository = raw ? normalizeRemote(raw) : undefined;

  if (!repository) return undefined;

  await writeMemo(file, repository, now);

  return repository;
}

/**
 * Where one checkout's remote is remembered.
 *
 * Hashed: a root is an absolute path and would otherwise put the developer's
 * directory layout in a filename.
 *
 * @param dataDir - The collector's data directory.
 * @param root - Repository root.
 * @returns Absolute file path.
 */
function memoFile(dataDir: string, root: string): string {
  return path.join(dataDir, GATE_REMOTE_MEMO_DIR, `${sha256Hex(root)}.json`);
}

/**
 * The remembered remote, when it is still young enough to use.
 *
 * @param file - Memo file.
 * @param now - Epoch milliseconds.
 * @returns The remote, or undefined on a miss.
 */
async function readMemo(file: string, now: number): Promise<string | undefined> {
  const read = await readJsonFile(file);

  if (read.state !== 'ok' || typeof read.value !== 'object' || read.value === null) return undefined;

  const entry = read.value as { repository?: unknown; at?: unknown };

  if (typeof entry.repository !== 'string' || typeof entry.at !== 'number') return undefined;

  if (now - entry.at > GATE_REMOTE_MEMO_TTL_MS) return undefined;

  return entry.repository;
}

/**
 * Remember one checkout's remote.
 *
 * @param file - Memo file.
 * @param repository - The normalized remote.
 * @param now - Epoch milliseconds.
 */
async function writeMemo(file: string, repository: string, now: number): Promise<void> {
  try {
    await writeFileAtomic(file, JSON.stringify({ repository, at: now }));
  } catch (error) {
    // A remote that cannot be remembered is still a remote.
    debugLog('could not remember the checkout remote:', error);
  }
}
