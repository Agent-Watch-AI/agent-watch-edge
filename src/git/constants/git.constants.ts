/** Default budget for one git invocation; hooks run on the critical path. */
export const GIT_TIMEOUT_MS = 1000;

/** Cap on the changedFiles list; a huge dirty tree must not bloat an event. */
export const MAX_CHANGED_FILES = 50;

/** stdout ceiling per git process. */
export const GIT_MAX_BUFFER_BYTES = 1024 * 1024;

/**
 * Argument vectors, named so a reader sees intent instead of flags.
 *
 * `symbolic-ref` rather than `branch --show-current`: the latter needs
 * git >= 2.22, and its absence would silently drop branch — and therefore
 * ticket — attribution on older machines. It exits non-zero on a detached
 * HEAD, which is exactly the "no branch" answer we want.
 */
export const GIT_REPO_ROOT_ARGS = ['rev-parse', '--show-toplevel'] as const;
export const GIT_BRANCH_ARGS = ['symbolic-ref', '--short', '-q', 'HEAD'] as const;
export const GIT_COMMIT_ARGS = ['rev-parse', 'HEAD'] as const;
export const GIT_REMOTE_ARGS = ['config', '--get', 'remote.origin.url'] as const;
export const GIT_STATUS_ARGS = ['status', '--porcelain'] as const;
export const GIT_USER_EMAIL_ARGS = ['config', '--get', 'user.email'] as const;

/** Node's error code for a child process that overran maxBuffer on stdout. */
export const STDOUT_MAXBUFFER_CODE = 'ERR_CHILD_PROCESS_STDOUT_MAXBUFFER';

/** Length of the "XY " status prefix before the path in porcelain output. */
export const PORCELAIN_PREFIX_LENGTH = 3;

/** Separator between the old and new path of a rename in porcelain output. */
export const PORCELAIN_RENAME_SEPARATOR = ' -> ';

/** C-style escapes git emits inside a quoted path (core.quotePath). */
export const PORCELAIN_ESCAPES: Readonly<Record<string, string>> = {
  n: '\n',
  t: '\t',
  r: '\r',
  a: '\x07',
  b: '\b',
  f: '\f',
  v: '\v',
  '"': '"',
  '\\': '\\'
};

/** Trailing whitespace only: porcelain lines carry significant leading spaces. */
export const RE_TRAILING_WHITESPACE = /\s+$/;

/** A URL scheme followed by "://". */
export const RE_URL_SCHEME = /^[A-Za-z][\w+.-]*:\/\//;

/** `scheme://user@` and `scheme://user:password@` prefixes. */
export const RE_URL_USERINFO = /^(\w+:\/\/)[^/@\s]+@/;
export const RE_URL_USERINFO_WITH_PASSWORD = /^(\w+:\/\/)[^/@\s]+:[^/@\s]+@/;

/** Leading `user@` of an scp-like remote. */
export const RE_SCP_USERINFO = /^[^@/\s]+@/;

/**
 * scp-like remote: `host:path`. Two or more characters before the colon keeps
 * Windows drive paths ("C:\\...") out.
 */
export const RE_SCP_REMOTE = /^([\w.-]{2,}):([^\s]+)$/;

export const RE_LEADING_SLASHES = /^\/+/;
export const RE_TRAILING_SLASHES = /\/+$/;
export const RE_DOT_GIT_SUFFIX = /\.git$/;
