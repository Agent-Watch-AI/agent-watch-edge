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

/** Hex characters kept from the repository digest that names a state file. */
export const SNAPSHOT_STATE_HASH_LENGTH = 32;
