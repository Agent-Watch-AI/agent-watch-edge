import fs from 'node:fs/promises';
import path from 'node:path';
import { asRecord } from '../core/object.js';
import {
  GIT_COMMONDIR_FILE,
  GIT_FINGERPRINT_ARGS,
  GIT_TIMEOUT_MS,
  PORCELAIN_V2_DETACHED,
  PORCELAIN_V2_HEAD_HEADER,
  PORCELAIN_V2_NO_OID,
  PORCELAIN_V2_OID_HEADER,
  PORCELAIN_V2_PATH_FIELD,
  PORCELAIN_V2_RENAME_KIND,
  PORCELAIN_V2_UNTRACKED_XY,
  RE_OBJECT_ID,
  gitDiffNamesArgs
} from './constants/git.constants.js';
import { findGitDir } from './gate-checkout.js';
import { runGit } from './git-context.js';
import type { DirtyEntry, Fingerprint, GitRunner } from './types/git.types.js';

export type { DirtyEntry, Fingerprint } from './types/git.types.js';

/**
 * What a checkout looks like right now: HEAD, branch, and every dirty entry
 * with its size and mtime.
 *
 * Two of these, one when a turn first names the checkout and one at its Stop,
 * are how the edge tells which checkout a turn changed without watching any of
 * them: a moved HEAD is a commit, a new or re-stamped dirty entry is an edit,
 * whoever made it — a file tool or a shell command.
 *
 * One git process, taken without optional locks; the sizes are `lstat`s. Any
 * failure is no fingerprint, which costs the checkout its evidence and nothing
 * else.
 *
 * @param root - Checkout root.
 * @param run - Git runner; injectable for tests.
 * @param timeoutMs - Kill budget for the git process.
 * @returns The fingerprint, or undefined when git could not give one.
 */
export async function fingerprint(root: string, run: GitRunner = runGit, timeoutMs = GIT_TIMEOUT_MS): Promise<Fingerprint | undefined> {
  const [status, commonDir] = await Promise.all([run(GIT_FINGERPRINT_ARGS, root, timeoutMs), readCommonDir(root)]);

  if (status === undefined) return undefined;

  const parsed = parsePorcelainV2(status);
  const stamped = await Promise.all(parsed.entries.map(async ([file, xy]) => [file, await stampEntry(root, file, xy)] as const));

  return { oid: parsed.oid, branch: parsed.branch, commonDir, dirty: Object.fromEntries(stamped) };
}

/**
 * `git status --porcelain=v2 --branch -z`, read.
 *
 * Renames carry their original path as the next NUL record, which is skipped:
 * the new path is the one that changed. Ignored entries never appear without
 * `--ignored`.
 *
 * @param output - Raw NUL-separated output.
 * @returns HEAD, branch and the dirty entries as `[path, xy]`, in git's order.
 */
export function parsePorcelainV2(output: string): { oid?: string; branch?: string; entries: (readonly [string, string])[] } {
  const records = output.split('\0');
  const entries: (readonly [string, string])[] = [];
  let oid: string | undefined;
  let branch: string | undefined;

  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;

    if (record.startsWith(PORCELAIN_V2_OID_HEADER)) {
      const value = record.slice(PORCELAIN_V2_OID_HEADER.length);

      oid = value === PORCELAIN_V2_NO_OID ? undefined : value;
      continue;
    }

    if (record.startsWith(PORCELAIN_V2_HEAD_HEADER)) {
      const value = record.slice(PORCELAIN_V2_HEAD_HEADER.length);

      branch = value === PORCELAIN_V2_DETACHED ? undefined : value;
      continue;
    }

    const kind = record.slice(0, 1);
    const file = pathField(record, PORCELAIN_V2_PATH_FIELD[kind]);

    if (kind === PORCELAIN_V2_RENAME_KIND) index += 1;

    if (!file) continue;

    entries.push([file, kind === '?' ? PORCELAIN_V2_UNTRACKED_XY : record.slice(2, 4)]);
  }

  return { oid, branch, entries };
}

/**
 * The paths a turn changed in a checkout's working tree: every dirty entry
 * that is new, re-stamped or gone since the baseline.
 *
 * A file that was already dirty and stayed untouched is not this turn's work,
 * which is the whole difference from reporting `git status`.
 *
 * @param baseline - The checkout when the turn first named it.
 * @param closing - The checkout at the Stop.
 * @returns Repository-relative paths, in the closing fingerprint's order.
 */
export function dirtyDelta(baseline: Fingerprint, closing: Fingerprint): string[] {
  const before = new Map(Object.entries(baseline.dirty));
  const changed: string[] = [];

  for (const [file, entry] of Object.entries(closing.dirty)) {
    const old = before.get(file);

    before.delete(file);

    if (old && old.xy === entry.xy && old.size === entry.size && old.mtimeMs === entry.mtimeMs) continue;

    changed.push(file);
  }

  // Dirty at the start and clean at the end: reverted, or committed (and then
  // also in the commit diff, which the caller unions with this).
  return [...changed, ...before.keys()];
}

/**
 * The files two commits differ in.
 *
 * @param cwd - Checkout root, or the common git dir of one that vanished.
 * @param from - Where the turn started.
 * @param to - Where it ended: an oid, or a branch ref.
 * @param gitDir - Ask this git dir rather than the one `cwd` would find.
 * @param run - Git runner; injectable for tests.
 * @returns Repository-relative paths; empty when git could not say.
 */
export async function commitFiles(cwd: string, from: string, to: string, gitDir?: string, run: GitRunner = runGit): Promise<string[]> {
  const args = gitDir ? ['--git-dir', gitDir, ...gitDiffNamesArgs(from, to)] : gitDiffNamesArgs(from, to);
  const output = await run(args, cwd, GIT_TIMEOUT_MS);

  return output ? output.split('\0').filter(Boolean) : [];
}

/**
 * A fingerprint out of turn state, type-checked field by field.
 *
 * Turn state is a file on disk between hooks; a value that is not the shape
 * this code writes is no baseline, never a throw.
 *
 * @param value - Decoded record field.
 * @returns The fingerprint, or undefined.
 */
export function asFingerprint(value: unknown): Fingerprint | undefined {
  const record = asRecord(value);
  const dirty = asRecord(record?.['dirty']);

  if (!record || !dirty) return undefined;

  const entries: [string, DirtyEntry][] = [];

  for (const [file, raw] of Object.entries(dirty)) {
    const entry = asRecord(raw);

    if (typeof entry?.['xy'] !== 'string') continue;

    entries.push([file, { xy: entry['xy'], size: numberOr(entry['size']), mtimeMs: numberOr(entry['mtimeMs']) }]);
  }

  const oid = stringOr(record['oid']);
  const commonDir = stringOr(record['commonDir']);

  return {
    // Both reach a git command line: an oid that is not one could be read as
    // an option, and a relative git dir resolves against nobody knows what.
    oid: oid !== undefined && RE_OBJECT_ID.test(oid) ? oid : undefined,
    branch: stringOr(record['branch']),
    commonDir: commonDir !== undefined && path.isAbsolute(commonDir) ? commonDir : undefined,
    dirty: Object.fromEntries(entries)
  };
}

/**
 * The git dir every worktree of this checkout's repository shares.
 *
 * Read from disk, no git: a worktree's `.git` file names its own git dir, and
 * that dir's `commondir` file names the shared one. Kept so a turn that removes
 * its worktree can still read what the branch committed.
 *
 * @param root - Checkout root.
 * @returns The common git dir, or undefined when it cannot be read.
 */
async function readCommonDir(root: string): Promise<string | undefined> {
  try {
    const location = await findGitDir(root);

    if (!location) return undefined;

    const pointer = await fs.readFile(path.join(location.gitDir, GIT_COMMONDIR_FILE), 'utf8').catch(() => undefined);

    return pointer === undefined ? location.gitDir : path.resolve(location.gitDir, pointer.trim());
  } catch {
    return undefined;
  }
}

/**
 * One dirty entry with its size and mtime, when it is still on disk.
 *
 * @param root - Checkout root.
 * @param file - Repository-relative path.
 * @param xy - Its status letters.
 * @returns The entry.
 */
async function stampEntry(root: string, file: string, xy: string): Promise<DirtyEntry> {
  try {
    const stat = await fs.lstat(path.join(root, file));

    return { xy, size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    // Deleted: its status letters are all there is to compare.
    return { xy };
  }
}

/**
 * The path of one porcelain v2 entry, which may itself contain spaces.
 *
 * @param record - One NUL-separated record.
 * @param fieldsBefore - How many space-separated fields precede the path.
 * @returns The path, or undefined for a record of a kind this does not read.
 */
function pathField(record: string, fieldsBefore: number | undefined): string | undefined {
  if (fieldsBefore === undefined) return undefined;

  let at = -1;

  for (let field = 0; field < fieldsBefore; field++) {
    at = record.indexOf(' ', at + 1);

    if (at === -1) return undefined;
  }

  return record.slice(at + 1) || undefined;
}

function stringOr(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function numberOr(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
