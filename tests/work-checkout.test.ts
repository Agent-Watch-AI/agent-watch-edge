import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHook } from '../src/cli/hook.js';
import { defaultConfig } from '../src/config/config.js';
import { setVerbose } from '../src/core/logger.js';
import { resolvePaths } from '../src/storage/paths.js';
import { makeTempEnv, queueEntryFiles, writeJson, type TempWorld } from './helpers.js';

// Every turn reports the checkout its work changed (AWT-127). Real repositories,
// real git, and every hook through the same entry point Claude Code calls.

describe('the checkout a turn worked in', () => {
  let world: TempWorld;
  let base: string;
  let workspace: string;
  let core: string;
  let worktree: string;
  let session = 's1';

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, HOME: world.home } }).toString().trim();

  async function repository(dir: string, branch = 'main', remote?: string): Promise<void> {
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });

    for (const file of ['a.ts', 'b.ts', 'c.ts']) await fs.writeFile(path.join(dir, 'src', file), `${file}\n`);

    git(dir, 'init', '-q', '-b', branch);
    git(dir, 'config', 'user.email', 'dev@company.com');
    git(dir, 'config', 'user.name', 'Dev');

    if (remote) git(dir, 'remote', 'add', 'origin', remote);

    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'one');
  }

  /** `<home>/code`: not a repository; `core` inside it, and a worktree of core on a ticket branch. */
  beforeEach(async () => {
    world = await makeTempEnv();
    base = await fs.realpath(world.home);
    workspace = path.join(base, 'code');
    core = path.join(workspace, 'core');
    worktree = path.join(workspace, '.worktrees', 'core-AWT-9');
    session = `s-${Math.random().toString(36).slice(2)}`;

    await repository(core, 'main', 'git@github.com:acme/core.git');
    git(core, 'worktree', 'add', '-q', '-b', 'AWT-9-totals', worktree);
    await writeJson(resolvePaths(world.env).configFile, { ...defaultConfig(), developerEmail: 'dev@company.com' });
  });
  afterEach(async () => {
    setVerbose(false);
    vi.restoreAllMocks();
    await world.cleanup();
  });

  /** One hook; returns what it queued (or, on a dry run, printed). */
  async function hook(payload: Record<string, unknown>, cwd: string, dryRun = false): Promise<any[]> {
    const paths = resolvePaths(world.env);
    const before = new Set(await queueEntryFiles(paths.dataDir));
    let stdout = '';

    expect(await runHook('claude', { env: world.env, input: JSON.stringify({ session_id: session, ...payload, cwd }), dryRun, writeStdout: (text) => { stdout += text; } })).toBe(0);

    if (dryRun) return JSON.parse(stdout).events;

    const added = (await queueEntryFiles(paths.dataDir)).filter((file) => !before.has(file) && file.includes(`${path.sep}queue`));

    return Promise.all(added.map(async (file) => JSON.parse(await fs.readFile(file, 'utf8')).event));
  }

  const summaryOf = (events: any[]): any => events.find((event) => event.event.type === 'turn.summary');
  const prompt = (id: string) => ({ hook_event_name: 'UserPromptSubmit', prompt_id: id, prompt: 'go' });
  const stop = (id: string) => ({ hook_event_name: 'Stop', prompt_id: id });
  const bash = (hookName: 'PreToolUse' | 'PostToolUse', id: string, toolUseId: string, command: string) => ({
    hook_event_name: hookName,
    prompt_id: id,
    tool_name: 'Bash',
    tool_use_id: toolUseId,
    tool_input: { command }
  });
  const fileTool = (hookName: 'PreToolUse' | 'PostToolUse', id: string, toolUseId: string, tool: string, filePath: string) => ({
    hook_event_name: hookName,
    prompt_id: id,
    tool_name: tool,
    tool_use_id: toolUseId,
    tool_input: { file_path: filePath }
  });

  /** A Bash call run for real between its two hooks, as Claude Code runs it. */
  async function shell(id: string, toolUseId: string, command: string, cwd: string, act: () => void | Promise<void>): Promise<void> {
    await hook(bash('PreToolUse', id, toolUseId, command), cwd);
    await act();
    await hook(bash('PostToolUse', id, toolUseId, command), cwd);
  }

  it('reports the sibling worktree a session committed in through Bash, with exactly the committed files, then carries it', async () => {
    // Stale dirt in the worktree that this turn never touches.
    await fs.writeFile(path.join(worktree, 'src', 'b.ts'), 'stale\n');
    await hook(prompt('p1'), workspace);
    await shell('p1', 't1', `cd ${worktree} && git commit -qam totals`, workspace, async () => {
      await fs.writeFile(path.join(worktree, 'src', 'a.ts'), 'totals\n');
      git(worktree, 'add', 'src/a.ts');
      git(worktree, 'commit', '-qm', 'totals');
    });

    const events = await hook(stop('p1'), workspace);
    const summary = summaryOf(events);

    expect(summary).toMatchObject({
      repository: 'github.com/acme/core',
      branch: 'AWT-9-totals',
      jira_ids: ['AWT-9'],
      work_evidence: 'changed',
      files_changed: ['src/a.ts']
    });
    expect(summary.commit).toBe(git(worktree, 'rev-parse', 'HEAD'));
    // Taken at the work checkout: the workspace folder is no repository and would yield none.
    expect(events.find((event) => event.event.type === 'repo.snapshot')).toMatchObject({ repository: 'github.com/acme/core' });

    await hook(prompt('p2'), workspace);

    const next = summaryOf(await hook(stop('p2'), workspace));

    expect(next).toMatchObject({ repository: 'github.com/acme/core', branch: 'AWT-9-totals', work_evidence: 'carried' });
    expect(next.files_changed).toBeUndefined();
  });

  it('keeps the repository and branch of a session working inside one repository, and narrows its changed files to the turn', async () => {
    for (const file of ['a.ts', 'b.ts', 'c.ts']) await fs.writeFile(path.join(core, 'src', file), 'stale\n');

    const target = path.join(core, 'src', 'b.ts');

    await hook(prompt('p1'), core);
    await hook(fileTool('PreToolUse', 'p1', 't1', 'Edit', target), core);
    await fs.writeFile(target, 'edited by the turn\n');
    await hook(fileTool('PostToolUse', 'p1', 't1', 'Edit', target), core);

    const summary = summaryOf(await hook(stop('p1'), core));

    expect(summary).toMatchObject({ repository: 'github.com/acme/core', branch: 'main', work_evidence: 'changed', files_changed: ['src/b.ts'], files_touched: ['src/b.ts'] });
  });

  it('reports the folder a turn with no tool calls ended in, as before', async () => {
    await hook(prompt('p1'), core);

    const summary = summaryOf(await hook(stop('p1'), core));

    expect(summary).toMatchObject({ repository: 'github.com/acme/core', branch: 'main', work_evidence: 'cwd' });
    expect(summary.files_changed).toBeUndefined();
  });

  it('reports the checkout a turn only looked at, and a named shell call does not also vote for its cwd', async () => {
    // Started in the workspace, sits in core (on main) after a lasting cd; looks
    // at the worktree twice by name, once at nothing.
    await hook(prompt('p1'), workspace);
    await shell('p1', 't1', 'ls', core, () => {});
    await shell('p1', 't2', `git -C ${worktree} log -1`, core, () => {});
    await shell('p1', 't3', `ls ${worktree}/src`, core, () => {});

    const summary = summaryOf(await hook(stop('p1'), core));

    // core: one vote (the unnamed `ls`); the worktree: two. Were the named calls'
    // cwd counted too, core would have three.
    expect(summary).toMatchObject({ branch: 'AWT-9-totals', work_evidence: 'referenced' });
  });

  it('prefers a checkout the turn changed over the one the session carries', async () => {
    const other = path.join(workspace, 'other');

    await repository(other, 'AWT-10-other');
    await hook(prompt('p1'), workspace);
    await shell('p1', 't1', `git -C ${worktree} commit`, workspace, () => {
      git(worktree, 'commit', '-q', '--allow-empty', '-m', 'x');
      execFileSync('touch', [path.join(worktree, 'src', 'new.ts')]);
    });
    expect(summaryOf(await hook(stop('p1'), workspace))).toMatchObject({ branch: 'AWT-9-totals', work_evidence: 'changed' });

    await hook(prompt('p2'), workspace);
    await shell('p2', 't2', `cd ${other} && touch src/z.ts`, workspace, () => fs.writeFile(path.join(other, 'src', 'z.ts'), 'z\n'));
    expect(summaryOf(await hook(stop('p2'), workspace))).toMatchObject({ branch: 'AWT-10-other', work_evidence: 'changed', files_changed: ['src/z.ts'] });

    // Looks at the worktree, changes nothing: the last changed checkout is carried.
    await hook(prompt('p3'), workspace);
    await shell('p3', 't3', `ls ${worktree}`, workspace, () => {});
    expect(summaryOf(await hook(stop('p3'), workspace))).toMatchObject({ branch: 'AWT-10-other', work_evidence: 'carried' });
  });

  it('ignores a ninth checkout named in one turn', async () => {
    const repos = Array.from({ length: 9 }, (_, index) => path.join(workspace, `r${String(index)}`));

    for (const [index, dir] of repos.entries()) await repository(dir, `AWT-${String(100 + index)}-r`);

    await hook(prompt('p1'), workspace);
    await shell('p1', 't1', repos.map((dir) => `ls ${dir}`).join(' && '), workspace, () => fs.writeFile(path.join(repos[8]!, 'src', 'a.ts'), 'changed\n'));

    const summary = summaryOf(await hook(stop('p1'), workspace));

    // The only change is in the ninth, which was never a candidate; the first named wins by votes.
    expect(summary).toMatchObject({ branch: 'AWT-100-r', work_evidence: 'referenced' });
  });

  it('never reports a checkout outside the start folder when no roots are configured', async () => {
    const notes = path.join(workspace, 'notes');

    await fs.mkdir(notes);
    await hook(prompt('p1'), notes);
    await shell('p1', 't1', `cd ${worktree} && git commit -qam x`, notes, async () => {
      await fs.writeFile(path.join(worktree, 'src', 'a.ts'), 'x\n');
      git(worktree, 'commit', '-qam', 'x');
    });

    const summary = summaryOf(await hook(stop('p1'), notes));

    expect(summary.repository).toBeUndefined();
    expect(summary.work_evidence).toBeUndefined();
    expect(JSON.stringify(summary)).not.toContain('AWT-9');
  });

  it("never reports, or runs git in, a checkout another tenant's root claims", async () => {
    const watch = path.join(base, 'agent watch');
    const trip = path.join(base, 'tripPlanner');
    const start = path.join(watch, 'docs');
    const tripRepo = path.join(trip, 'app');

    await fs.mkdir(start, { recursive: true });
    await repository(tripRepo, 'AWT-77-trip');
    await writeJson(resolvePaths(world.env).configFile, {
      ...defaultConfig(),
      developerEmail: 'dev@company.com',
      roots: { [watch]: { token: 'watch-token' }, [trip]: { token: 'trip-token' } }
    });
    await hook(prompt('p1'), start);
    await shell('p1', 't1', `cd ${tripRepo} && git commit -qam x`, start, async () => {
      await fs.writeFile(path.join(tripRepo, 'src', 'a.ts'), 'x\n');
      git(tripRepo, 'commit', '-qam', 'x');
    });

    const summary = summaryOf(await hook(stop('p1'), start, true));
    const turnState = await fs.readdir(resolvePaths(world.env).turnsDir, { recursive: true });

    expect(summary.repository).toBeUndefined();
    expect(JSON.stringify(summary)).not.toContain('AWT-77');
    // Refused when named, so no checkout record and no fingerprint was ever taken.
    expect(turnState.some((name) => String(name).includes('checkout--'))).toBe(false);
  });

  it('admits a worktree beside the start folder when both lie in the same root', async () => {
    const docs = path.join(workspace, 'docs');

    await fs.mkdir(docs);
    await writeJson(resolvePaths(world.env).configFile, { ...defaultConfig(), developerEmail: 'dev@company.com', roots: { [workspace]: { developerEmail: 'dev@company.com' } } });
    await hook(prompt('p1'), docs);
    await shell('p1', 't1', `cd ${worktree} && git commit -qam x`, docs, async () => {
      await fs.writeFile(path.join(worktree, 'src', 'a.ts'), 'x\n');
      git(worktree, 'commit', '-qam', 'x');
    });

    expect(summaryOf(await hook(stop('p1'), docs, true))).toMatchObject({ branch: 'AWT-9-totals', work_evidence: 'changed', files_changed: ['src/a.ts'] });
  });

  it('drops work_evidence with the other repository fields when git capture is off', async () => {
    await writeJson(resolvePaths(world.env).configFile, { ...defaultConfig(), developerEmail: 'dev@company.com', capture: { ...defaultConfig().capture, git: false } });
    await hook(prompt('p1'), core);
    await shell('p1', 't1', `git -C ${worktree} status`, core, () => {});

    const summary = summaryOf(await hook(stop('p1'), core));

    expect(summary.repository).toBeUndefined();
    expect(summary.work_evidence).toBeUndefined();
  });

  it('admits the checkout a session started inside of, from a subfolder, with no roots configured', async () => {
    const sub = path.join(core, 'src');
    const target = path.join(sub, 'a.ts');

    await hook(prompt('p1'), sub);
    await hook(fileTool('PreToolUse', 'p1', 't1', 'Edit', target), sub);
    await fs.writeFile(target, 'edited\n');
    await hook(fileTool('PostToolUse', 'p1', 't1', 'Edit', target), sub);

    expect(summaryOf(await hook(stop('p1'), sub))).toMatchObject({ branch: 'main', work_evidence: 'changed', files_changed: ['src/a.ts'] });
  });

  it("reports no checkout when the session started in one tenant's root and closes in another's", async () => {
    const watch = path.join(base, 'watch');
    const trip = path.join(base, 'trip');
    const watchRepo = path.join(watch, 'repo');

    await repository(watchRepo, 'AWT-5-watch');
    await fs.mkdir(trip, { recursive: true });
    await writeJson(resolvePaths(world.env).configFile, {
      ...defaultConfig(),
      developerEmail: 'dev@company.com',
      roots: { [watch]: { token: 'watch-token' }, [trip]: { token: 'trip-token' } }
    });
    await hook(prompt('p1'), watch, true);
    await shell('p1', 't1', `cd ${watchRepo} && touch src/new.ts`, watch, () => fs.writeFile(path.join(watchRepo, 'src', 'new.ts'), 'x\n'));

    // The Stop fires from trip's root, and would be sent with trip's token.
    const summary = summaryOf(await hook(stop('p1'), trip, true));

    expect(summary.repository).toBeUndefined();
    expect(JSON.stringify(summary)).not.toContain('AWT-5');
  });

  it('finds a worktree the shell call itself created, once the call has run', async () => {
    const fresh = path.join(workspace, '.worktrees', 'core-AWT-11');
    const command = `git -C ${core} worktree add -q -b AWT-11-new ${fresh}`;

    await hook(prompt('p1'), workspace);
    await shell('p1', 't1', command, workspace, () => {
      git(core, 'worktree', 'add', '-q', '-b', 'AWT-11-new', fresh);
    });
    await shell('p1', 't2', `cd ${fresh} && git status`, workspace, () => {});

    // At the first PreToolUse the new path named no checkout; read again after
    // the call, it is one, and votes. Two votes to core's one; without the
    // second read it would tie with core and lose to it as named later.
    const summary = summaryOf(await hook(stop('p1'), workspace));

    expect(summary.branch).toBe('AWT-11-new');
  });

  it('counts an empty commit as a change', async () => {
    await hook(prompt('p1'), workspace);
    await shell('p1', 't1', `git -C ${worktree} commit --allow-empty -m x`, workspace, () => {
      git(worktree, 'commit', '-q', '--allow-empty', '-m', 'x');
    });

    const summary = summaryOf(await hook(stop('p1'), workspace));

    expect(summary).toMatchObject({ branch: 'AWT-9-totals', work_evidence: 'changed' });
    expect(summary.files_changed).toBeUndefined();
  });

  it('does not count a failed edit as a change', async () => {
    const target = path.join(worktree, 'src', 'a.ts');

    await hook(prompt('p1'), workspace);
    await hook(fileTool('PreToolUse', 'p1', 't1', 'Edit', target), workspace);
    await hook({ ...fileTool('PostToolUse', 'p1', 't1', 'Edit', target), hook_event_name: 'PostToolUseFailure', tool_error: 'no match' }, workspace);

    expect(summaryOf(await hook(stop('p1'), workspace)).work_evidence).not.toBe('changed');
  });

  it('reports no checkout path once git capture is off at the Stop', async () => {
    const target = path.join(worktree, 'src', 'a.ts');

    await hook(prompt('p1'), workspace);
    await hook(fileTool('PreToolUse', 'p1', 't1', 'Edit', target), workspace);
    await hook(fileTool('PostToolUse', 'p1', 't1', 'Edit', target), workspace);
    await writeJson(resolvePaths(world.env).configFile, { ...defaultConfig(), developerEmail: 'dev@company.com', capture: { ...defaultConfig().capture, git: false } });

    const summary = summaryOf(await hook(stop('p1'), workspace));

    expect(summary.repository).toBeUndefined();
    expect(summary.files_touched).toBeUndefined();
  });

  it('writes no checkout record and no work checkout on a dry run', async () => {
    const paths = resolvePaths(world.env);

    await hook(prompt('p1'), workspace, true);
    await hook(bash('PreToolUse', 'p1', 't1', `cd ${worktree} && ls`), workspace, true);
    await hook(stop('p1'), workspace, true);

    const names = await fs.readdir(paths.turnsDir, { recursive: true }).catch(() => [] as string[]);

    expect(names.some((name) => String(name).includes('checkout'))).toBe(false);
  });

  it('keeps no byte of a shell command in any file the edge writes, the queue or its debug log', async () => {
    // A marker in a directory name the command cds into, and one in an argument.
    // The directory exists and lies in no checkout; the same command also names
    // the worktree, so a nomination really happens and the test is not vacuous.
    const markedDir = path.join(base, 'x', 'MARKER_DIR_7f3a');
    const command = `cd ${markedDir} && echo MARKER_ARG_9c1e && git -C ${worktree} status`;
    const paths = resolvePaths(world.env);
    const logged: string[] = [];

    await fs.mkdir(markedDir, { recursive: true });
    setVerbose(true);
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      logged.push(String(chunk));

      return true;
    });

    const everything = async (): Promise<string> => {
      const names = (await fs.readdir(base, { recursive: true })).map(String).filter((name) => !name.startsWith('code') && !name.startsWith('x'));
      const contents = await Promise.all(names.map((name) => fs.readFile(path.join(base, name), 'utf8').catch(() => '')));

      return [...names, ...contents].join('\n');
    };
    const queued: any[] = [];

    for (const payload of [prompt('p1'), bash('PreToolUse', 'p1', 't1', command), bash('PostToolUse', 'p1', 't1', command), stop('p1')]) {
      queued.push(...(await hook(payload, workspace)));

      // Not vacuous: mid-turn, the named worktree is in turn state as a root.
      if (payload.hook_event_name === 'PreToolUse') {
        expect((await fs.readdir(paths.turnsDir, { recursive: true })).some((name) => String(name).includes('checkout--'))).toBe(true);
      }

      const onDisk = await everything();

      expect(onDisk).not.toContain('MARKER_DIR');
      expect(onDisk).not.toContain('MARKER_ARG');
    }

    expect(summaryOf(queued)).toMatchObject({ branch: 'AWT-9-totals', work_evidence: 'referenced' });
    expect(JSON.stringify(queued)).not.toContain('MARKER');
    expect(logged.join('')).not.toContain('MARKER');
  });
});
