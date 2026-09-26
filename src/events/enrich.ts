import path from 'node:path';
import { isRecord } from '../core/object.js';
import { collectGitContext } from '../git/git-context.js';
import { repositoryRootFinder } from '../git/repository-root.js';
import type { GitContext } from '../git/types/git.types.js';
import { featureCandidatesFromBranch } from '../feature/ticket-candidates.js';
import { sanitizeValue } from '../privacy/sanitizer.js';
import { TURN_CLOSING_EVENT_TYPE } from './constants/events.constants.js';
import {
  FILE_PATH_METADATA_KEY,
  HOME_PLACEHOLDER,
  HOME_PLACEHOLDER_PREFIX,
  EMPTY_REPOSITORIES,
  PATH_BOUNDARY_LOOKAHEAD,
  REPO_ROOT_PLACEHOLDER,
  REPOSITORY_PATH_METADATA_KEY,
  RE_REGEXP_METACHARACTERS
} from './constants/enrich.constants.js';
import type { AgentWatchEvent, FeatureCandidate } from './types/events.types.js';
import type { EnrichOptions, PathRewriter, PathRule } from './types/enrich.types.js';

export type { EnrichOptions, PathRewriter } from './types/enrich.types.js';

/**
 * Attach development context to canonical events and scrub them.
 *
 * Four things happen, in this order, and each one is a pure function of the
 * previous: resolve where the work happened (git), derive what it was about
 * (ticket evidence), rewrite machine-specific paths out of captured content,
 * and sanitize. Failures degrade to less context, never to a failed hook.
 *
 * @param events - Canonical events from a provider adapter.
 * @param options - Effective config, working directory and home.
 * @returns Enriched, sanitized events in the same order.
 */
export async function enrichEvents(events: readonly AgentWatchEvent[], options: EnrichOptions): Promise<AgentWatchEvent[]> {
  if (events.length === 0) return [...events];

  const git = await resolveGitContext(events, options);
  const featureCandidates = featureCandidatesFromBranch(git.branch);
  const rewriter = buildPathRewriter(git.repositoryRoot, options.home);
  const repositories = await resolveFileRepositories(events, git, options);
  const enriched: AgentWatchEvent[] = [];

  for (const event of events) {
    enriched.push(sanitizeValue(enrichEvent(event, { git, featureCandidates, rewriter, repositories, options })));
  }

  return enriched;
}

/**
 * Repository context for this batch, at the cheapest sufficient depth.
 *
 * Full context (branch, commit, remote, status) costs up to five git processes
 * and is only consumed when a turn closes — the summary reads it off the Stop
 * event. Every other hook runs on the agent's critical path, often once per
 * tool call, and needs nothing but the repository root for path rewriting.
 *
 * @param events - The batch being enriched.
 * @param options - Effective config and working directory.
 * @returns The context, or an empty one when git is unavailable or disabled.
 */
async function resolveGitContext(events: readonly AgentWatchEvent[], options: EnrichOptions): Promise<GitContext> {
  if (!options.config.capture.git) return {};

  const needsFullGit = events.some((event) => event.event.type === TURN_CLOSING_EVENT_TYPE);

  try {
    return await collectGitContext({
      cwd: options.cwd,
      includeChangedFiles: options.config.capture.files && needsFullGit,
      timeoutMs: options.gitTimeoutMs,
      rootOnly: !needsFullGit
    });
  } catch {
    return {};
  }
}

/**
 * The repository each file of this batch belongs to, when the session started
 * above its repositories rather than inside one.
 *
 * Two thirds of real sessions start in a workspace folder holding several
 * repositories. The start folder is not a repository, so without this every
 * path in the batch would degrade to a bare basename and the turn would report
 * no repository at all — leaving the session unattributable.
 *
 * Resolved up front, for the batch, so enriching one event stays synchronous.
 * The walk is `stat` calls only: the one hook that may shell out to git is the
 * turn-closing one.
 *
 * @param events - The batch being enriched.
 * @param git - Context already resolved for the start folder.
 * @param options - Effective config and working directory.
 * @returns Absolute file path → its repository root; empty when this does not apply.
 */
async function resolveFileRepositories(
  events: readonly AgentWatchEvent[],
  git: GitContext,
  options: EnrichOptions
): Promise<ReadonlyMap<string, string>> {
  // A session started inside a repository takes this path never: that
  // repository wins, including over a nested one beneath it.
  if (git.repositoryRoot || !options.config.capture.git) return EMPTY_REPOSITORIES;

  const finder = repositoryRootFinder(options.cwd);
  const roots = new Map<string, string>();

  for (const event of events) {
    const filePath = event.metadata?.[FILE_PATH_METADATA_KEY];

    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || roots.has(filePath)) continue;

    const root = await finder.find(filePath);

    if (root) roots.set(filePath, root);
  }

  return roots;
}

/** Everything one event needs, resolved once for the whole batch. */
interface EnrichContext {
  readonly git: GitContext;
  readonly featureCandidates: readonly FeatureCandidate[];
  readonly rewriter: PathRewriter;
  /** Absolute file path → repository root, for a session started above one. */
  readonly repositories: ReadonlyMap<string, string>;
  readonly options: EnrichOptions;
}

/**
 * One event with development context attached.
 *
 * @param event - The event to enrich; left untouched.
 * @param context - Batch-wide resolved context.
 * @returns A new event carrying the context.
 */
function enrichEvent(event: AgentWatchEvent, context: EnrichContext): AgentWatchEvent {
  const { git, featureCandidates, options } = context;

  return {
    ...event,
    developer: options.config.installationId
      ? { ...event.developer, installationId: options.config.installationId }
      : event.developer,
    git: git.repositoryRoot
      ? {
          repository: git.repository,
          repositoryHash: git.repositoryHash,
          remote: git.remote,
          branch: git.branch,
          commit: git.commit,
          // Relative to the repo root: absolute paths leak usernames.
          workingDirectory: relativize(git.repositoryRoot, options.cwd),
          changedFiles: git.changedFiles
        }
      : event.git,
    feature: featureCandidates.length > 0 ? { candidates: featureCandidates } : event.feature,
    metadata: enrichMetadata(event.metadata, context)
  };
}

/**
 * Metadata with its file path made safe and every path prefix rewritten.
 *
 * @param metadata - Adapter-produced metadata, or undefined.
 * @param context - Batch-wide resolved context.
 * @returns New metadata, or undefined when there was none.
 */
function enrichMetadata(metadata: AgentWatchEvent['metadata'], context: EnrichContext): AgentWatchEvent['metadata'] {
  if (!metadata) return undefined;

  const filePath = metadata[FILE_PATH_METADATA_KEY];
  const withSafePath = typeof filePath === 'string' ? { ...metadata, ...pathFields(filePath, context) } : metadata;

  return rewritePathsDeep(withSafePath, context.rewriter) as Record<string, unknown>;
}

/**
 * The path fields for one tool call: the safe path, plus which repository it is
 * relative to when that repository was found beneath the start folder.
 *
 * @param filePath - Absolute path from a tool payload.
 * @param context - Batch-wide resolved context.
 * @returns The metadata fields to overwrite.
 */
function pathFields(filePath: string, context: EnrichContext): Record<string, string> {
  const root = context.repositories.get(filePath);

  if (!root) return { [FILE_PATH_METADATA_KEY]: toSafePath(filePath, context.git.repositoryRoot) };

  return {
    [FILE_PATH_METADATA_KEY]: path.relative(root, filePath),
    // Relative, never absolute: the machine's layout is not the product's
    // business, and the turn tracker only ever needs it back as a suffix of
    // the same start folder.
    [REPOSITORY_PATH_METADATA_KEY]: relativize(context.options.cwd, root)
  };
}

/**
 * Pre-compile the path substitutions for one enrichment pass.
 *
 * Repo-rooted paths become repo-relative and the home directory becomes `~`,
 * so usernames and machine layout do not leak through captured tool input,
 * output or shell commands. Textual and best-effort by design — an arbitrary
 * string can still embed a path we cannot recognize.
 *
 * @param repositoryRoot - Repository root, when inside one.
 * @param home - Developer home directory, when known.
 * @returns The rewriter; its rule list is empty when there is nothing to hide.
 */
function buildPathRewriter(repositoryRoot: string | undefined, home: string | undefined): PathRewriter {
  const rules: PathRule[] = [];

  // Order matters: the prefixed form is matched first, so `/repo/src/a.ts`
  // becomes `src/a.ts` rather than `./src/a.ts`.
  if (repositoryRoot) {
    rules.push({ pattern: prefixPattern(repositoryRoot + path.sep), replacement: '' });
    rules.push({ pattern: exactPattern(repositoryRoot), replacement: REPO_ROOT_PLACEHOLDER });
  }

  if (home) {
    rules.push({ pattern: prefixPattern(home + path.sep), replacement: HOME_PLACEHOLDER_PREFIX });
    rules.push({ pattern: exactPattern(home), replacement: HOME_PLACEHOLDER });
  }

  return { rules };
}

/**
 * Rewrite paths in every string of a value tree.
 *
 * @param value - Node of any shape.
 * @param rewriter - Pre-compiled substitutions.
 * @returns A rewritten copy.
 */
function rewritePathsDeep(value: unknown, rewriter: PathRewriter): unknown {
  if (rewriter.rules.length === 0) return value;

  if (typeof value === 'string') return rewriteText(value, rewriter);

  if (Array.isArray(value)) return value.map((item) => rewritePathsDeep(item, rewriter));

  if (!isRecord(value)) return value;

  const out: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(value)) {
    out[key] = rewritePathsDeep(entry, rewriter);
  }

  return out;
}

/**
 * Apply every substitution to one string.
 *
 * @param text - Captured text.
 * @param rewriter - Pre-compiled substitutions.
 * @returns The rewritten text.
 */
function rewriteText(text: string, rewriter: PathRewriter): string {
  let out = text;

  for (const rule of rewriter.rules) {
    out = out.replace(rule.pattern, rule.replacement);
  }

  return out;
}

/**
 * Pattern for a path prefix. The prefix already ends with a separator, so it
 * is boundary-safe on its own.
 *
 * @param prefix - Literal prefix including the trailing separator.
 * @returns A global pattern matching it.
 */
function prefixPattern(prefix: string): RegExp {
  return new RegExp(escapeRegExp(prefix), 'g');
}

/**
 * Pattern for a bare directory reference: only when it is not the start of a
 * longer path name.
 *
 * @param dir - Literal directory path.
 * @returns A global pattern matching it at a boundary.
 */
function exactPattern(dir: string): RegExp {
  return new RegExp(escapeRegExp(dir) + PATH_BOUNDARY_LOOKAHEAD, 'g');
}

/**
 * Escape a literal for safe use inside a pattern.
 *
 * @param text - Literal text.
 * @returns The escaped form.
 */
function escapeRegExp(text: string): string {
  return text.replace(RE_REGEXP_METACHARACTERS, '\\$&');
}

/**
 * A path relative to the repository root, with the root itself as ".".
 *
 * @param root - Repository root.
 * @param target - Path inside it.
 * @returns The relative path.
 */
function relativize(root: string, target: string): string {
  const relative = path.relative(root, target);

  return relative === '' ? REPO_ROOT_PLACEHOLDER : relative;
}

/**
 * A file path safe to transmit: repo-relative inside the repository, bare
 * basename outside it.
 *
 * A file the agent touched outside the repository is not the project's
 * business, and its absolute path would leak the machine's layout.
 *
 * @param filePath - Absolute path from a tool payload.
 * @param repositoryRoot - Repository root, when inside one.
 * @returns The safe form.
 */
function toSafePath(filePath: string, repositoryRoot: string | undefined): string {
  if (!repositoryRoot) return path.basename(filePath);

  const relative = path.relative(repositoryRoot, filePath);

  if (relative.startsWith('..') || path.isAbsolute(relative)) return path.basename(filePath);

  return relative;
}
