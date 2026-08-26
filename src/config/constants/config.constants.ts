/** Delivery defaults. Small on purpose: hooks run on the agent's critical path. */
export const DEFAULT_SEND_TIMEOUT_MS = 1500;
export const DEFAULT_DRAIN_BATCH_SIZE = 25;
export const DEFAULT_MAX_QUEUE_EVENTS = 2000;
export const DEFAULT_MAX_ATTEMPTS = 20;
export const DEFAULT_MAX_EVENT_AGE_DAYS = 7;

/**
 * Pre-turn budget check defaults.
 *
 * The timeout is a hard ceiling on a request that sits between the developer
 * pressing enter and their agent starting work, and the TTL mirrors the cache
 * the platform keeps for the same decision.
 */
export const DEFAULT_ENFORCEMENT_TIMEOUT_MS = 300;
export const DEFAULT_ENFORCEMENT_CACHE_TTL_MS = 60_000;

/** Native OTLP signal names, in report order. */
export const OTEL_SIGNAL_NAMES = ['logs', 'traces', 'metrics'] as const;

/** O(1) validation of a `--otel` list entry. */
export const OTEL_SIGNAL_NAME_SET: ReadonlySet<string> = new Set<string>(OTEL_SIGNAL_NAMES);

/** Shorthands accepted by `--otel`. */
export const OTEL_ALL = 'all';
export const OTEL_NONE = 'none';

/** Backend routes derived from the configured base endpoint. */
export const EVENTS_PATH = '/v1/events';
export const OTLP_BASE_PATH = '/v1/otlp';
export const ENFORCEMENT_PATH = '/v1/enforcement/decision';

/** Repository-level overrides file, found by walking up from the working directory. */
export const REPO_CONFIG_NAME = '.agentwatch.json';

/**
 * Keys a repo file may not set: it is committed and shared, so secrets and
 * per-machine identity stay in the global ~/.agentwatch/config.json only.
 * Delivery destinations are global-only too — a repo file that redirected them
 * would exfiltrate the global bearer token along with the telemetry.
 */
export const GLOBAL_ONLY_KEYS: ReadonlySet<string> = new Set([
  'token',
  'installationId',
  'developerEmail',
  'endpoint',
  'eventsUrl',
  'otlpUrl',
  'enforcementUrl'
]);

/**
 * Whole blocks a repo file may not touch.
 *
 * `delivery` governs the machine-global offline queue (size bound, retry
 * budget, age limit): a committed repo file could truncate every other repo's
 * backlog through it. `otel` is materialized into machine-global agent config
 * at setup time, so a repo file could never apply it — and must not be able to
 * silence the usage ledger. `enforcement` decides whether a budget cap marked
 * `block` is acted on: a committed repo file that could turn it off — or point
 * the check at a server that always answers `allow` — would be a one-line,
 * repository-wide bypass of every cap in the tenant.
 */
export const GLOBAL_ONLY_BLOCKS = ['delivery', 'otel', 'enforcement'] as const;

/**
 * Emission toggles a repo file may not narrow. `llm.call` is the mandatory
 * usage ledger and `turn.summary` is the only hook-path usage record: a repo
 * file may narrow *capture* (prompts, responses, files) but must never be able
 * to silence usage telemetry for everyone who clones the repository.
 */
export const GLOBAL_ONLY_EMIT_KEYS: ReadonlySet<string> = new Set(['llmCalls', 'turnSummaries']);

/** Nested blocks merged field-by-field instead of replaced wholesale. */
export const MERGE_BLOCKS = ['capture', 'emit'] as const;

/** Ceiling on the upward walk looking for a repo config. */
export const MAX_WALK_DEPTH = 32;

/** Capture flags that mean raw content leaves the machine. */
export const CONTENT_CAPTURE_FLAGS = ['prompts', 'responses', 'toolInput', 'toolOutput'] as const;

export const RE_TRAILING_SLASHES = /\/+$/;
