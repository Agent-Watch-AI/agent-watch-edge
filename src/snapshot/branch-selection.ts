import { SNAPSHOT_REFRESH_MS } from './constants/snapshot.constants.js';
import type { BranchRef } from '../git/types/snapshot.types.js';
import type { SelectionInput, SnapshotState } from './types/snapshot.types.js';

/**
 * Which branches are worth describing again.
 *
 * Four reasons, and each one is a bug if it is missing:
 *
 * - the branch is new — nothing has ever been reported about it;
 * - its head moved — the obvious one;
 * - the default branch changed since the last send, because every delta was
 *   computed against the wrong base and no head has to move for that to be
 *   true;
 * - the entry is older than the heartbeat, which is the only thing that ever
 *   re-offers a finished branch to a tracker connected after the fact.
 *
 * @param input - The refs git reported and what was last sent.
 * @returns The branches to describe. Empty means send nothing at all.
 */
export function selectChangedBranches(input: SelectionInput): readonly BranchRef[] {
  const rebased = input.stored.defaultBranch !== input.defaultBranch;

  return input.refs.filter((ref) => {
    if (rebased) return true;

    const entry = input.stored.branches[ref.name];

    if (!entry) return true;

    if (entry.headSha !== ref.headSha) return true;

    return input.now - entry.lastSentAt >= SNAPSHOT_REFRESH_MS;
  });
}

/**
 * The state to store once a snapshot has been queued.
 *
 * A branch is recorded as reported only if it was actually described. The
 * cache is a record of what the platform has been told, not of what git said:
 * a branch whose head moved and which then fell outside the budget must keep
 * its *old* head here, or the next turn compares the new head against the new
 * head, finds them equal, and the work disappears until the heartbeat six hours
 * later.
 *
 * A branch that was listed but never sent is therefore left exactly as it was —
 * and one that has never been sent at all is left out, so it stays new.
 *
 * @param input - Refs, previous state and the send's own clock.
 * @param sent - The branches this snapshot actually described.
 * @returns The state to write.
 */
export function nextSnapshotState(
  input: SelectionInput,
  sent: readonly BranchRef[]
): SnapshotState {
  const sentNames = new Set(sent.map((ref) => ref.name));
  const branches: SnapshotState['branches'] = {};

  for (const ref of input.refs) {
    if (sentNames.has(ref.name)) {
      branches[ref.name] = { headSha: ref.headSha, lastSentAt: input.now };
      continue;
    }

    const previous = input.stored.branches[ref.name];

    if (previous) branches[ref.name] = previous;
  }

  // The recorded base only moves once every branch has been described against
  // it. Recording it early would end the `rebased` selection for branches whose
  // deltas were never recomputed, and they would sit on the wrong base until
  // their heads happened to move.
  const described = input.refs.every((ref) => sentNames.has(ref.name));

  return {
    defaultBranch: described ? input.defaultBranch : input.stored.defaultBranch,
    branches
  };
}
