import path from 'node:path';
import type { AgentWatchEvent } from './canonical-event.js';
import type { AgentWatchConfig } from '../config/config.js';
import { collectGitContext, type GitContext } from '../git/git-context.js';
import { featureCandidatesFromBranch } from '../feature/ticket-candidates.js';
import { sanitizeValue } from '../privacy/sanitizer.js';

export interface EnrichOptions {
  config: AgentWatchConfig;
  /** Working directory reported by the agent's hook payload. */
  cwd: string;
  /** Developer home directory; rewritten to `~` inside captured content. */
  home?: string;
  gitTimeoutMs?: number;
}

/**
 * Enrich canonical events with Git/development context, feature-correlation
 * evidence and the installation id, then sanitize everything. Failures
 * degrade to less context, never to a failed hook.
 */
export async function enrichEvents(events: AgentWatchEvent[], options: EnrichOptions): Promise<AgentWatchEvent[]> {
  if (events.length === 0) return events;

  // Full git context (branch/commit/remote/status) costs up to five git
  // processes and is only consumed when a turn closes (the summary reads it
  // off the Stop event). Every other hook runs on the agent's critical path —
  // often once per tool call — and needs just the repo root for path
  // rewriting.
  const needsFullGit = events.some((event) => event.event.type === 'generation.completed');
  let git: GitContext = {};
  if (options.config.capture.git) {
    try {
      git = await collectGitContext({
        cwd: options.cwd,
        includeChangedFiles: options.config.capture.files && needsFullGit,
        timeoutMs: options.gitTimeoutMs,
        rootOnly: !needsFullGit
      });
    } catch {
      git = {};
    }
  }
  const featureCandidates = featureCandidatesFromBranch(git.branch);

  return events.map((event) => {
    const enriched: AgentWatchEvent = { ...event };
    if (options.config.installationId) {
      enriched.developer = { ...enriched.developer, installationId: options.config.installationId };
    }
    if (git.repositoryRoot) {
      enriched.git = {
        repository: git.repository,
        repositoryHash: git.repositoryHash,
        remote: git.remote,
        branch: git.branch,
        commit: git.commit,
        // Relative to the repo root: absolute paths leak usernames.
        workingDirectory: relativize(git.repositoryRoot, options.cwd),
        changedFiles: git.changedFiles
      };
    }
    if (featureCandidates.length > 0) {
      enriched.feature = { candidates: featureCandidates };
    }
    const filePath = enriched.metadata?.['filePath'];
    if (typeof filePath === 'string') {
      enriched.metadata = { ...enriched.metadata, filePath: toSafePath(filePath, git.repositoryRoot) };
    }
    if (enriched.metadata) {
      enriched.metadata = rewritePathsDeep(enriched.metadata, git.repositoryRoot, options.home) as Record<string, unknown>;
    }
    return sanitizeValue(enriched);
  });
}

/**
 * Rewrite path prefixes inside captured content (tool input/output, shell
 * commands): repo-rooted paths become repo-relative, and the home directory
 * becomes `~`, so usernames and machine layout don't leak. Textual and
 * best-effort by design — arbitrary strings can still embed paths we cannot
 * recognize.
 */
function rewritePathsDeep(value: unknown, repositoryRoot: string | undefined, home: string | undefined): unknown {
  if (typeof value === 'string') {
    let out = value;
    // Boundary-aware: `/x/repo` must not fire inside `/x/repository`.
    if (repositoryRoot) {
      out = out.replace(pathPrefixPattern(repositoryRoot + path.sep), '');
      out = out.replace(pathExactPattern(repositoryRoot), '.');
    }
    if (home) {
      out = out.replace(pathPrefixPattern(home + path.sep), '~' + path.sep);
      out = out.replace(pathExactPattern(home), '~');
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((item) => rewritePathsDeep(item, repositoryRoot, home));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rewritePathsDeep(entry, repositoryRoot, home)]));
  }
  return value;
}

/** The prefix itself ends with a separator, so it is already boundary-safe. */
function pathPrefixPattern(prefix: string): RegExp {
  return new RegExp(escapeRegExp(prefix), 'g');
}

/** A bare directory reference: only when followed by a non-path-name character. */
function pathExactPattern(dir: string): RegExp {
  return new RegExp(escapeRegExp(dir) + `(?=[\\s"'\`)\\]}>,;:]|$)`, 'g');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function relativize(root: string, target: string): string {
  const relative = path.relative(root, target);
  return relative === '' ? '.' : relative;
}

/** Repo-relative when inside the repo; basename only when outside. */
function toSafePath(filePath: string, repositoryRoot: string | undefined): string {
  if (repositoryRoot) {
    const relative = path.relative(repositoryRoot, filePath);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) return relative;
  }
  return path.basename(filePath);
}
