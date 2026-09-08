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
export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 429]);

/**
 * The backend refusing the credential itself.
 *
 * Deliberately *not* retryable: a revoked or rotated token does not become
 * valid by waiting, and re-presenting it on every hook for a week reads to the
 * backend's security monitoring as low-rate credential stuffing from every
 * developer machine at once — and to the operator as nothing at all. The
 * records stay queued; what stops is the retrying.
 */
export const AUTH_REJECTED_STATUSES: ReadonlySet<number> = new Set([401, 403]);

/**
 * Ceiling on a response body the hook will decode.
 *
 * Generous: every body the edge reads back is a handful of integers. It exists
 * so an endpoint cannot make the coding agent's hook allocate an arbitrarily
 * large buffer — the request timeout bounds the request, not the decode.
 */
export const MAX_RESPONSE_BYTES = 64 * 1024;

/** Reason a body was refused; never carries any of the body itself. */
export const BODY_TOO_LARGE = 'response body too large';

/** Request headers every batch carries. */
export const CONTENT_TYPE_HEADER = 'content-type';
export const CONTENT_LENGTH_HEADER = 'content-length';
export const USER_AGENT_HEADER = 'user-agent';
export const AUTHORIZATION_HEADER = 'authorization';
export const INSTALLATION_HEADER = 'x-agentwatch-installation';
export const JSON_CONTENT_TYPE = 'application/json';
export const USER_AGENT = 'agentwatch-edge';

/** Filenames under the data directory. */
export const COOLDOWN_FILE_NAME = 'backend-cooldown.json';
export const DELIVERY_STATS_FILE_NAME = 'delivery-stats.json';
export const AUTH_BLOCK_FILE_NAME = 'auth-block.json';

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Characters unsafe in a queue filename. */
export const RE_UNSAFE_QUEUE_NAME = /[^A-Za-z0-9_-]/g;

export const QUEUE_FILE_SUFFIX = '.json';

/**
 * Queue partition used before setup writes a token. Entries land here pinned to
 * ANY_DESTINATION, and the first identity setup configures adopts them — which
 * is the same promise ANY_DESTINATION already makes.
 */
export const UNCONFIGURED_PARTITION = 'unconfigured';

/**
 * Queue partition for a backlog written before the queue was partitioned, on a
 * machine that already serves more than one identity. Nothing drains it: those
 * entries record no identity, and guessing one is precisely how one tenant's
 * usage lands in another tenant's ledger.
 */
export const UNATTRIBUTED_PARTITION = 'unattributed';

/**
 * Hex characters of the token digest that names a partition. 48 bits is far
 * more than the handful of identities one machine holds, and a digest rather
 * than the token itself keeps the bearer out of every `ls`, backup and crash
 * dump that ever touches the data directory.
 */
export const IDENTITY_FINGERPRINT_CHARS = 12;

/** Under the data directory: one sub-directory per identity for cooldown and loss stats. */
export const IDENTITY_STATE_DIR_NAME = 'identity';
