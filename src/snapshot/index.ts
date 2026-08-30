/**
 * What the working copy says the work is: the repository's recent branches,
 * diffed against what was last reported, so a quiet repository costs nothing.
 *
 * The second flow the hook path runs. It exists because the backend's feature
 * layer is an overlay on work items, and a team with no tracker connected has
 * none — the branches on this machine are then the only evidence that a piece
 * of work exists at all.
 */
export type {
  BuildSnapshotInput,
  SelectionInput,
  SnapshotFlowInput,
  SnapshotFlowState,
  SnapshotIdentity,
  SnapshotPipelineInput,
  SnapshotQueue,
  SnapshotState,
  SnapshotStateEntry,
  SnapshotStateReader
} from './types/snapshot.types.js';

export {
  SNAPSHOT_BRANCH_COUNT,
  SNAPSHOT_BUDGET_MS,
  SNAPSHOT_COMMITS_PER_BRANCH,
  SNAPSHOT_REFRESH_MS
} from './constants/snapshot.constants.js';
export { nextSnapshotState, selectChangedBranches } from './branch-selection.js';
export { budgetedRunner, remainingMs, withinBudget } from './budget.js';
export { buildRepoSnapshot } from './snapshot-event.js';
export { runSnapshotPipeline } from './snapshot-pipeline.js';
export { SnapshotStateStore, emptyState } from './snapshot-state.js';
