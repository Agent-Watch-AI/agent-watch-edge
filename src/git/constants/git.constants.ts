/** Default budget for one git invocation; hooks run on the critical path. */
export const GIT_TIMEOUT_MS = 1000;

/** Cap on the changedFiles list; a huge dirty tree must not bloat an event. */
export const MAX_CHANGED_FILES = 50;

/** Prepended to every git call: status and diff then never write `index.lock`. */
export const GIT_NO_OPTIONAL_LOCKS = '--no-optional-locks';

/** stdout ceiling per git process. */
export const GIT_MAX_BUFFER_BYTES = 1024 * 1024;

/**
 * Cap on the developer display name, matching the backend's `shortText`.
 *
 * The backend validates `developer_name` at 500 characters, and the field sits
 * on the turn summary — so an over-long name fails the parse and drops the
 * whole summary rather than just the name. The sanitizer's 8192 is no help
 * here: it is far above the limit that actually decides. A cosmetic value must
 * never be able to cost a turn, so it is truncated at the boundary that knows
 * the limit instead of being sent and refused.
 */
export const MAX_DEVELOPER_NAME_LENGTH = 500;

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
export const GIT_USER_NAME_ARGS = ['config', '--get', 'user.name'] as const;

/** Where `origin/HEAD` points: the remote's default branch, when it is known locally. */
export const GIT_ORIGIN_HEAD_ARGS = ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'] as const;

/** Field separator inside one `for-each-ref` / `log` record. */
export const GIT_FIELD_SEPARATOR = '';

/**
 * The recent branches, newest commit first, with the heads the cache is
 * compared against.
 *
 * One process for the whole listing, and it carries the heads — which is what
 * lets the cache diff run before any `git log`. On an ordinary closing turn,
 * where nothing moved, that is the difference between two git processes and
 * twelve.
 *
 * @param count - How many branches to list, newest commit first.
 * @returns The argument vector.
 */
export function gitRecentBranchesArgs(count: number): readonly string[] {
  return [
    'for-each-ref',
    'refs/heads',
    '--sort=-committerdate',
    `--count=${String(count)}`,
    `--format=%(refname:short)${GIT_FIELD_SEPARATOR}%(objectname)${GIT_FIELD_SEPARATOR}%(committerdate:iso-strict)`
  ];
}

/**
 * The commits on a branch that its default branch does not have.
 *
 * The delta, never the history: `git log <branch>` would carry the trunk's
 * commits into every branch's evidence, so unrelated work would be described
 * by the same subjects and named as one feature.
 *
 * @param defaultBranch - The trunk to subtract.
 * @param branch - The branch to describe.
 * @param count - Ceiling on the commits returned.
 * @returns The argument vector.
 */
export function gitBranchDeltaArgs(defaultBranch: string, branch: string, count: number): readonly string[] {
  return [
    'log',
    '-n',
    String(count),
    `--format=%H${GIT_FIELD_SEPARATOR}%s${GIT_FIELD_SEPARATOR}%aI`,
    `${defaultBranch}..${branch}`,
    '--'
  ];
}

/**
 * Whether a ref exists at all, for the local fallback when no `origin/HEAD` does.
 *
 * @param ref - The ref to test.
 * @returns The argument vector, which exits non-zero when the ref is absent.
 */
export function gitVerifyRefArgs(ref: string): readonly string[] {
  return ['rev-parse', '--verify', '-q', `${ref}^{commit}`];
}

/** What a repository's trunk is called when neither git nor the platform said. */
export const ASSUMED_DEFAULT_BRANCHES = ['main', 'master'] as const;

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

/**
 * What the gate reads out of a working copy, and how far it looks.
 *
 * The same ceiling the repository-config walk uses, for the same reason: a walk
 * that never ends is a hook that never answers.
 */
export const GATE_MAX_WALK_DEPTH = 32;

/** A linked worktree's `.git` file names its real git directory on one line. */
export const GATE_GITDIR_PREFIX = 'gitdir:';

/** `HEAD` on a branch; anything else is a detached HEAD, which names none. */
export const GATE_BRANCH_REF_PREFIX = 'ref: refs/heads/';

/**
 * How long a remembered remote is trusted.
 *
 * A remote changes approximately never, which is the whole reason this is
 * memoised — but `git remote set-url` does happen, and a memo with no expiry
 * would pin a checkout to its old repository for good. An hour is one
 * subprocess per checkout per working session, and at most an hour of a
 * repository being reported under the name it had this morning.
 */
export const GATE_REMOTE_MEMO_TTL_MS = 3_600_000;

/**
 * And how long "this checkout has no usable remote" is remembered.
 *
 * Much shorter, because the answer cannot be trusted the way a remote can.
 * `runGit` resolves undefined for a missing key *and* for a timeout, a git that
 * is not on PATH, a spawn that failed — indistinguishable from here. Remembered
 * for an hour, one overrun of the one-second budget on a cold checkout would
 * silence every feature cap in that repository for the rest of the hour, with a
 * debug line as the only trace. A minute bounds that, and a genuinely
 * remoteless checkout pays one subprocess a minute rather than one per prompt.
 */
export const GATE_REMOTE_ABSENT_TTL_MS = 60_000;

/**
 * The entry that marks a repository root. A *file* of that name counts too:
 * that is what a linked worktree and a submodule check out as.
 */
export const GIT_ENTRY_NAME = '.git';

/**
 * The errors that mean "no `.git` here". Anything else — a permission or I/O
 * error — means the answer is unknown, not no.
 */
export const GIT_ENTRY_ABSENT_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR']);

/**
 * One fingerprint of a checkout: HEAD, branch and every dirty entry in one
 * process. NUL-separated so a path is never quoted, split or trimmed; every
 * untracked file listed on its own, since editing a file inside an untracked
 * directory need not re-stamp the directory.
 */
export const GIT_FINGERPRINT_ARGS = ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'] as const;

/** Git's empty tree: what an unborn HEAD's first commit is diffed against. */
export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Header lines of porcelain v2 `--branch` output that the fingerprint keeps. */
export const PORCELAIN_V2_OID_HEADER = '# branch.oid ';
export const PORCELAIN_V2_HEAD_HEADER = '# branch.head ';

/** What porcelain v2 says in place of an oid or a branch when there is none. */
export const PORCELAIN_V2_NO_OID = '(initial)';
export const PORCELAIN_V2_DETACHED = '(detached)';

/**
 * Space-separated fields before the path on each porcelain v2 entry kind:
 * ordinary (`1`), rename or copy (`2`, followed by the original path as its own
 * NUL record), unmerged (`u`), untracked (`?`).
 */
export const PORCELAIN_V2_PATH_FIELD: Readonly<Record<string, number>> = { 1: 8, 2: 9, u: 10, '?': 1 };

/** Porcelain v2 kinds whose entry is followed by one more NUL record, the original path. */
export const PORCELAIN_V2_RENAME_KIND = '2';

/** A full SHA-1 or SHA-256 object id. */
export const RE_OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** XY stand-in for an untracked entry, which porcelain v2 gives none. */
export const PORCELAIN_V2_UNTRACKED_XY = '??';

/** A linked worktree's git dir names the shared one in this file. */
export const GIT_COMMONDIR_FILE = 'commondir';

/**
 * Cap on the files a turn reports as changed in its work checkout, the
 * gateway's own bound on the list: a longer one would refuse the summary whole.
 */
export const MAX_WORK_CHANGED_FILES = 500;

/**
 * The files two commits differ in, NUL-separated so no path comes back quoted.
 *
 * @param from - The oid the turn started on.
 * @param to - The oid or ref it ended on.
 * @returns The argument vector.
 */
export function gitDiffNamesArgs(from: string, to: string): readonly string[] {
  return ['diff', '--name-only', '-z', from, to, '--'];
}
