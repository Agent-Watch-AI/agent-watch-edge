/**
 * How many branches one snapshot describes.
 *
 * The ten most recently committed: enough to cover what anyone is actually
 * working on, few enough that the listing is one cheap git process and the
 * backend's per-branch transaction count stays bounded.
 */
export const SNAPSHOT_BRANCH_COUNT = 10;

/**
 * How many of a branch's own commits travel with it.
 *
 * They become the titles the backend's grouping agent reads, so this is a
 * window on recent work rather than an archive: a branch is described by what
 * has been done on it lately, and the window is what keeps a long-lived branch
 * from accumulating hundreds of rows.
 */
export const SNAPSHOT_COMMITS_PER_BRANCH = 20;

/**
 * Total budget for the whole snapshot flow.
 *
 * It is awaited, so it delays the hook's answer — a dangling promise would be
 * killed by process exit before the queue write landed, which is worse than
 * being slow. One second buys the two listing processes plus a log for each
 * branch that actually moved, and an overrun simply stops: the next turn
 * retries, and nothing about a snapshot is urgent.
 */
export const SNAPSHOT_BUDGET_MS = 1000;

/**
 * How long a branch may go unreported before it is sent again unchanged.
 *
 * The heartbeat exists for one case: a tracker connected after the work on a
 * branch was finished. Nothing on the developer's machine will ever change that
 * branch again, so without a periodic re-send the backend would never get
 * another chance to ask a tracker about it.
 */
export const SNAPSHOT_REFRESH_MS = 6 * 60 * 60 * 1000;

/**
 * Caps the backend states in its own schema, applied here so nothing is lost.
 *
 * The backend drops an entry it cannot store rather than refusing the snapshot,
 * so an over-long subject sent verbatim would silently cost that commit its
 * row. Truncated, it still names the work — which is all the drafting agent
 * reads it for. The generic scrubber's limit is 8192 characters and says
 * nothing about this contract.
 */
export const SNAPSHOT_MAX_SUBJECT_LENGTH = 200;

/**
 * The longest branch name the backend stores.
 *
 * A name it cannot store costs that branch its row, and a branch name this long
 * is not a name anyone typed — so it is dropped rather than truncated, which
 * would report work under a name that does not exist.
 */
export const SNAPSHOT_MAX_BRANCH_NAME_LENGTH = 255;

/** Hex characters kept from the repository digest that names a state file. */
export const SNAPSHOT_STATE_HASH_LENGTH = 32;
