import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach } from 'vitest';
import { defaultConfig } from '../src/config/config.js';
import { enrichEvents } from '../src/events/enrich.js';
import { deriveEventId, sha256Hex } from '../src/events/event-id.js';
import { featureCandidatesFromBranch } from '../src/feature/ticket-candidates.js';

describe('event ids', () => {
  it('is deterministic for identical inputs', () => {
    const a = deriveEventId({ provider: 'claude', providerEventType: 'PostToolUse', sessionId: 's1', toolUseId: 't1' });
    const b = deriveEventId({ provider: 'claude', providerEventType: 'PostToolUse', sessionId: 's1', toolUseId: 't1' });

    expect(a).toBe(b);
    expect(a).toMatch(/^evt_[0-9a-f]{40}$/);
  });

  it('differs when any identity component differs', () => {
    const base = { provider: 'claude', providerEventType: 'PostToolUse', sessionId: 's1', toolUseId: 't1' };

    expect(deriveEventId(base)).not.toBe(deriveEventId({ ...base, toolUseId: 't2' }));
    expect(deriveEventId(base)).not.toBe(deriveEventId({ ...base, providerEventType: 'PreToolUse' }));
    expect(deriveEventId(base)).not.toBe(deriveEventId({ ...base, provider: 'codex' }));
  });

  it('does not embed raw content', () => {
    const secret = 'super-secret-prompt';
    const id = deriveEventId({ provider: 'claude', providerEventType: 'UserPromptSubmit', payloadFingerprint: sha256Hex(secret) });

    expect(id).not.toContain(secret);
  });
});

describe('feature candidates', () => {
  it('extracts ticket keys from branch names', () => {
    expect(featureCandidatesFromBranch('feature/OASIS-1234-add-auth')).toEqual([
      { type: 'ticket', value: 'OASIS-1234', source: 'git.branch' }
    ]);
  });

  it('keeps only uppercase keys, deduplicated', () => {
    const candidates = featureCandidatesFromBranch('fix/abc-12-and-ABC-12-plus-XY-9');

    expect(candidates.map((candidate) => candidate.value)).toEqual(['ABC-12', 'XY-9']);
  });

  it('does not fabricate tickets from ordinary lowercase words', () => {
    expect(featureCandidatesFromBranch('bump-node-20')).toEqual([]);
    expect(featureCandidatesFromBranch('chore/sha256-2')).toEqual([]);
  });

  it('returns nothing for plain branches', () => {
    expect(featureCandidatesFromBranch('main')).toEqual([]);
    expect(featureCandidatesFromBranch(undefined)).toEqual([]);
  });
});

describe('a session started above its repositories', () => {
  let workspace: string;
  let outside: string;

  /** A workspace folder that is not a repository, holding two that are. */
  beforeEach(async () => {
    // realpath: on macOS the temp root is a symlink, and git reports the
    // resolved root — a path that would not relativize against the payload's.
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentwatch-workspace-')));

    workspace = path.join(root, 'code');
    outside = path.join(root, 'other');

    for (const repo of ['core', 'edge']) {
      await fs.mkdir(path.join(workspace, repo, 'src'), { recursive: true });
      // A `.git` file, not a directory: that is what a linked worktree and a
      // submodule check out as, and both must count.
      await fs.writeFile(path.join(workspace, repo, '.git'), 'gitdir: elsewhere\n');
    }

    await fs.mkdir(path.join(outside, 'src'), { recursive: true });
    await fs.writeFile(path.join(outside, '.git'), 'gitdir: elsewhere\n');
  });

  function toolEvent(filePath: string, id = 'evt_1'): any {
    return {
      schemaVersion: '1',
      id,
      timestamp: '2026-09-26T10:00:00.000Z',
      event: { type: 'file.edited', providerEventType: 'PostToolUse' },
      agent: { provider: 'claude', name: 'Claude Code' },
      session: { id: 'sess-1' },
      tool: { name: 'Edit' },
      metadata: { filePath }
    };
  }

  function enrich(events: any[], cwd: string, config = defaultConfig()): Promise<any[]> {
    // capture.git is on by default; the real pipeline passes the same shape.
    return enrichEvents(events, { config, cwd, home: path.dirname(cwd) }) as Promise<any[]>;
  }

  it('reports the repository beneath the start folder, and paths relative to it', async () => {
    const [event] = await enrich([toolEvent(path.join(workspace, 'core/src/totals.ts'))], workspace);

    expect(event.metadata.filePath).toBe(path.join('src', 'totals.ts'));
    expect(event.metadata.repositoryPath).toBe('core');
  });

  it('places a file outside the start folder in its own checkout, for the close to admit or refuse', async () => {
    // Agents work in worktrees beside the folder they started in. Enrichment
    // only places the file; the turn's close decides, against the tenant and
    // the start folder, whether that checkout may be reported at all.
    const [event] = await enrich([toolEvent(path.join(outside, 'src/app.ts'))], workspace);

    expect(event.metadata.filePath).toBe(path.join('src', 'app.ts'));
    expect(event.metadata.repositoryPath).toBe(path.join('..', 'other'));
  });

  it('places a file reached through a symlink in the checkout it really lies in', async () => {
    // The close then judges that real checkout against the tenant and the start folder.
    await fs.symlink(outside, path.join(workspace, 'linked'));

    const [event] = await enrich([toolEvent(path.join(workspace, 'linked/src/app.ts'))], workspace);

    expect(event.metadata.filePath).toBe(path.join('src', 'app.ts'));
    expect(event.metadata.repositoryPath).toBe(path.join('..', 'other'));
  });

  it('finds the checkout of a file reached through a symlink into one of its subdirectories', async () => {
    // Walked up lexically, `<workspace>/shortcut/app.ts` meets no `.git`.
    await fs.symlink(path.join(outside, 'src'), path.join(workspace, 'shortcut'));

    const [event] = await enrich([toolEvent(path.join(workspace, 'shortcut/app.ts'))], workspace);

    expect(event.metadata.filePath).toBe(path.join('src', 'app.ts'));
    expect(event.metadata.repositoryPath).toBe(path.join('..', 'other'));
  });

  it('sends no absolute path, for a file in a repository or outside every one', async () => {
    const events = await enrich(
      [
        toolEvent(path.join(workspace, 'core/src/totals.ts'), 'evt_1'),
        toolEvent(path.join(outside, 'src/app.ts'), 'evt_2'),
        toolEvent(path.join(workspace, 'loose.md'), 'evt_3')
      ],
      workspace
    );

    for (const event of events) {
      expect(path.isAbsolute(event.metadata.filePath)).toBe(false);
      expect(JSON.stringify(event)).not.toContain(workspace);
    }
  });

  it('places files of a start folder that is a repository in it, and a nested checkout in its own', async () => {
    // The start folder's files keep the paths they always had. A nested
    // checkout (a submodule, a vendored worktree) is a checkout of its own:
    // work there is reported there.
    const repo = path.join(workspace, 'real');

    await fs.mkdir(path.join(repo, 'src'), { recursive: true });
    await fs.mkdir(path.join(repo, 'vendor/nested'), { recursive: true });
    await fs.writeFile(path.join(repo, 'vendor/.git'), 'gitdir: elsewhere\n');
    execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'pipe' });

    const [inside, nested] = await enrich(
      [toolEvent(path.join(repo, 'src/totals.ts'), 'evt_1'), toolEvent(path.join(repo, 'vendor/nested/dep.ts'), 'evt_2')],
      repo
    );

    expect(inside.metadata.filePath).toBe(path.join('src', 'totals.ts'));
    expect(inside.metadata.repositoryPath).toBe('.');
    expect(nested.metadata.filePath).toBe(path.join('nested', 'dep.ts'));
    expect(nested.metadata.repositoryPath).toBe('vendor');
  });

  it('resolves nothing when git capture is off', async () => {
    const config = { ...defaultConfig(), capture: { ...defaultConfig().capture, git: false } };
    const [event] = await enrich([toolEvent(path.join(workspace, 'core/src/totals.ts'))], workspace, config);

    expect(event.metadata.filePath).toBe('totals.ts');
    expect(event.metadata.repositoryPath).toBeUndefined();
  });
});
