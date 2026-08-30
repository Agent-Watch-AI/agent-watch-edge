import { debugLog } from '../core/logger.js';
import { next, runFlow, step, stop } from '../core/pipe.js';
import type { FlowResult, Step, StepOutcome } from '../core/types/core.types.js';
import { collectBranchCommits, collectBranchRefs, resolveDefaultBranch } from '../git/repo-snapshot.js';
import { sanitizeValue } from '../privacy/sanitizer.js';
import { nextSnapshotState, selectChangedBranches } from './branch-selection.js';
import { budgetedRunner, remainingMs, withinBudget } from './budget.js';
import { buildRepoSnapshot } from './snapshot-event.js';
import { emptyState } from './snapshot-state.js';
import { SNAPSHOT_BRANCH_COUNT, SNAPSHOT_COMMITS_PER_BRANCH } from './constants/snapshot.constants.js';
import {
  STAGE_COLLECT_COMMITS,
  STAGE_COLLECT_REFS,
  STAGE_ENQUEUE,
  STAGE_SANITIZE,
  STAGE_SELECT_CHANGED,
  STOP_BUDGET_SPENT,
  STOP_NOTHING_CHANGED,
  STOP_NO_EVENT,
  STOP_NOT_A_REPOSITORY
} from './constants/snapshot-stages.constants.js';
import type { SnapshotBranch } from '../git/types/snapshot.types.js';
import type {
  SelectionInput,
  SnapshotFlowState,
  SnapshotPipelineInput
} from './types/snapshot.types.js';

export type {
  SnapshotFlowInput,
  SnapshotFlowState,
  SnapshotPipelineInput
} from './types/snapshot.types.js';

/**
 * The snapshot flow, as the list of stages it is.
 *
 * The order is the whole point of the design: the cache diff runs *before* any
 * `git log`. `for-each-ref` already returns every head, so an ordinary closing
 * turn — where nothing moved — costs two git processes and stops, instead of
 * spending ten logs to discover there was nothing to send.
 */
const SNAPSHOT_STAGES: readonly Step<SnapshotFlowState>[] = [
  step(STAGE_COLLECT_REFS, collectRefs),
  step(STAGE_SELECT_CHANGED, selectChanged),
  step(STAGE_COLLECT_COMMITS, collectCommits),
  step(STAGE_SANITIZE, sanitize),
  step(STAGE_ENQUEUE, enqueue)
];

/**
 * Describe this repository's recent branches, if anything about them changed.
 *
 * Never throws: it runs after the hook's own delivery has finished, and a
 * repository this cannot read is a repository the platform simply learns
 * nothing new about.
 *
 * @param pipeline - Identity and clock, the state cache and the offline queue.
 * @returns The final state and where the flow stopped.
 */
export function runSnapshotPipeline(pipeline: SnapshotPipelineInput): Promise<FlowResult<SnapshotFlowState>> {
  const initial: SnapshotFlowState = {
    input: pipeline.input,
    store: pipeline.store,
    queue: pipeline.queue,
    // Every git call in this flow goes through the budget, not only the logs:
    // the listing and the three fallbacks that resolve a trunk are four
    // sequential seconds of the hook's answer if nothing bounds them.
    run: budgetedRunner(pipeline.input.run, pipeline.input.deadline),
    refs: [],
    selected: [],
    branches: []
  };

  return runFlow(SNAPSHOT_STAGES, initial, (trace) => {
    if (trace.outcome === 'next') return;

    debugLog(`snapshot flow ${trace.outcome} at ${trace.step}${trace.reason ? `: ${trace.reason}` : ''}`);
  });
}

/**
 * The recent branches and what this repository calls its trunk.
 *
 * @param state - Current flow state.
 * @returns The state with its refs, or a stop outside a repository.
 */
async function collectRefs(state: SnapshotFlowState): Promise<StepOutcome<SnapshotFlowState>> {
  const { cwd } = state.input;
  const refs = await collectBranchRefs({ cwd, branchCount: SNAPSHOT_BRANCH_COUNT }, state.run);

  if (refs.length === 0) return stop(state, STOP_NOT_A_REPOSITORY);

  const defaultBranch = await resolveDefaultBranch(cwd, state.run);

  return next({ ...state, refs, defaultBranch });
}

/**
 * Compare the heads against what was last sent.
 *
 * @param state - Current flow state.
 * @returns The state with its selection, or a stop when nothing is due.
 */
async function selectChanged(state: SnapshotFlowState): Promise<StepOutcome<SnapshotFlowState>> {
  const stored = await state.store.read(state.input.repository);
  const selected = selectChangedBranches(selectionInput({ ...state, stored }));

  if (selected.length === 0) return stop({ ...state, stored }, STOP_NOTHING_CHANGED);

  return next({ ...state, stored, selected });
}

/**
 * The commits each selected branch has that the trunk does not.
 *
 * The budget is checked per branch rather than once: the listing is cheap and
 * the logs are not, so an overrun stops here with the branches already
 * described rather than discarding the work.
 *
 * @param state - Current flow state.
 * @returns The state with its branches, or a stop when the budget ran out
 *   before any branch was described.
 */
async function collectCommits(state: SnapshotFlowState): Promise<StepOutcome<SnapshotFlowState>> {
  const { cwd, deadline } = state.input;
  const branches: SnapshotBranch[] = [];

  for (const ref of state.selected) {
    if (remainingMs(deadline) === 0) break;

    const commits = await collectBranchCommits(
      ref.name,
      { cwd, defaultBranch: state.defaultBranch, commitCount: SNAPSHOT_COMMITS_PER_BRANCH },
      state.run
    );

    branches.push({ ...ref, commits });
  }

  if (branches.length === 0) return stop(state, STOP_BUDGET_SPENT);

  return next({ ...state, branches });
}

/**
 * Build the event and put it through the same scrubber prompt text gets.
 *
 * Branch names and commit subjects are written by people who did not expect
 * them to be transmitted, and a token pasted into a commit message is exactly
 * the kind of thing this catches.
 *
 * @param state - Current flow state.
 * @returns The state carrying the event to send.
 */
async function sanitize(state: SnapshotFlowState): Promise<StepOutcome<SnapshotFlowState>> {
  const event = buildRepoSnapshot({
    identity: state.input,
    defaultBranch: state.defaultBranch,
    branches: state.branches
  });

  return next({ ...state, event: sanitizeValue(event) });
}

/**
 * Queue the event, then record what was sent.
 *
 * The cache is written only after the queue accepted the event. Written first,
 * a failed enqueue would mark the branches as reported and nothing would ever
 * offer them again.
 *
 * @param state - Current flow state.
 * @returns The state, unchanged.
 */
async function enqueue(state: SnapshotFlowState): Promise<StepOutcome<SnapshotFlowState>> {
  if (!state.event) return stop(state, STOP_NO_EVENT);

  const { deadline } = state.input;
  const queued = await withinBudget(state.queue.enqueue([state.event]), deadline);

  // Recording a send that may not have happened is the one thing this flow must
  // never do: the branches would be marked reported and never offered again.
  if (!queued) return stop(state, STOP_BUDGET_SPENT);

  await withinBudget(
    state.store.write(state.input.repository, nextSnapshotState(selectionInput(state), state.branches)),
    deadline
  );

  return next(state);
}

/**
 * The selection's view of this flow.
 *
 * Built once so the write-back cannot disagree with the comparison that chose
 * the branches — they read the same refs, the same stored state and the same
 * clock, or a branch could be selected against one and recorded against another.
 *
 * @param state - Current flow state, with its stored state already read.
 * @returns What both the selection and the write-back are decided on.
 */
function selectionInput(state: SnapshotFlowState): SelectionInput {
  return {
    refs: state.refs,
    stored: state.stored ?? emptyState(),
    defaultBranch: state.defaultBranch,
    now: Date.parse(state.input.capturedAt)
  };
}
