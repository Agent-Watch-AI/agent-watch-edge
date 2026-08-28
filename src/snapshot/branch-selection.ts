import { SNAPSHOT_REFRESH_MS } from './constants/snapshot.constants.js';
import type { BranchRef } from '../git/types/snapshot.types.js';
import type { SnapshotState } from './types/snapshot.types.js';

export interface SelectionInput {
  readonly refs: readonly BranchRef[];
  readonly stored: SnapshotState;
  readonly defaultBranch?: string;
  readonly now: number;
}

/**
 * Which branches are worth describing again.
 *
 * Four reasons, and each one is a bug if it is missing:
 *
 * - the head moved, or the branch is new — the obvious one;
 * - the default branch changed since the last send, because every delta was
 *   computed against the wrong base and no head has to move for that to be
 *   true;
 * - the entry is older than the heartbeat, which is the only thing that ever
 *   re-offers a finished branch to a tracker connected after the fact.
 *
 * @param input - The refs git reported and what was last sent.
 * @returns The branches to describe. Empty means send nothing at all.
 */
export function selectChangedBranches(input: SelectionInput): BranchRef[] {
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
 * Every ref that was listed is recorded, not only the ones that were sent:
 * a branch left out of this send is still known, and forgetting it would make
 * the next turn treat it as new.
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
    const previous = input.stored.branches[ref.name];

    branches[ref.name] = {
      headSha: ref.headSha,
      // A branch that was not in this send keeps the time it was last actually
      // reported, so its heartbeat stays due rather than being reset by a send
      // it took no part in.
      lastSentAt: sentNames.has(ref.name) ? input.now : (previous?.lastSentAt ?? 0)
    };
  }

  return { defaultBranch: input.defaultBranch, branches };
}
