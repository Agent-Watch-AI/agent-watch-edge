import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readGateCheckout } from '../src/git/gate-checkout.js';
import { resolvePaths } from '../src/storage/paths.js';
import { makeTempEnv, type TempWorld } from './helpers.js';

/**
 * What the gate may say about where it is asking from.
 *
 * The question is asked before any git context has been collected and inside a
 * few hundred milliseconds, so this reads the working copy rather than running
 * git: an upward walk for `.git`, then one file. Anything it cannot answer it
 * declines to answer.
 */
describe('the checkout a gated prompt is happening in', () => {
  let world: TempWorld;

  beforeEach(async () => {
    world = await makeTempEnv();
  });

  afterEach(() => world.cleanup());

  async function repository(name: string, remote?: string): Promise<string> {
    const root = path.join(world.home, name);

    await fs.mkdir(root, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });

    if (remote) execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: root });

    return root;
  }

  it('names the repository and the checked-out branch', async () => {
    const root = await repository('platform', 'git@github.com:Acme/Platform.git');

    execFileSync('git', ['checkout', '-q', '-b', 'AWT-183-feature-enforcement'], { cwd: root });

    const checkout = await readGateCheckout({ cwd: root, dataDir: resolvePaths(world.env).dataDir });

    // As `normalizeRemote` produces it, which is the same value a turn summary
    // already reports: case preserved, host included. The platform reduces it to
    // `owner/repo` lowercase on arrival.
    expect(checkout).toEqual({
      repository: 'github.com/Acme/Platform',
      branch: 'AWT-183-feature-enforcement'
    });
  });

  it('answers from a directory below the root, the way a hook is invoked', async () => {
    const root = await repository('nested', 'git@github.com:Acme/Nested.git');
    const deep = path.join(root, 'apps', 'service', 'src');

    await fs.mkdir(deep, { recursive: true });

    const checkout = await readGateCheckout({ cwd: deep, dataDir: resolvePaths(world.env).dataDir });

    expect(checkout?.branch).toBe('main');
  });

  it('says nothing outside a repository', async () => {
    const plain = path.join(world.home, 'not-a-repo');

    await fs.mkdir(plain, { recursive: true });

    expect(await readGateCheckout({ cwd: plain, dataDir: resolvePaths(world.env).dataDir })).toBeUndefined();
  });

  it('says nothing on a detached HEAD, which names no branch to charge', async () => {
    const root = await repository('detached', 'git@github.com:Acme/Detached.git');

    await fs.writeFile(path.join(root, 'a.txt'), 'a');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.email=t@e.st', '-c', 'user.name=t', 'commit', '-qm', 'one'], {
      cwd: root
    });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();

    execFileSync('git', ['checkout', '-q', sha], { cwd: root });

    expect(await readGateCheckout({ cwd: root, dataDir: resolvePaths(world.env).dataDir })).toBeUndefined();
  });

  it('says nothing when the repository has no usable remote', async () => {
    const root = await repository('remoteless');

    expect(await readGateCheckout({ cwd: root, dataDir: resolvePaths(world.env).dataDir })).toBeUndefined();
  });

  it('follows a worktree through its gitdir, because agents work in them', async () => {
    const root = await repository('main-copy', 'git@github.com:Acme/Worktrees.git');

    await fs.writeFile(path.join(root, 'a.txt'), 'a');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.email=t@e.st', '-c', 'user.name=t', 'commit', '-qm', 'one'], {
      cwd: root
    });

    const linked = path.join(world.home, 'side');

    execFileSync('git', ['worktree', 'add', '-q', '-b', 'side-branch', linked], { cwd: root });

    const checkout = await readGateCheckout({ cwd: linked, dataDir: resolvePaths(world.env).dataDir });

    expect(checkout).toEqual({ repository: 'github.com/Acme/Worktrees', branch: 'side-branch' });
  });
});
