/** Settings key Claude Code reads the OTLP header helper command from. */
export const HEADERS_HELPER_KEY = 'otelHeadersHelper';

/** Settings key holding the environment block telemetry is configured through. */
export const ENV_BLOCK_KEY = 'env';

/**
 * Environment variables that switch Claude Code's exporters on.
 *
 * A disabled exporter is written as an explicit 'none' rather than omitted, so
 * a stale ambient OTEL_* default in the developer's shell can never re-enable a
 * signal the user turned off.
 */
export const OTEL_EXPORTER_NONE = 'none';
export const OTEL_EXPORTER_OTLP = 'otlp';

/** JSON, so the backend receives one wire format from every agent. */
export const OTLP_PROTOCOL = 'http/json';

/** Trailing `hook --agent <id>` of a hook command, stripped to reuse the binary. */
export const RE_HOOK_SUFFIX = /\s+hook\s+--agent\s+\S+\s*$/;
