import { execFile } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { debugLog } from '../core/logger.js';
import { normalizeRemote, remoteHash } from './remote-sanitize.js';
import {
  GIT_BRANCH_ARGS,
  GIT_COMMIT_ARGS,
  GIT_MAX_BUFFER_BYTES,
  GIT_REMOTE_ARGS,
  GIT_REPO_ROOT_ARGS,
  GIT_STATUS_ARGS,
  GIT_TIMEOUT_MS,
  GIT_USER_EMAIL_ARGS,
  MAX_CHANGED_FILES,
  PORCELAIN_ESCAPES,
  PORCELAIN_PREFIX_LENGTH,
  PORCELAIN_RENAME_SEPARATOR,
  RE_TRAILING_WHITESPACE,
  STDOUT_MAXBUFFER_CODE
} from './constants/git.constants.js';
import type { GitContext, GitContextOptions, GitRunner, GitUserEmailOptions } from './types/git.types.js';

export type { GitContext, GitContextOptions, GitRunner } from './types/git.types.js';

export { defaultRunner as runGit };

/**
 * Collect repository context for event enrichment.
 *
 * Every failure degrades to less context, never to a thrown error: hooks run
 * inside the coding agent and must not break when git is missing, slow, or the
 * working directory is not a repository at all.
 *
 * @param options - What to collect and where.
 * @param run - Git runner; injectable for tests.
 * @returns The context that could be resolved.
 */
export async function collectGitContext(options: GitContextOptions, run: GitRunner = defaultRunner): Promise<GitContext> {
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const root = await run(GIT_REPO_ROOT_ARGS, options.cwd, timeoutMs);

  if (!root) return { workingDirectory: options.cwd };

  if (options.rootOnly) {
    return { repositoryRoot: root, workingDirectory: options.cwd, repository: path.basename(root) };
  }

  const [branch, commit, remoteRaw, status] = await Promise.all([
    run(GIT_BRANCH_ARGS, root, timeoutMs),
    run(GIT_COMMIT_ARGS, root, timeoutMs),
    run(GIT_REMOTE_ARGS, root, timeoutMs),
    options.includeChangedFiles ? run(GIT_STATUS_ARGS, root, timeoutMs) : Promise.resolve(undefined)
  ]);

  const identity = repositoryIdentity(root, remoteRaw);

  return {
    repositoryRoot: root,
    workingDirectory: options.cwd,
    branch: branch || undefined,
    commit: commit || undefined,
    ...identity,
    changedFiles: status === undefined ? undefined : changedFilesFrom(status, options.maxChangedFiles ?? MAX_CHANGED_FILES)
  };
}

/**
 * `git config user.email` for the developer identity on turn summaries.
 *
 * @param cwd - Directory to resolve the config from.
 * @param options - Timeout, injected HOME and runner override.
 * @returns The configured email, or undefined outside git / when unset.
 */
export async function gitUserEmail(cwd: string, options: GitUserEmailOptions = {}): Promise<string | undefined> {
  const run = options.run ?? defaultRunner;
  const email = await run(GIT_USER_EMAIL_ARGS, cwd, options.timeoutMs ?? GIT_TIMEOUT_MS, options.home);

  return email || undefined;
}

/**
 * The developer identity attached to a turn — and asked about by the pre-turn
 * budget check.
 *
 * Both callers have to produce the same string: it is the value the platform
 * stored for this developer, so a gate asking about one identity while summaries
 * report another would match no policy at all. Hence one function rather than
 * the same two lines in two modules.
 *
 * @param configuredEmail - `developerEmail` from the effective config, if set.
 * @param cwd - Directory to fall back to `git config user.email` in.
 * @param options - Timeout, injected HOME and runner override.
 * @returns The identity, or undefined when neither source has one.
 */
export async function developerIdentity(
  configuredEmail: string | undefined,
  cwd: string,
  options: GitUserEmailOptions = {}
): Promise<string | undefined> {
  if (configuredEmail) return configuredEmail;

  return gitUserEmail(cwd, options);
}

/**
 * How this repository is named, preferring its remote identity.
 *
 * Only the credential-free normalized remote is ever reported, alongside its
 * hash for backends that want to group without knowing the name. A repository
 * with no usable remote falls back to its directory name.
 *
 * @param root - Repository root path.
 * @param remoteRaw - Raw `remote.origin.url`, when git reported one.
 * @returns The repository/remote/hash fields of the context.
 */
function repositoryIdentity(root: string, remoteRaw: string | undefined): Pick<GitContext, 'repository' | 'remote' | 'repositoryHash'> {
  const remote = remoteRaw ? normalizeRemote(remoteRaw) : undefined;

  if (!remote) return { repository: path.basename(root) };

  return { remote, repository: remote, repositoryHash: remoteRaw ? remoteHash(remoteRaw) : undefined };
}

/**
 * Paths from `status --porcelain`, capped.
 *
 * @param status - Raw porcelain output.
 * @param maxFiles - Ceiling on the returned list.
 * @returns Changed paths, truncated to the cap.
 */
function changedFilesFrom(status: string, maxFiles: number): string[] {
  const files: string[] = [];

  for (const line of status.split('\n')) {
    if (!line) continue;

    const file = parsePorcelainLine(line);

    if (file) files.push(file);
  }

  if (files.length > maxFiles) {
    debugLog(`changedFiles truncated: ${files.length} -> ${maxFiles}`);

    return files.slice(0, maxFiles);
  }

  return files;
}

/**
 * The path out of one porcelain line ("XY path" or "XY orig -> renamed").
 *
 * @param line - One line of porcelain output.
 * @returns The (new) path, or undefined for a line carrying none.
 */
function parsePorcelainLine(line: string): string | undefined {
  const body = line.slice(PORCELAIN_PREFIX_LENGTH);

  if (!body) return undefined;

  const renameSplit = body.split(PORCELAIN_RENAME_SEPARATOR);
  const candidate = renameSplit[renameSplit.length - 1] ?? body;

  if (candidate.length >= 2 && candidate.startsWith('"') && candidate.endsWith('"')) {
    return unquotePorcelainPath(candidate);
  }

  return candidate;
}

/**
 * Decode git's C-style path quoting.
 *
 * `"r\303\251sum\303\251.txt"` is the on-the-wire form of `résumé.txt`: octal
 * escapes are individual UTF-8 *bytes*, so they are collected as bytes and
 * decoded once at the end rather than per escape.
 *
 * @param quoted - The quoted path, including its surrounding quotes.
 * @returns The decoded path.
 */
function unquotePorcelainPath(quoted: string): string {
  const inner = quoted.slice(1, -1);
  const bytes: number[] = [];
  let index = 0;

  while (index < inner.length) {
    const char = inner[index]!;

    if (char !== '\\') {
      bytes.push(...Buffer.from(char, 'utf8'));
      index += 1;
      continue;
    }

    const next = inner[index + 1];

    if (next === undefined) break;

    if (next >= '0' && next <= '7') {
      const octal = readOctalEscape(inner, index + 1);

      bytes.push(parseInt(octal, 8));
      index += 1 + octal.length;
      continue;
    }

    bytes.push(...Buffer.from(PORCELAIN_ESCAPES[next] ?? next, 'utf8'));
    index += 2;
  }

  return Buffer.from(bytes).toString('utf8');
}

/**
 * The up-to-three octal digits starting at `start`.
 *
 * @param inner - Quoted path contents.
 * @param start - Index of the first digit.
 * @returns The digit run.
 */
function readOctalEscape(inner: string, start: number): string {
  let octal = '';

  while (octal.length < 3) {
    const digit = inner[start + octal.length];

    if (digit === undefined || digit < '0' || digit > '7') break;

    octal += digit;
  }

  return octal;
}

/**
 * Run one git command, resolving to undefined on any failure.
 *
 * @param args - Argument vector.
 * @param cwd - Working directory.
 * @param timeoutMs - Kill budget.
 * @param home - HOME to read global git config (identity!) from, so tests and
 *   sandboxes never pick up the developer's real one.
 * @returns Trailing-trimmed stdout, or undefined.
 */
const defaultRunner: GitRunner = (args, cwd, timeoutMs, home) =>
  new Promise((resolve) => {
    const env = home ? { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') } : undefined;

    execFile('git', [...args], { cwd, timeout: timeoutMs, maxBuffer: GIT_MAX_BUFFER_BYTES, windowsHide: true, env }, (error, stdout) => {
      // Trailing-only trim: `status --porcelain` lines carry a significant
      // leading space (" M file"); a full trim() would eat the first character
      // of the first filename.
      if (!error) {
        resolve(stdout.replace(RE_TRAILING_WHITESPACE, ''));

        return;
      }

      resolve(salvageTruncatedStdout(error, stdout));
    });
  });

/**
 * Recover usable output from a git process that overran maxBuffer.
 *
 * A huge dirty tree is exactly when changedFiles matters most, and callers cap
 * the list anyway — so the truncated output minus its partial last line beats
 * discarding everything.
 *
 * @param error - The exec error.
 * @param stdout - Whatever was captured before the overflow.
 * @returns The salvaged output, or undefined for any other failure.
 */
function salvageTruncatedStdout(error: unknown, stdout: unknown): string | undefined {
  if ((error as NodeJS.ErrnoException).code !== STDOUT_MAXBUFFER_CODE) return undefined;

  if (typeof stdout !== 'string' || !stdout.includes('\n')) return undefined;

  return stdout.slice(0, stdout.lastIndexOf('\n')).replace(RE_TRAILING_WHITESPACE, '');
}
