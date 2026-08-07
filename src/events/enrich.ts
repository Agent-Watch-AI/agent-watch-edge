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
  gitTimeoutMs?: number;
}

/**
 * Enrich canonical events with Git/development context, feature-correlation
 * evidence and the installation id, then sanitize everything. Failures
 * degrade to less context, never to a failed hook.
 */
export async function enrichEvents(events: AgentWatchEvent[], options: EnrichOptions): Promise<AgentWatchEvent[]> {
  if (events.length === 0) return events;

  let git: GitContext = {};
  if (options.config.capture.git) {
    try {
      git = await collectGitContext({
        cwd: options.cwd,
        includeChangedFiles: options.config.capture.files,
        timeoutMs: options.gitTimeoutMs
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
    return sanitizeValue(enriched);
  });
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
