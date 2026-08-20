import path from 'node:path';

/** Directory name AgentWatch owns under $HOME. */
export const AGENTWATCH_DIR_NAME = 'agentwatch';
export const AGENTWATCH_HOME_DIR_NAME = '.agentwatch';

/** Environment overrides for the two roots, used by the test suite. */
export const CONFIG_DIR_VAR = 'AGENTWATCH_CONFIG_DIR';
export const DATA_DIR_VAR = 'AGENTWATCH_DATA_DIR';

export const CONFIG_FILE_NAME = 'config.json';
export const INSTALL_STATE_FILE_NAME = 'install-state.json';

/** Sub-directories of the data root. */
export const QUEUE_DIR_NAME = 'queue';
export const LOCKS_DIR_NAME = 'locks';
export const BACKUPS_DIR_NAME = 'backups';
export const TURNS_DIR_NAME = 'turns';

/** XDG / Windows locations consulted for the data root, in order. */
export const LOCAL_APP_DATA_VAR = 'LOCALAPPDATA';
export const XDG_DATA_HOME_VAR = 'XDG_DATA_HOME';
export const POSIX_DATA_FALLBACK = path.join('.local', 'share');

/**
 * Files that may hold a backend token or raw prompt text are owner-only.
 */
export const SECRET_FILE_MODE = 0o600;

/** Mask isolating the permission bits of a stat mode. */
export const PERMISSION_MASK = 0o777;

/**
 * Locks older than this are broken: hook processes are short-lived and can die
 * abruptly, and a leaked lock file must not stall every later hook forever.
 */
export const STALE_LOCK_MS = 30_000;

/** Attempts one acquireLock call makes, including breaking one stale lock. */
export const LOCK_ACQUIRE_ATTEMPTS = 2;

/** Characters that are unsafe in a timestamped backup filename. */
export const RE_UNSAFE_STAMP_CHARS = /[:.]/g;
