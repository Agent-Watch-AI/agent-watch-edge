import path from 'node:path';

/** Characters that must be escaped to embed a literal path in a pattern. */
export const RE_REGEXP_METACHARACTERS = /[.*+?^${}()|[\]\\]/g;

/**
 * Lookahead marking the end of a bare directory reference, so `/x/repo` does
 * not fire inside `/x/repository`.
 */
export const PATH_BOUNDARY_LOOKAHEAD = '(?=[\\s"\'`)\\]}>,;:]|$)';

/** Replacement for the developer's home directory inside captured text. */
export const HOME_PLACEHOLDER = '~';
export const HOME_PLACEHOLDER_PREFIX = `~${path.sep}`;

/** Replacement for the repository root itself (as opposed to a path under it). */
export const REPO_ROOT_PLACEHOLDER = '.';

/** Metadata key adapters use for the single primary file of a tool call. */
export const FILE_PATH_METADATA_KEY = 'filePath';
