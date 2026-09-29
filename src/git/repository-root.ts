import fs from 'node:fs/promises';
import path from 'node:path';
import { GIT_ENTRY_ABSENT_CODES, GIT_ENTRY_NAME } from './constants/git.constants.js';
import type { RepositoryRootFinder } from './types/repository-root.types.js';

export type { RepositoryRootFinder } from './types/repository-root.types.js';

/**
 * A finder for the repository each file belongs to, when the session's own
 * folder is not one.
 *
 * Bounded by `boundary` — the folder the session started in — for two reasons:
 * a repository outside it is another project's, possibly another tenant's, and
 * a bounded walk is a handful of `stat` calls rather than an unbounded climb to
 * the filesystem root.
 *
 * ponytail: presence of a `.git` entry is the whole test, and the answer is the
 * *nearest* ancestor that has one — so a file inside a submodule or a vendored
 * checkout belongs to that inner repository, which is also what git itself
 * would answer from that directory. It does not understand `GIT_DIR`, a bare
 * repository, or a `.git` file pointing outside the tree. The upgrade path is
 * `git rev-parse --show-toplevel` behind this same cache — deliberately not the
 * implementation: a subprocess per tool call would sit on the coding agent's
 * critical path.
 *
 * @param boundary - Folder the walk stops at, inclusive.
 * @returns A finder whose answers are memoized per directory.
 */
export function repositoryRootFinder(boundary: string): RepositoryRootFinder {
  // Directory → its repository root, or undefined for "none, and asked".
  // One turn touches the same handful of directories over and over.
  const cache = new Map<string, string | undefined>();

  return { find: (filePath) => rootFor(path.dirname(filePath), boundary, cache) };
}

/**
 * The repository root at or above one directory, memoizing every level.
 *
 * @param dir - Directory to resolve.
 * @param boundary - Folder the walk stops at, inclusive.
 * @param cache - Directory answers resolved so far.
 * @returns The root, or undefined when there is none inside the boundary.
 */
async function rootFor(dir: string, boundary: string, cache: Map<string, string | undefined>): Promise<string | undefined> {
  if (cache.has(dir)) return cache.get(dir);

  // A file outside the start folder contributes no repository at all: its
  // repository is not the session's business and could be another tenant's.
  if (!isBeneath(boundary, dir)) return undefined;

  const root = await walkUp(dir, boundary, cache);

  cache.set(dir, root);

  return root;
}

/**
 * One rung of the walk: this directory, else its parent.
 *
 * @param dir - Directory to test.
 * @param boundary - Folder the walk stops at, inclusive.
 * @param cache - Directory answers resolved so far.
 * @returns The root, or undefined once the boundary is passed.
 */
async function walkUp(dir: string, boundary: string, cache: Map<string, string | undefined>): Promise<string | undefined> {
  const entry = await gitEntry(dir);

  if (entry === 'present') return (await isReallyBeneath(boundary, dir)) ? dir : undefined;

  // A `.git` that could not be checked may well be there: climbing past it
  // would hand the file to an enclosing repository — the wrong branch, the
  // wrong config. No repository is the answer this walk gives when unsure.
  if (entry === 'unknown') return undefined;

  const parent = path.dirname(dir);

  // `dir === boundary` ends the walk; `parent === dir` is the filesystem root,
  // which only happens when the boundary is not an ancestor at all.
  if (dir === boundary || parent === dir) return undefined;

  return rootFor(parent, boundary, cache);
}

/**
 * `isBeneath`, asked of where the two really are.
 *
 * A symlink inside the start folder can point at a checkout anywhere on the
 * machine, and `.git` is found through it: lexically beneath, on disk another
 * project's. Asked only once a root is found, so the walk itself stays `stat`s.
 * A refused root ends the walk rather than climbing past it — the file belongs
 * to that repository, whoever's it is. A path that cannot be resolved — a link
 * removed or retargeted since the `.git` check — is refused too: its real
 * location was never proven to be inside.
 *
 * @param boundary - Folder that bounds the walk.
 * @param dir - Directory a `.git` entry was found in.
 * @returns True when the directory really lies within the boundary.
 */
async function isReallyBeneath(boundary: string, dir: string): Promise<boolean> {
  try {
    const [realBoundary, realDir] = await Promise.all([fs.realpath(boundary), fs.realpath(dir)]);

    return isBeneath(realBoundary, realDir);
  } catch {
    return false;
  }
}

/**
 * Whether a `.git` entry sits directly in a directory.
 *
 * @param dir - Directory to test.
 * @returns `present`, `absent`, or `unknown` when the check itself failed.
 */
async function gitEntry(dir: string): Promise<'present' | 'absent' | 'unknown'> {
  try {
    await fs.access(path.join(dir, GIT_ENTRY_NAME));

    return 'present';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    return code !== undefined && GIT_ENTRY_ABSENT_CODES.has(code) ? 'absent' : 'unknown';
  }
}

/**
 * Whether a path is a directory or lies inside it.
 *
 * The two answers that disqualify it are a relative path that climbs out and
 * one that stays absolute (a different drive or root). A sibling named
 * `..foo` climbs nowhere, which is why the separator is part of the test.
 *
 * Exported because the same question is asked of a repository path read back
 * out of local turn state: one answer, not two that could disagree.
 *
 * @param boundary - Folder that bounds the walk.
 * @param target - Path to test against it.
 * @returns True when the target is the boundary or beneath it.
 */
export function isBeneath(boundary: string, target: string): boolean {
  const relative = path.relative(boundary, target);

  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}
