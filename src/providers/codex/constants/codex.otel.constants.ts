/**
 * Markers delimiting the block AgentWatch owns inside the user's config.toml.
 *
 * Codex's telemetry lives in a `[otel]` table in `~/.codex/config.toml`
 * (project-level files ignore the key, so only the user-level one works).
 * Rewriting that file through a TOML serializer would destroy the developer's
 * comments and formatting, so instead we own a marker-delimited block appended
 * to it — and only when no foreign `[otel]` table already exists.
 */
export const BLOCK_START = '# >>> agentwatch managed block — do not edit; `agentwatch uninstall` removes it >>>';
export const BLOCK_END = '# <<< agentwatch managed block <<<';

/** The one config key the managed block owns. */
export const OTEL_TABLE_KEY = 'otel';

/** Signals Codex actually exports; `metrics` has no effect there. */
export const CODEX_OTEL_SIGNALS = ['logs', 'traces'] as const;

/** OTLP/HTTP signal routes; Codex needs full endpoints, not a base. */
export const LOGS_PATH = '/v1/logs';
export const TRACES_PATH = '/v1/traces';

export const RE_LEADING_NEWLINE = /^\n/;
export const RE_TRAILING_NEWLINES = /\n+$/;
export const RE_TOML_BACKSLASH = /\\/g;
export const RE_TOML_QUOTE = /"/g;
