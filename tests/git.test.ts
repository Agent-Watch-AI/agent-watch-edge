import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectGitContext, gitUserEmail } from '../src/git/git-context.js';
import { normalizeRemote, remoteHash, stripRemoteCredentials } from '../src/git/remote-sanitize.js';
import { makeTempEnv, type TempWorld } from './helpers.js';

describe('remote sanitization', () => {
  it('strips credentials from https remotes', () => {
    expect(stripRemoteCredentials('https://user:tok3n@github.com/acme/repo.git')).toBe('https://github.com/acme/repo.git');
    expect(stripRemoteCredentials('https://token@github.com/acme/repo.git')).toBe('https://github.com/acme/repo.git');
  });

  it('normalizes https, ssh and scp-like remotes to host/path', () => {
    expect(normalizeRemote('https://github.com/acme/repo.git')).toBe('github.com/acme/repo');
    expect(normalizeRemote('git@github.com:acme/repo.git')).toBe('github.com/acme/repo');
    expect(normalizeRemote('ssh://git@github.com/acme/repo.git')).toBe('github.com/acme/repo');
    expect(normalizeRemote('https://user:tok3n@github.com/acme/repo.git')).toBe('github.com/acme/repo');
  });

  it('hashes remotes deterministically', () => {
    expect(remoteHash('https://github.com/acme/repo.git')).toBe(remoteHash('git@github.com:acme/repo.git'));
  });
});

describe('gitUserEmail isolation', () => {
  let world: TempWorld;
  beforeEach(async () => {
    world = await makeTempEnv();
  });
  afterEach(() => world.cleanup());

  it('honors the injected home and never reads the real global gitconfig', async () => {
    // The temp home has no .gitconfig; whatever the developer's real global
    // user.email is, it must not leak into a run with an injected home.
    const email = await gitUserEmail(world.home, { home: world.home });
    expect(email).toBeUndefined();
  });
});

describe('collectGitContext', () => {
  let world: TempWorld;
  let repoDir: string;

  beforeEach(async () => {
    world = await makeTempEnv();
    repoDir = path.join(world.home, 'repo');
    await fs.mkdir(repoDir, { recursive: true });
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repoDir, stdio: 'pipe' });
    git('init', '--initial-branch', 'feature/OASIS-99-thing');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('remote', 'add', 'origin', 'https://user:s3cret@github.com/acme/backend.git');
    await fs.writeFile(path.join(repoDir, 'committed.txt'), 'hello');
    git('add', '.');
    git('commit', '-m', 'initial');
    await fs.writeFile(path.join(repoDir, 'dirty.txt'), 'work in progress');
  });

  afterEach(async () => {
    await world.cleanup();
  });

  it('collects root, branch, commit, sanitized remote and changed files', async () => {
    const context = await collectGitContext({ cwd: repoDir, includeChangedFiles: true });
    expect(context.repositoryRoot).toBeDefined();
    expect(context.branch).toBe('feature/OASIS-99-thing');
    expect(context.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(context.repository).toBe('github.com/acme/backend');
    expect(context.remote).toBe('github.com/acme/backend');
    expect(JSON.stringify(context)).not.toContain('s3cret');
    expect(context.changedFiles).toContain('dirty.txt');
  });

  it('keeps the first porcelain line intact when it starts with a space (unstaged modification)', async () => {
    // `git status --porcelain` for an unstaged edit is " M file" — a leading
    // space. If the runner trims it away, the parser eats the first character
    // of the first filename ("CHANGELOG.md" -> "HANGELOG.md").
    await fs.writeFile(path.join(repoDir, 'committed.txt'), 'modified');
    const context = await collectGitContext({ cwd: repoDir, includeChangedFiles: true });
    expect(context.changedFiles).toContain('committed.txt');
  });

  it('degrades gracefully outside a repository', async () => {
    const outside = path.join(world.home, 'not-a-repo');
    await fs.mkdir(outside);
    const context = await collectGitContext({ cwd: outside, includeChangedFiles: true });
    expect(context.repositoryRoot).toBeUndefined();
    expect(context.workingDirectory).toBe(outside);
  });
});
