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

/**
 * Metadata key naming the repository a tool call's file belongs to, relative
 * to the cwd of the hook that resolved it.
 *
 * Local assembly state only: the turn tracker reads it to decide which
 * repository a turn worked in, and it never reaches a product record.
 */
export const REPOSITORY_PATH_METADATA_KEY = 'repositoryPath';

/** Shared empty answer for a batch with no per-file repository to resolve. */
export const EMPTY_REPOSITORIES: ReadonlyMap<string, never> = new Map<string, never>();
