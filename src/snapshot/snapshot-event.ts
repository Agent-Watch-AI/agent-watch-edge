import { compact } from '../core/object.js';
import { deriveEventId, sha256Hex } from '../events/event-id.js';
import { EVENT_SCHEMA_VERSION } from '../events/constants/events.constants.js';
import type { RepoSnapshotEvent } from '../events/types/repo-snapshot.types.js';
import {
  SNAPSHOT_MAX_BRANCH_NAME_LENGTH,
  SNAPSHOT_MAX_SUBJECT_LENGTH
} from './constants/snapshot.constants.js';
import type { BuildSnapshotInput } from './types/snapshot.types.js';

/**
 * Build the record one repository's changed branches become.
 *
 * The id is derived from the repository, the branch heads, the default branch
 * *and* `captured_at`. The capture time has to be in it: the queue's filename
 * is the event id and the backend deduplicates on the same value, so an id
 * built from heads alone would make every heartbeat of a quiet branch a
 * duplicate of the send before it — and the heartbeat exists precisely to be
 * received again. A retry of one queued event carries its stored capture time
 * and so keeps its id; the next heartbeat captures anew and gets a new one.
 *
 * @param input - Identity, base branch and the branches being described.
 * @returns The snapshot event.
 */
export function buildRepoSnapshot(input: BuildSnapshotInput): RepoSnapshotEvent {
  const { identity, defaultBranch, branches } = input;

  return compact({
    schemaVersion: EVENT_SCHEMA_VERSION,
    id: deriveEventId({
      provider: identity.provider,
      providerEventType: 'repo.snapshot',
      sessionId: identity.sessionId,
      timestamp: identity.capturedAt,
      payloadFingerprint: fingerprint(input)
    }),
    timestamp: identity.capturedAt,
    event: { type: 'repo.snapshot', providerEventType: 'repo.snapshot' },
    agent: { provider: identity.provider, name: identity.agentName },
    session: { id: identity.sessionId, providerId: identity.sessionId },
    developer: identity.installationId ? { installationId: identity.installationId } : undefined,

    provider: identity.provider,
    surface: identity.surface,
    repository: identity.repository,
    developer_id: identity.developerId,
    default_branch: defaultBranch,
    captured_at: identity.capturedAt,
    branches: branches
      // A name the backend cannot store costs that branch its row, and a
      // branch name that long is not a name anyone typed.
      .filter((branch) => branch.name.length <= SNAPSHOT_MAX_BRANCH_NAME_LENGTH)
      .map((branch) =>
        compact({
          name: branch.name,
          head_sha: branch.headSha,
          last_commit_at: branch.lastCommitAt,
          commits: branch.commits.map((commit) =>
            compact({
              sha: commit.sha,
              subject: commit.subject.slice(0, SNAPSHOT_MAX_SUBJECT_LENGTH),
              authored_at: commit.authoredAt
            })
          )
        })
      )
  }) as RepoSnapshotEvent;
}

/**
 * What makes this send different from the one before it.
 *
 * @param input - Identity, base branch and branches.
 * @returns A digest over repository, default branch, heads and capture time.
 */
function fingerprint(input: BuildSnapshotInput): string {
  const heads = input.branches.map((branch) => `${branch.name}@${branch.headSha}`).sort();

  return sha256Hex(
    JSON.stringify([input.identity.repository, input.defaultBranch ?? '', heads, input.identity.capturedAt])
  );
}
