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

/** Canonical event types that mean "a tool is about to run": where a turn names its checkouts. */
export const TOOL_START_TYPES: ReadonlySet<string> = new Set(['tool.started', 'shell.started', 'mcp.started']);

/**
 * Completions whose shell command is read again for a checkout it created. A
 * failed call is `tool.failed` whatever the tool; the provider's `shellCall`
 * answers only for a shell.
 */
export const SHELL_REREAD_TYPES: ReadonlySet<string> = new Set(['shell.completed', 'tool.failed']);

/** Orphaned turn state (a crash without Stop/SessionEnd) is deleted after this. */
export const TURN_STATE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How often the expiry sweep may actually walk the state root.
 *
 * It used to run after every closing turn and every session end — a `readdir`
 * plus a `stat` per file of every recent session, on the hook path, almost
 * always to find that nothing was 24 h old yet. Hourly keeps removal well
 * inside the TTL's own tolerance and costs one `stat` on the common path.
 */
export const TURN_STATE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

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

/**
 * The one file in a session dir that is not a turn record: what model the
 * session is on, so a later hook's gate can state it.
 */
export const SESSION_MODEL_FILE = 'session.json';

/** The folder the session started in, written once by its first hook: `{ cwd }`. */
export const SESSION_START_FILE = 'session-start.json';

/**
 * The checkout the session's last changing turn worked in: `{ root, repository, at }`.
 * Carried by a turn that changes nothing, and read by the prompt gate (AWT-128).
 */
export const WORK_CHECKOUT_FILE = 'work-checkout.json';

/** Session-wide files beside the records; none of them is a turn record. */
export const SESSION_FILES: ReadonlySet<string> = new Set([SESSION_MODEL_FILE, SESSION_START_FILE, WORK_CHECKOUT_FILE]);

/** Prefix of a checkout record's filename: `checkout--<turn>-<root>-<call>.json`. */
export const CHECKOUT_RECORD_PREFIX = 'checkout--';

/** Hash length of each part of a checkout record's filename. */
export const CHECKOUT_KEY_HASH_LENGTH = 16;

/** Checkouts one turn may name; past it, new ones are ignored (seven days of real turns peak at five). */
export const MAX_TURN_CHECKOUTS = 8;

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

/**
 * Bounds on the content a summary carries under the content flags. Applied after
 * the text was scrubbed whole, never before: a cut through a credential leaves
 * a prefix no pattern matches.
 *
 * ponytail: fixed character cuts, sized so a request plus a pasted link or a
 * sheet id fits. A turn of 200 shell calls sends its first 50; per-tenant
 * bounds would come from the backend.
 */
export const MAX_PROMPT_TEXT_LENGTH = 4000;
export const MAX_TOOL_INPUT_LENGTH = 2000;
export const MAX_TURN_TOOL_INPUTS = 50;

/** Fallback tool name for a call the provider did not name. */
export const UNKNOWN_TOOL_NAME = 'unknown';

/** Metadata keys the tracker reads off canonical events. Evidence only: no text key exists. */
export const PROMPT_EVIDENCE_KEY = 'prompt';
export const RESPONSE_EVIDENCE_KEY = 'response';
export const FILE_PATH_KEY = 'filePath';
export const EXTERNAL_PATH_KEY = 'externalPath';
export const PROMPT_TEXT_KEY = 'promptText';

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
