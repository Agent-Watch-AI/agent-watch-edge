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

/**
 * Hosts a plain-`http:` backend URL is allowed to name.
 *
 * A local collector and the test suite are the only legitimate `http:`
 * destinations; anywhere else the bearer and the captured content would cross a
 * network in cleartext.
 */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Said to whoever wrote the URL, so the remedy is in the message. */
export const DELIVERABLE_URL_MESSAGE = 'must be an https:// URL (http:// is allowed for localhost only)';

/**
 * Every field of the config file itself that holds a backend URL.
 *
 * One list, so a fifth URL field is reported by `nonDeliverableUrlFields` the
 * moment the schema validates it.
 */
export const URL_FIELDS: readonly string[] = ['endpoint', 'eventsUrl', 'otlpUrl', 'enforcementUrl'];

/**
 * The subset a `roots[]` entry may carry.
 *
 * Not the same set, and reporting them as if it were made `doctor` *fail* on a
 * `roots[].enforcementUrl`: `rootOverrideSchema` strips it as an unknown key
 * whatever its value, so it has never had any effect. A per-root enforcement URL
 * would mean adding it there, not reporting it here.
 */
export const ROOT_URL_FIELDS: readonly string[] = ['endpoint', 'eventsUrl', 'otlpUrl'];
export const OTLP_BASE_PATH = '/v1/otlp';
export const ENFORCEMENT_PATH = '/v1/enforcement/decision';

/** Repository-level overrides file, found by walking up from the working directory. */
export const REPO_CONFIG_NAME = '.agentwatch.json';

/**
 * Per-project identity block in the global config: absolute project root ->
 * the credentials and endpoints to use for work under it. This is how one
 * machine reports to two tenants; the repo file still cannot set any of it,
 * which is why the key is global-only like the fields it carries.
 */
export const ROOTS_KEY = 'roots';

/**
 * Keys a repo file may not set: it is committed and shared, so secrets and
 * per-machine identity stay in the global ~/.agentwatch/config.json only.
 * Delivery destinations are global-only too — a repo file that redirected them
 * would exfiltrate the global bearer token along with the telemetry.
 */
export const GLOBAL_ONLY_KEYS: ReadonlySet<string> = new Set([
  'contentCaptureConsent',
  'token',
  'installationId',
  'developerEmail',
  'endpoint',
  'eventsUrl',
  'otlpUrl',
  'enforcementUrl',
  ROOTS_KEY
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

/**
 * The four capture flags that carry raw content off the machine.
 *
 * Named once because two rules key on exactly this set: the consent gate zeroes
 * them on load, and `saveConfig` preserves the user's own values rather than the
 * gated ones, so granting consent later restores a choice instead of finding it
 * erased.
 */
export const CONTENT_CAPTURE_KEYS = ['prompts', 'responses', 'toolInput', 'toolOutput'] as const;

/** The capture block, which a repo file may narrow but never widen. */
export const CAPTURE_KEY = 'capture';

/** Nested blocks merged field-by-field instead of replaced wholesale. */
export const MERGE_BLOCKS = [CAPTURE_KEY, 'emit'] as const;

/** Ceiling on the upward walk looking for a repo config. */
export const MAX_WALK_DEPTH = 32;

export const RE_TRAILING_SLASHES = /\/+$/;

/** Explicit routes belong to the backend selected at enrollment. */
export const ROUTE_FIELDS = ['eventsUrl', 'otlpUrl', 'enforcementUrl'] as const;
