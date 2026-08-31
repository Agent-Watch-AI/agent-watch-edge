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

/** What setup asks for when nothing on the machine names the developer. */
export const DEVELOPER_EMAIL_PROMPT = 'Developer email: ';

/** Doctor's name for the identity every per-developer decision is keyed on. */
export const DEVELOPER_IDENTITY_CHECK = 'developer identity';

/**
 * The unattributable install, and the two ways out of it.
 *
 * Named together everywhere the condition surfaces: the machine hitting this is
 * the one whose owner is not watching the terminal, so the message has to carry
 * the whole fix rather than a hint to go looking for it.
 */
export const NO_DEVELOPER_IDENTITY = 'no developer identity: `git config user.email` is unset here and --developer-email was not given';
export const DEVELOPER_IDENTITY_REMEDIES =
  'set one with `git config --global user.email you@company.com`, or re-run setup with `--developer-email you@company.com`';

/** Said on the failure path, because a half-written config is worse than none. */
export const NO_CONFIG_WRITTEN = 'no configuration was written; re-run setup once the identity resolves';

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
