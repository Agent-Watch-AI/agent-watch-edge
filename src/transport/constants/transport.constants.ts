/**
 * Destination for events queued before any endpoint is configured: they are
 * explicitly waiting for whatever backend `setup` configures first. Legacy
 * entries without a destination have the same pre-setup behavior.
 */
export const ANY_DESTINATION = '*';

/** How long hooks skip direct sends after the backend failed one. */
export const BACKEND_COOLDOWN_MS = 60_000;

/**
 * Bound on individual poison-isolation sends per drain pass.
 *
 * Drain runs on the coding agent's hook critical path and each send may cost the
 * full transport timeout, so isolation must never stack up enough sends to trip
 * the agent's own hook timeout.
 */
export const MAX_ISOLATION_SENDS = 3;

/** Exponential backoff for a failed queue entry, and its ceiling. */
export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;

/** Jitter band applied to the backoff, so retries of a batch spread out. */
export const BACKOFF_JITTER_MIN = 0.75;
export const BACKOFF_JITTER_RANGE = 0.5;

/** Lock names serializing the two multi-process operations. */
export const QUEUE_DRAIN_LOCK = 'queue-drain';
export const DELIVERY_STATS_LOCK = 'delivery-stats';

/** Bounded wait for the drain lock when setup re-routes the backlog. */
export const RETARGET_LOCK_WAIT_MS = 10_000;
export const RETARGET_LOCK_POLL_MS = 50;

/** Bounded: recordRejected runs on the hook path and must never stall it. */
export const STATS_LOCK_MAX_WAIT_MS = 300;
export const STATS_LOCK_POLL_MS = 25;

/** HTTP statuses worth retrying that are not 5xx. */
export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([401, 403, 408, 429]);

/** Request headers every batch carries. */
export const CONTENT_TYPE_HEADER = 'content-type';
export const USER_AGENT_HEADER = 'user-agent';
export const AUTHORIZATION_HEADER = 'authorization';
export const INSTALLATION_HEADER = 'x-agentwatch-installation';
export const JSON_CONTENT_TYPE = 'application/json';
export const USER_AGENT = 'agentwatch-bridge';

/** Filenames under the data directory. */
export const COOLDOWN_FILE_NAME = 'backend-cooldown.json';
export const DELIVERY_STATS_FILE_NAME = 'delivery-stats.json';

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Characters unsafe in a queue filename. */
export const RE_UNSAFE_QUEUE_NAME = /[^A-Za-z0-9_-]/g;

export const QUEUE_FILE_SUFFIX = '.json';
