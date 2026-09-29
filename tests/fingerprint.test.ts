import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asFingerprint, commitFiles, dirtyDelta, fingerprint, parsePorcelainV2 } from '../src/git/fingerprint.js';

describe('porcelain v2 -z', () => {
  it('reads HEAD, branch, ordinary, renamed, unmerged and untracked entries, spaces included', () => {
    const output = [
      '# branch.oid 1111111111111111111111111111111111111111',
      '# branch.head AWT-1-x',
      '# branch.upstream origin/AWT-1-x',
      '1 .M N... 100644 100644 100644 aaa aaa src/with space.ts',
      '2 R. N... 100644 100644 100644 bbb bbb R100 new name.ts',
      'old name.ts',
      'u UU N... 100644 100644 100644 100644 c1 c2 c3 conflict.ts',
      '? untracked dir/',
      ''
    ].join('\0');

    expect(parsePorcelainV2(output)).toEqual({
      oid: '1111111111111111111111111111111111111111',
      unborn: false,
      branch: 'AWT-1-x',
      entries: [
        ['src/with space.ts', '.M'],
        ['new name.ts', 'R.'],
        ['conflict.ts', 'UU'],
        ['untracked dir/', '??']
      ]
    });
  });

  it('names no oid before the first commit and no branch on a detached HEAD', () => {
    expect(parsePorcelainV2('# branch.oid (initial)\0# branch.head (detached)\0')).toEqual({ oid: undefined, unborn: true, branch: undefined, entries: [] });
  });
});

describe('a checkout fingerprint', () => {
  let root: string;
  let repo: string;

  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe', env: { ...process.env, HOME: root } }).toString().trim();

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentwatch-fp-')));
    repo = path.join(root, 'repo');
    await fs.mkdir(repo);
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'dev@company.com');
    git('config', 'user.name', 'Dev');

    for (const file of ['a.ts', 'b.ts', 'c.ts']) await fs.writeFile(path.join(repo, file), `${file}\n`);

    git('add', '.');
    git('commit', '-qm', 'one');
  });
  afterEach(() => fs.rm(root, { recursive: true, force: true }));

  it('finds nothing changed in a tree with stale dirt nobody touched', async () => {
    await fs.writeFile(path.join(repo, 'a.ts'), 'stale edit\n');
    await fs.writeFile(path.join(repo, 'stale new.ts'), 'x\n');

    const before = (await fingerprint(repo))!;
    const after = (await fingerprint(repo))!;

    expect(Object.keys(before.dirty).sort()).toEqual(['a.ts', 'stale new.ts']);
    expect(dirtyDelta(before, after)).toEqual([]);
  });

  it('counts an edit to a file that was already dirty', async () => {
    await fs.writeFile(path.join(repo, 'a.ts'), 'stale\n');

    const before = (await fingerprint(repo))!;

    await fs.writeFile(path.join(repo, 'a.ts'), 'stale, and now edited again by this turn\n');
    await fs.writeFile(path.join(repo, 'b.ts'), 'fresh\n');

    expect(dirtyDelta(before, (await fingerprint(repo))!).sort()).toEqual(['a.ts', 'b.ts']);
  });

  it('counts a same-size rewrite that restores the modification time', async () => {
    await fs.writeFile(path.join(repo, 'a.ts'), 'AAAA\n');

    const before = (await fingerprint(repo))!;
    const { mtime } = await fs.stat(path.join(repo, 'a.ts'));

    await new Promise((resolve) => setTimeout(resolve, 20));
    await fs.writeFile(path.join(repo, 'a.ts'), 'BBBB\n');
    await fs.utimes(path.join(repo, 'a.ts'), mtime, mtime);

    expect(dirtyDelta(before, (await fingerprint(repo))!)).toEqual(['a.ts']);
  });

  it("names a commit's files once HEAD moved", async () => {
    const before = (await fingerprint(repo))!;

    await fs.writeFile(path.join(repo, 'c.ts'), 'committed\n');
    git('commit', '-qam', 'two');

    const after = (await fingerprint(repo))!;

    expect(after.oid).not.toBe(before.oid);
    expect(after.branch).toBe('main');
    expect(dirtyDelta(before, after)).toEqual([]);
    expect(await commitFiles(repo, before.oid!, after.oid!)).toEqual(['c.ts']);
  });

  it('keeps what a vanished worktree committed readable from the shared git dir', async () => {
    const worktree = path.join(root, 'wt');

    git('worktree', 'add', '-q', '-b', 'AWT-7-gone', worktree);

    const before = (await fingerprint(worktree))!;

    expect(before.branch).toBe('AWT-7-gone');
    expect(before.commonDir).toBe(path.join(repo, '.git'));

    await fs.writeFile(path.join(worktree, 'b.ts'), 'in the worktree\n');
    execFileSync('git', ['commit', '-qam', 'wt'], { cwd: worktree, stdio: 'pipe', env: { ...process.env, HOME: root } });
    git('worktree', 'remove', '--force', worktree);

    expect(await fingerprint(worktree)).toBeUndefined();
    expect(await commitFiles(before.commonDir!, before.oid!, 'refs/heads/AWT-7-gone', before.commonDir)).toEqual(['b.ts']);
  });

  it('reads a checkout while another process holds index.lock', async () => {
    await fs.writeFile(path.join(repo, '.git', 'index.lock'), '');
    await fs.writeFile(path.join(repo, 'a.ts'), 'edited\n');

    expect(Object.keys((await fingerprint(repo))!.dirty)).toEqual(['a.ts']);
  });

  it('reads back from turn state only in the shape it was written', () => {
    expect(asFingerprint({ oid: '--output=/tmp/x', commonDir: 'relative', dirty: { 'a.ts': { xy: '.M', size: 'big' }, 'b.ts': 3 } })).toEqual({
      oid: undefined,
      unborn: undefined,
      branch: undefined,
      commonDir: undefined,
      dirty: { 'a.ts': { xy: '.M', size: undefined, mtimeMs: undefined, ctimeMs: undefined, ino: undefined } }
    });
    expect(asFingerprint('nope')).toBeUndefined();
  });
});
