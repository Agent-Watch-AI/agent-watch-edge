/** Settings key holding the environment block telemetry is configured through. */
export const ENV_BLOCK_KEY = 'env';

/** Where Gemini reads OTLP auth from; it has no header-helper mechanism. */
export const OTLP_HEADERS_KEY = 'OTEL_EXPORTER_OTLP_HEADERS';

/**
 * A setting an older AgentWatch wrote here in the belief that Gemini read it.
 *
 * It does not — `otelHeadersHelper` is a Claude Code setting — so the entry is
 * cleaned up on the next `configure`. Only when it is ours, though: another
 * tool may legitimately own the same key.
 */
export const LEGACY_HELPER_KEY = 'otelHeadersHelper';

/**
 * Keys uninstall falls back to without a recorded list.
 *
 * Covers settings written before install state existed, and keeps the names an
 * older version wrote (GEMINI_ENABLE_TELEMETRY) so those are cleaned up too.
 */
export const GEMINI_LEGACY_OWNED_KEYS = [
  'GEMINI_TELEMETRY_ENABLED',
  'GEMINI_TELEMETRY_TARGET',
  'GEMINI_TELEMETRY_OTLP_ENDPOINT',
  'GEMINI_TELEMETRY_OTLP_PROTOCOL',
  'GEMINI_TELEMETRY_TRACES_ENABLED',
  'GEMINI_ENABLE_TELEMETRY',
  'OTEL_METRICS_EXPORTER',
  'OTEL_LOGS_EXPORTER',
  'OTEL_TRACES_EXPORTER',
  'OTEL_EXPORTER_OTLP_PROTOCOL',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  OTLP_HEADERS_KEY,
  LEGACY_HELPER_KEY
] as const;

export const OTEL_EXPORTER_NONE = 'none';
export const OTEL_EXPORTER_OTLP = 'otlp';

/**
 * Gemini's own protocol setting accepts `grpc` or `http` and *throws*
 * FatalConfigError on anything else — notably on `http/json`, which is valid
 * only for the standard OTEL_EXPORTER_OTLP_PROTOCOL.
 */
export const GEMINI_OTLP_PROTOCOL = 'http';
export const STANDARD_OTLP_PROTOCOL = 'http/json';

/**
 * Ship the batch to the local endpoint, not to Google Cloud. The default is
 * local today, but `gcp` would send this telemetry somewhere else entirely, and
 * that is not a default worth inheriting.
 */
export const GEMINI_TELEMETRY_TARGET_LOCAL = 'local';
