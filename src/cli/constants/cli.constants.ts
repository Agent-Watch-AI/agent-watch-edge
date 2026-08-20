/**
 * Flags documented as taking a value.
 *
 * A flag missing from this set silently turns its value into a positional and
 * itself into a boolean — which is how `--otel none` once ignored the selection
 * entirely.
 */
export const VALUE_FLAGS: ReadonlySet<string> = new Set(['agent', 'endpoint', 'token', 'developer-email', 'otel']);

export const FLAG_PREFIX = '--';

/** Commands the CLI dispatches. */
export const COMMANDS = ['hook', 'setup', 'status', 'doctor', 'uninstall', 'agents', 'config', 'otel-headers'] as const;

/** Ceiling on a hook payload; beyond this the hook refuses rather than buffers. */
export const MAX_STDIN_BYTES = 10 * 1024 * 1024;

/** How long the hook waits for stdin before proceeding with what it has. */
export const STDIN_TIMEOUT_MS = 5_000;

/** Node major version the runtime requires. */
export const MIN_NODE_MAJOR = 20;

/**
 * prompt_id (== OTel prompt.id) appeared in this Claude Code release; older
 * versions fall back to session-scoped turn tracking with an empty turn_id.
 */
export const CLAUDE_MIN_VERSION_FOR_PROMPT_ID = '2.1.196';

/** Budgets for the diagnostics that shell out or reach the network. */
export const BACKEND_PROBE_TIMEOUT_MS = 4_000;
export const CLAUDE_VERSION_TIMEOUT_MS = 5_000;
export const GIT_VERSION_TIMEOUT_MS = 2_000;

/** Longer than the hook path's budget: status is not on anyone's critical path. */
export const STATUS_SEND_TIMEOUT_MS = 3_000;

/** Backlog age past which `doctor` starts warning. */
export const STALE_QUEUE_AGE_MS = 24 * 60 * 60 * 1000;

/** ANSI escape and colour codes for the human-facing commands. */
export const ESC = '\u001b';
export const COLOR_GREEN = '32';
export const COLOR_YELLOW = '33';
export const COLOR_RED = '31';
export const COLOR_GREY = '90';
export const COLOR_BOLD = '1';
export const COLOR_RESET = '0';

/** Set by convention to disable colour output. */
export const NO_COLOR_VAR = 'NO_COLOR';

/** Argument shapes that force quoting when a hook command is generated. */
export const RE_NEEDS_QUOTING = /[\s"'\\$`]/;
export const RE_QUOTE_ESCAPE = /(["\\$`])/g;

/** Redaction placeholder in the `config` command's output. */
export const REDACTED_TOKEN = '<redacted>';
