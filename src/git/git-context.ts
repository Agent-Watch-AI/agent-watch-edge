import { execFile } from 'node:child_process';
import path from 'node:path';
import { normalizeRemote, remoteHash } from './remote-sanitize.js';
import { debugLog } from '../core/logger.js';

export interface GitContext {
  repositoryRoot?: string;
  repository?: string;
  remote?: string;
  repositoryHash?: string;
  branch?: string;
  commit?: string;
  workingDirectory?: string;
  changedFiles?: string[];
}

export interface GitContextOptions {
  cwd: string;
  includeChangedFiles: boolean;
  timeoutMs?: number;
  maxChangedFiles?: number;
  /**
   * Resolve only the repository root (one git process) and skip
   * branch/commit/remote/status. Hooks on the agent's critical path need the
   * root for path rewriting but none of the expensive details — those are
   * only consumed when a turn closes.
   */
  rootOnly?: boolean;
}

type GitRunner = (args: string[], cwd: string, timeoutMs: number, home?: string) => Promise<string | undefined>;

const defaultRunner: GitRunner = (args, cwd, timeoutMs, home) =>
  new Promise((resolve) => {
    // Honor the injected home so global git config (identity!) is read from
    // it, not from the real $HOME — tests and sandboxes must stay isolated.
    const env = home ? { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') } : undefined;
    execFile('git', args, { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true, env }, (error, stdout) => {
      // Trailing-only trim: `status --porcelain` lines carry a significant
      // leading space (" M file"); a full trim() would eat the first
      // character of the first filename.
      if (!error) {
        resolve(stdout.replace(/\s+$/, ''));
        return;
      }
      // maxBuffer overflow (huge dirty tree): keep the truncated output minus
      // its partial last line — callers cap the list anyway, and dropping
      // everything would lose changedFiles exactly in the busiest sessions.
      if ((error as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDOUT_MAXBUFFER' && typeof stdout === 'string' && stdout.includes('\n')) {
        resolve(stdout.slice(0, stdout.lastIndexOf('\n')).replace(/\s+$/, ''));
        return;
      }
      resolve(undefined);
    });
  });

/**
 * Collect repository context for event enrichment. Every failure degrades to
 * "no data" — hooks must not break when git is missing or cwd is not a repo.
 */
export async function collectGitContext(options: GitContextOptions, run: GitRunner = defaultRunner): Promise<GitContext> {
  const timeoutMs = options.timeoutMs ?? 1000;
  const root = await run(['rev-parse', '--show-toplevel'], options.cwd, timeoutMs);
  if (!root) return { workingDirectory: options.cwd };
  if (options.rootOnly) {
    return { repositoryRoot: root, workingDirectory: options.cwd, repository: path.basename(root) };
  }

  const [branch, commit, remoteRaw, status] = await Promise.all([
    // Not `branch --show-current`: that flag needs git >= 2.22 and its absence
    // would silently drop branch (and ticket) attribution on older machines.
    // symbolic-ref works everywhere and exits 1 (-> undefined) on detached HEAD.
    run(['symbolic-ref', '--short', '-q', 'HEAD'], root, timeoutMs),
    run(['rev-parse', 'HEAD'], root, timeoutMs),
    run(['config', '--get', 'remote.origin.url'], root, timeoutMs),
    options.includeChangedFiles ? run(['status', '--porcelain'], root, timeoutMs) : Promise.resolve(undefined)
  ]);

  const context: GitContext = {
    repositoryRoot: root,
    workingDirectory: options.cwd,
    branch: branch || undefined,
    commit: commit || undefined
  };

  if (remoteRaw) {
    context.remote = normalizeRemote(remoteRaw); // credential-free, normalized form only
    context.repositoryHash = remoteHash(remoteRaw);
    context.repository = context.remote;
  }
  if (!context.repository) {
    context.repository = path.basename(root);
  }

  if (status !== undefined) {
    const maxFiles = options.maxChangedFiles ?? 50;
    const files = status
      .split('\n')
      .filter(Boolean)
      .map(parsePorcelainLine)
      .filter((file): file is string => Boolean(file));
    context.changedFiles = files.slice(0, maxFiles);
    if (files.length > maxFiles) {
      debugLog(`changedFiles truncated: ${files.length} -> ${maxFiles}`);
    }
  }
  return context;
}

/** `git config user.email`, or undefined outside git / when unset. */
export async function gitUserEmail(
  cwd: string,
  options: { timeoutMs?: number; home?: string; run?: GitRunner } = {}
): Promise<string | undefined> {
  const run = options.run ?? defaultRunner;
  const email = await run(['config', '--get', 'user.email'], cwd, options.timeoutMs ?? 1000, options.home);
  return email || undefined;
}

function parsePorcelainLine(line: string): string | undefined {
  // Format: "XY path" or "XY orig -> renamed"
  const body = line.slice(3);
  if (!body) return undefined;
  const renameSplit = body.split(' -> ');
  const candidate = renameSplit[renameSplit.length - 1] ?? body;
  if (candidate.length >= 2 && candidate.startsWith('"') && candidate.endsWith('"')) {
    return unquotePorcelainPath(candidate);
  }
  return candidate;
}

/**
 * Decode git's C-style path quoting (core.quotePath): `"r\303\251sum\303\251.txt"`
 * is the on-the-wire form of `résumé.txt`. Octal escapes are UTF-8 bytes, so
 * they are collected as bytes first and decoded once at the end.
 */
function unquotePorcelainPath(quoted: string): string {
  const inner = quoted.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'));
      continue;
    }
    const next = inner[++i];
    if (next === undefined) break;
    if (next >= '0' && next <= '7') {
      let octal = next;
      while (octal.length < 3 && inner[i + 1] !== undefined && inner[i + 1]! >= '0' && inner[i + 1]! <= '7') {
        octal += inner[++i];
      }
      bytes.push(parseInt(octal, 8));
    } else {
      const escapes: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', '"': '"', '\\': '\\' };
      bytes.push(...Buffer.from(escapes[next] ?? next, 'utf8'));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}
