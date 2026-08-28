import { describe, expect, it } from 'vitest';
import { nextSnapshotState, selectChangedBranches } from '../src/snapshot/branch-selection.js';
import { SNAPSHOT_REFRESH_MS } from '../src/snapshot/constants/snapshot.constants.js';
import { budgetedRunner, withinBudget } from '../src/snapshot/budget.js';
import { buildRepoSnapshot } from '../src/snapshot/snapshot-event.js';
import { runSnapshotPipeline } from '../src/snapshot/snapshot-pipeline.js';
import { collectBranchCommits, collectBranchRefs, resolveDefaultBranch } from '../src/git/repo-snapshot.js';
import { GIT_FIELD_SEPARATOR } from '../src/git/constants/git.constants.js';
import { isProductEvent } from '../src/events/product-event.js';
import type { RepoSnapshotEvent } from '../src/events/types/repo-snapshot.types.js';
import type { GitRunner } from '../src/git/types/git.types.js';
import type { SnapshotFlowInput, SnapshotState } from '../src/snapshot/types/snapshot.types.js';

const SEP = GIT_FIELD_SEPARATOR;
const NOW = Date.parse('2026-08-28T12:00:00.000Z');

/** A git runner answering from a table of `args.join(' ')` prefixes. */
function fakeGit(answers: Record<string, string | undefined>, calls: string[][] = []): GitRunner {
  return async (args) => {
    calls.push([...args]);
    const key = Object.keys(answers).find((prefix) => args.join(' ').startsWith(prefix));

    return key === undefined ? undefined : answers[key];
  };
}

function refLine(name: string, sha: string, date = '2026-08-28T11:00:00+00:00'): string {
  return `${name}${SEP}${sha}${SEP}${date}`;
}

function commitLine(sha: string, subject: string): string {
  return `${sha}${SEP}${subject}${SEP}2026-08-28T10:00:00+00:00`;
}

function identity(overrides: Partial<SnapshotFlowInput> = {}): SnapshotFlowInput {
  return {
    cwd: '/repo',
    repository: 'github.com/acme/repo',
    provider: 'claude-code',
    surface: 'cli',
    agentName: 'Claude Code',
    capturedAt: new Date(NOW).toISOString(),
    deadline: Date.now() + 60_000,
    run: fakeGit({}),
    ...overrides
  };
}

describe('branch listing and delta collection', () => {
  it('reads the branches and heads out of one for-each-ref call', async () => {
    const run = fakeGit({
      'for-each-ref': [refLine('feature/export-pdf', 'aaa1'), refLine('main', 'bbb2')].join('\n')
    });

    expect(await collectBranchRefs({ cwd: '/repo', branchCount: 10 }, run)).toEqual([
      { name: 'feature/export-pdf', headSha: 'aaa1', lastCommitAt: '2026-08-28T11:00:00+00:00' },
      { name: 'main', headSha: 'bbb2', lastCommitAt: '2026-08-28T11:00:00+00:00' }
    ]);
  });

  it('asks git for the delta against the default branch, never the whole history', async () => {
    const calls: string[][] = [];
    const run = fakeGit({ log: commitLine('c1', 'render invoice as pdf') }, calls);

    await collectBranchCommits('feature/export-pdf', { cwd: '/repo', defaultBranch: 'main', commitCount: 20 }, run);

    expect(calls[0]).toContain('main..feature/export-pdf');
  });

  it('reports no commits at all when there is no default branch to subtract', async () => {
    const calls: string[][] = [];
    const run = fakeGit({ log: commitLine('c1', 'something') }, calls);

    // The trunk's commits would otherwise be described as this branch's work,
    // and two unrelated branches would read as one feature.
    expect(await collectBranchCommits('feature/x', { cwd: '/repo', commitCount: 20 }, run)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('gives two branches off one trunk their own commits and nothing shared', async () => {
    const shared = commitLine('shared1', 'chore: bump deps');
    const run: GitRunner = async (args) => {
      const line = args.join(' ');

      if (line.startsWith('for-each-ref')) return [refLine('feature/a', 'aa'), refLine('feature/b', 'bb')].join('\n');

      // `main..<branch>` excludes the trunk, so the shared commit is in neither.
      if (line.includes('main..feature/a')) return commitLine('a1', 'add exporter');

      if (line.includes('main..feature/b')) return commitLine('b1', 'add importer');

      if (line.includes('main..')) return shared;

      return undefined;
    };

    const a = await collectBranchCommits('feature/a', { cwd: '/repo', defaultBranch: 'main', commitCount: 20 }, run);
    const b = await collectBranchCommits('feature/b', { cwd: '/repo', defaultBranch: 'main', commitCount: 20 }, run);

    expect(a.map((commit) => commit.sha)).toEqual(['a1']);
    expect(b.map((commit) => commit.sha)).toEqual(['b1']);
  });

  it('prefers origin/HEAD and falls back to a local trunk', async () => {
    const remote = fakeGit({ 'symbolic-ref --short -q refs/remotes/origin/HEAD': 'origin/develop' });

    expect(await resolveDefaultBranch('/repo', remote)).toBe('develop');

    const local = fakeGit({ 'rev-parse --verify -q master': 'ffff' });

    expect(await resolveDefaultBranch('/repo', local)).toBe('master');
  });
});

describe('branch selection', () => {
  const refs = [
    { name: 'feature/a', headSha: 'aa' },
    { name: 'feature/b', headSha: 'bb' }
  ];
  const stored: SnapshotState = {
    defaultBranch: 'main',
    branches: {
      'feature/a': { headSha: 'aa', lastSentAt: NOW - 1000 },
      'feature/b': { headSha: 'bb', lastSentAt: NOW - 1000 }
    }
  };

  it('selects nothing when no head moved and nothing is due', () => {
    expect(selectChangedBranches({ refs, stored, defaultBranch: 'main', now: NOW })).toEqual([]);
  });

  it('selects a branch whose head moved, and a branch it has never seen', () => {
    const moved = [{ name: 'feature/a', headSha: 'aa2' }, { name: 'feature/new', headSha: 'nn' }];
    const selected = selectChangedBranches({ refs: moved, stored, defaultBranch: 'main', now: NOW });

    expect(selected.map((ref) => ref.name)).toEqual(['feature/a', 'feature/new']);
  });

  it('selects every branch when the default branch changed under it', () => {
    // Every stored delta was computed against the wrong base, and no head has
    // to move for that to be true.
    const selected = selectChangedBranches({ refs, stored, defaultBranch: 'develop', now: NOW });

    expect(selected).toHaveLength(2);
  });

  it('re-offers a quiet branch once the heartbeat is due', () => {
    const late = NOW + SNAPSHOT_REFRESH_MS;
    const selected = selectChangedBranches({ refs, stored, defaultBranch: 'main', now: late });

    expect(selected).toHaveLength(2);
  });

  it('keeps the last real send time of a branch this snapshot did not describe', () => {
    const state = nextSnapshotState({ refs, stored, defaultBranch: 'main', now: NOW }, [refs[0]!]);

    expect(state.branches['feature/a']?.lastSentAt).toBe(NOW);
    expect(state.branches['feature/b']?.lastSentAt).toBe(NOW - 1000);
  });

  it('keeps the old head of a moved branch the budget left out, so it is retried', () => {
    // Recording the new head for a branch nobody was told about is how work
    // vanishes: next turn compares the new head against the new head, finds
    // them equal, and waits six hours for the heartbeat.
    const moved = [
      { name: 'feature/a', headSha: 'aa2' },
      { name: 'feature/b', headSha: 'bb2' }
    ];
    const state = nextSnapshotState({ refs: moved, stored, defaultBranch: 'main', now: NOW }, [moved[0]!]);

    expect(state.branches['feature/b']?.headSha).toBe('bb');
    expect(selectChangedBranches({ refs: moved, stored: state, defaultBranch: 'main', now: NOW })).toHaveLength(1);
  });

  it('does not record a branch it has never described at all', () => {
    const withNew = [...refs, { name: 'feature/new', headSha: 'nn' }];
    const state = nextSnapshotState({ refs: withNew, stored, defaultBranch: 'main', now: NOW }, []);

    expect(state.branches['feature/new']).toBeUndefined();
  });

  it('holds the recorded base back until every branch was described against it', () => {
    // Advancing it early ends the rebase selection for branches whose deltas
    // were never recomputed, leaving them on the wrong base indefinitely.
    const partial = nextSnapshotState({ refs, stored, defaultBranch: 'develop', now: NOW }, [refs[0]!]);

    expect(partial.defaultBranch).toBe('main');
    expect(selectChangedBranches({ refs, stored: partial, defaultBranch: 'develop', now: NOW })).toHaveLength(2);

    const complete = nextSnapshotState({ refs, stored, defaultBranch: 'develop', now: NOW }, refs);

    expect(complete.defaultBranch).toBe('develop');
  });
});

describe('the budget', () => {
  it('shortens each git timeout to what is left, and skips a call with nothing left', async () => {
    const timeouts: number[] = [];
    const run: GitRunner = async (_args, _cwd, timeoutMs) => {
      timeouts.push(timeoutMs);

      return 'out';
    };
    let clock = 1_000;
    const bounded = budgetedRunner(run, 1_400, () => clock);

    await bounded(['for-each-ref'], '/repo', 1000);
    clock = 1_450;
    const afterExpiry = await bounded(['log'], '/repo', 1000);

    // 400 ms left, so the call may not wait its usual second; then nothing.
    expect(timeouts).toEqual([400]);
    expect(afterExpiry).toBeUndefined();
  });

  it('abandons a write that outlives the budget rather than blocking the hook', async () => {
    const never = new Promise<void>(() => undefined);

    expect(await withinBudget(never, Date.now() + 20)).toBe(false);
    expect(await withinBudget(Promise.resolve(), Date.now() + 1000)).toBe(true);
  });

  it('records nothing as sent when the queue write did not finish', async () => {
    const cache = {
      written: [] as SnapshotState[],
      read: async () => ({ defaultBranch: 'main', branches: {} }),
      write: async (_repository: string, state: SnapshotState) => void cache.written.push(state)
    };
    const run = fakeGit({
      'for-each-ref': refLine('feature/a', 'aa'),
      'symbolic-ref --short -q refs/remotes/origin/HEAD': 'origin/main',
      log: commitLine('c1', 'add exporter')
    });

    const result = await runSnapshotPipeline({
      input: identity({ run, deadline: Date.now() + 40 }),
      store: cache,
      queue: { enqueue: () => new Promise(() => undefined) }
    });

    expect(result.completed).toBe(false);
    expect(cache.written).toHaveLength(0);
  });
});

describe('the snapshot event', () => {
  const branch = { name: 'feature/a', headSha: 'aa', commits: [] };

  it('is a product event the queue will drain', () => {
    const event = buildRepoSnapshot({ identity: identity(), defaultBranch: 'main', branches: [branch] });

    expect(isProductEvent(event)).toBe(true);
  });

  it('gets a new id on a heartbeat resend of unchanged heads', () => {
    // The queue filename is the id and the backend dedupes on it, so a
    // heartbeat that reused the previous id would never be received.
    const first = buildRepoSnapshot({ identity: identity(), defaultBranch: 'main', branches: [branch] });
    const later = buildRepoSnapshot({
      identity: identity({ capturedAt: new Date(NOW + SNAPSHOT_REFRESH_MS).toISOString() }),
      defaultBranch: 'main',
      branches: [branch]
    });

    expect(later.id).not.toBe(first.id);
  });

  it('keeps its id when the same capture is rebuilt', () => {
    const once = buildRepoSnapshot({ identity: identity(), defaultBranch: 'main', branches: [branch] });
    const again = buildRepoSnapshot({ identity: identity(), defaultBranch: 'main', branches: [branch] });

    expect(again.id).toBe(once.id);
  });
});

describe('the snapshot flow', () => {
  function store(state: SnapshotState) {
    const written: SnapshotState[] = [];

    return {
      written,
      read: async () => state,
      write: async (_repository: string, next: SnapshotState) => {
        written.push(next);
      }
    };
  }

  it('runs no git log at all when nothing changed', async () => {
    const calls: string[][] = [];
    const run = fakeGit(
      {
        'for-each-ref': refLine('feature/a', 'aa'),
        'symbolic-ref --short -q refs/remotes/origin/HEAD': 'origin/main'
      },
      calls
    );
    const cache = store({ defaultBranch: 'main', branches: { 'feature/a': { headSha: 'aa', lastSentAt: NOW } } });
    const queued: unknown[] = [];

    const result = await runSnapshotPipeline({
      input: identity({ run }),
      store: cache,
      queue: { enqueue: async (events) => void queued.push(...events) }
    });

    expect(result.stoppedAt).toBe('select-changed');
    expect(calls.some((args) => args[0] === 'log')).toBe(false);
    expect(queued).toHaveLength(0);
  });

  it('describes only the branch that moved, and records the send afterwards', async () => {
    const calls: string[][] = [];
    const run = fakeGit(
      {
        'for-each-ref': [refLine('feature/a', 'aa2'), refLine('feature/b', 'bb')].join('\n'),
        'symbolic-ref --short -q refs/remotes/origin/HEAD': 'origin/main',
        log: commitLine('c1', 'add exporter')
      },
      calls
    );
    const cache = store({
      defaultBranch: 'main',
      branches: {
        'feature/a': { headSha: 'aa', lastSentAt: NOW },
        'feature/b': { headSha: 'bb', lastSentAt: NOW }
      }
    });
    const queued: RepoSnapshotEvent[] = [];

    const result = await runSnapshotPipeline({
      input: identity({ run }),
      store: cache,
      queue: { enqueue: async (events) => void queued.push(...events) }
    });

    expect(result.completed).toBe(true);
    expect(calls.filter((args) => args[0] === 'log')).toHaveLength(1);
    expect(queued[0]?.branches.map((entry) => entry.name)).toEqual(['feature/a']);
    // Both branches stay in the cache; only the described one is marked sent.
    expect(Object.keys(cache.written[0]?.branches ?? {})).toEqual(['feature/a', 'feature/b']);
  });

  it('writes nothing to the cache when the queue refuses the event', async () => {
    const run = fakeGit({
      'for-each-ref': refLine('feature/a', 'aa2'),
      'symbolic-ref --short -q refs/remotes/origin/HEAD': 'origin/main',
      log: commitLine('c1', 'add exporter')
    });
    const cache = store({ defaultBranch: 'main', branches: { 'feature/a': { headSha: 'aa', lastSentAt: NOW } } });

    const result = await runSnapshotPipeline({
      input: identity({ run }),
      store: cache,
      queue: {
        enqueue: async () => {
          throw new Error('disk full');
        }
      }
    });

    // Marked as sent, the branch would never be offered again.
    expect(result.completed).toBe(false);
    expect(cache.written).toHaveLength(0);
  });

  it('stops outside a repository instead of failing', async () => {
    const result = await runSnapshotPipeline({
      input: identity({ run: fakeGit({}) }),
      store: store({ branches: {} }),
      queue: { enqueue: async () => undefined }
    });

    expect(result.stoppedAt).toBe('collect-refs');
  });
});
