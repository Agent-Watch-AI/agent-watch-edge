/** Stage names, used in the flow definition and in its debug trace. */
export const STAGE_COLLECT_REFS = 'collect-refs';
export const STAGE_SELECT_CHANGED = 'select-changed';
export const STAGE_COLLECT_COMMITS = 'collect-commits';
export const STAGE_SANITIZE = 'sanitize';
export const STAGE_ENQUEUE = 'enqueue';

/** Reasons a stage ends the flow early. */
export const STOP_NOT_A_REPOSITORY = 'no branches: not a repository, or it has none';
export const STOP_NOTHING_CHANGED = 'no branch moved and none is due a refresh';
export const STOP_BUDGET_SPENT = 'snapshot budget spent';
export const STOP_NO_EVENT = 'no snapshot event was built';
