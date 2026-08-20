import type { ReadTurnUsageRetry } from '../types/transcript.types.js';

/** Canonical event types that mean "a tool finished doing something". */
export const TOOL_COMPLETION_TYPES: ReadonlySet<string> = new Set([
  'tool.completed',
  'tool.failed',
  'shell.completed',
  'mcp.completed',
  'file.read',
  'file.edited'
]);

/** Orphaned turn state (a crash without Stop/SessionEnd) is deleted after this. */
export const TURN_STATE_TTL_MS = 24 * 60 * 60 * 1000;

/** Overlapping Stop hooks serialize only transcript usage allocation. */
export const USAGE_LOCK_WAIT_MS = 5_000;
export const USAGE_LOCK_POLL_MS = 25;

/**
 * Stop can fire before the agent flushes its final assistant entry to the
 * transcript, so the reader keeps looking. The settle window guards multi-tool
 * turns, where early usage entries look stable long before the last one lands.
 */
export const USAGE_RETRY: ReadTurnUsageRetry = { attempts: 6, delayMs: 250, minSettleMs: 500 };

/**
 * Only the tail of a transcript is read: the turn's entries are at the end of
 * the JSONL and the retry loop re-reads the file several times per Stop, so
 * parsing tens of megabytes each pass would be pure waste on long sessions.
 */
export const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;

/** Payload key every supported agent reports its transcript path under. */
export const TRANSCRIPT_PATH_KEY = 'transcript_path';

/** Prefix distinguishing usage-claim files from turn records in a session dir. */
export const USAGE_CLAIM_PREFIX = 'usage-claim--';

/** Public provider labels; the internal id is an implementation detail. */
export const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  claude: 'claude-code',
  codex: 'codex',
  cursor: 'cursor',
  gemini: 'gemini',
  antigravity: 'antigravity'
};

/** Providers whose sessions run inside an editor rather than a terminal. */
export const IDE_SURFACE_PROVIDERS: ReadonlySet<string> = new Set(['cursor', 'antigravity']);

/** Claude Code reports its own surface here. */
export const CLAUDE_ENTRYPOINT_VAR = 'CLAUDE_CODE_ENTRYPOINT';

export const DEFAULT_SURFACE = 'cli';
export const IDE_SURFACE = 'ide';

/** Separator between several prompts collapsed into one turn. */
export const PROMPT_JOIN_SEPARATOR = '\n---\n';

/**
 * Cap on `files_touched` and `files_read`, matching the platform's own limit on
 * either list.
 *
 * This is a delivery guarantee, not a payload-size preference. The backend
 * validates the whole summary against one schema: a list one entry over its
 * bound fails that schema, the batch answers 422, and 422 is not retryable —
 * so an exploratory turn that read 501 files used to lose its tokens, its cost
 * and its ticket keys along with the file list. A long turn's file list is
 * truncated instead; that is a truncated list, not a lost turn.
 */
export const MAX_TURN_FILES = 500;

/** Fallback tool name for a call the provider did not name. */
export const UNKNOWN_TOOL_NAME = 'unknown';

/** Metadata keys the tracker reads off canonical events. */
export const PROMPT_TEXT_KEY = 'promptText';
export const PROMPT_EVIDENCE_KEY = 'prompt';
export const RESPONSE_TEXT_KEY = 'responseText';
export const RESPONSE_EVIDENCE_KEY = 'response';
export const FILE_PATH_KEY = 'filePath';

/** Length of the hashed session directory name. */
export const SESSION_DIR_HASH_LENGTH = 32;

/** Length of the hashed lock names, which must be filesystem-safe. */
export const LOCK_KEY_HASH_LENGTH = 16;

/** Characters unsafe in a per-record filename. */
export const RE_UNSAFE_NAME_CHARS = /[^A-Za-z0-9._-]/g;

/** Transcript usage field names, as the agents write them. */
export const TRANSCRIPT_INPUT_TOKENS = 'input_tokens';
export const TRANSCRIPT_OUTPUT_TOKENS = 'output_tokens';
export const TRANSCRIPT_CACHE_READ_TOKENS = 'cache_read_input_tokens';
export const TRANSCRIPT_CACHE_CREATION_TOKENS = 'cache_creation_input_tokens';

/** Every transcript token field, for weighting which model dominated a turn. */
export const TRANSCRIPT_TOKEN_FIELDS = [
  TRANSCRIPT_INPUT_TOKENS,
  TRANSCRIPT_OUTPUT_TOKENS,
  TRANSCRIPT_CACHE_READ_TOKENS,
  TRANSCRIPT_CACHE_CREATION_TOKENS
] as const;

/** Prefix for the content-hash id given to a transcript entry without one. */
export const ANONYMOUS_MESSAGE_ID_PREFIX = 'anon-';
