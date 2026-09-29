import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHook } from '../src/cli/hook.js';
import { defaultConfig } from '../src/config/config.js';
import { setVerbose } from '../src/core/logger.js';
import { antigravityProvider } from '../src/providers/antigravity/antigravity.provider.js';
import { codexProvider } from '../src/providers/codex/codex.provider.js';
import { cursorProvider } from '../src/providers/cursor/cursor.provider.js';
import { geminiProvider } from '../src/providers/gemini/gemini.provider.js';
import { classifyTool } from '../src/providers/shared/tooling.js';
import { resolvePaths } from '../src/storage/paths.js';
import { antigravityPreTool, RUN_COMMAND_ARGS } from './fixtures/antigravity.js';
import { cursorBeforeShellExecution, cursorPreToolUseShell } from './fixtures/cursor.js';
import { makeTempEnv, queueEntryFiles, writeJson, type TempWorld } from './helpers.js';

// Codex, Cursor and Gemini shell calls name the checkout they work in (AWT-129).
// The rule is AWT-127's; this proves each agent's payload feeds it.

/** How one agent's hooks look for a prompt, a shell call and the turn's end. */
interface Agent {
  readonly id: 'codex' | 'cursor' | 'gemini';
  prompt(cwd: string): Record<string, unknown>;
  /** The tool-start hook of a shell call, in `cwd`; `workdir` where the agent names one. */
  shell(command: string, cwd: string, workdir?: string): Record<string, unknown>;
  stop(cwd: string): Record<string, unknown>;
}

const TURN = 'turn-1';

const agents: Record<Agent['id'], (session: string, workspace: string) => Agent> = {
  // Codex drops the model's `workdir` before its hooks run, so a Codex call can
  // only say where it works in its command.
  codex: (session) => ({
    id: 'codex',
    prompt: (cwd) => ({ hook_event_name: 'UserPromptSubmit', session_id: session, turn_id: TURN, cwd, prompt: 'go' }),
    shell: (command, cwd, workdir) => ({
      hook_event_name: 'PreToolUse',
      session_id: session,
      turn_id: TURN,
      cwd,
      tool_name: 'Bash',
      tool_use_id: 'call-1',
      tool_input: { command: workdir ? `cd ${workdir} && ${command}` : command }
    }),
    stop: (cwd) => ({ hook_event_name: 'Stop', session_id: session, turn_id: TURN, cwd })
  }),
  // Cursor's prompt and stop hooks carry no cwd: only the window's workspace roots.
  cursor: (session, workspace) => {
    const universal = { conversation_id: session, generation_id: TURN, workspace_roots: [workspace] };

    return {
      id: 'cursor',
      prompt: () => ({ ...universal, hook_event_name: 'beforeSubmitPrompt', prompt: 'go' }),
      shell: (command, cwd, workdir) => ({ ...universal, hook_event_name: 'beforeShellExecution', command, cwd: workdir ?? cwd }),
      stop: () => ({ ...universal, hook_event_name: 'stop', status: 'completed' })
    };
  },
  gemini: (session) => ({
    id: 'gemini',
    prompt: (cwd) => ({ hook_event_name: 'BeforeAgent', session_id: session, prompt_id: TURN, cwd, prompt: 'go' }),
    shell: (command, cwd, workdir) => ({
      hook_event_name: 'BeforeTool',
      session_id: session,
      prompt_id: TURN,
      cwd,
      tool_name: 'run_shell_command',
      tool_input: { command, ...(workdir ? { dir_path: workdir } : {}) }
    }),
    stop: (cwd) => ({ hook_event_name: 'AfterAgent', session_id: session, prompt_id: TURN, cwd, prompt_response: 'done' })
  })
};

describe('shell tool names', () => {
  it("classifies Gemini's run_shell_command as a shell call", () => {
    expect(classifyTool('run_shell_command')).toBe('shell');
  });
});

describe('shellCall per adapter', () => {
  it('reads a Codex command, and nothing it does not report', () => {
    expect(codexProvider.shellCall?.({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git status', workdir: '/w' } })).toEqual({ command: 'git status' });
    expect(codexProvider.shellCall?.({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } })).toEqual({ command: 'ls' });
    expect(codexProvider.shellCall?.({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } })).toBeUndefined();
  });

  it('reads both of Cursor\'s shell-start hooks, and no other', () => {
    expect(cursorProvider.shellCall?.(cursorBeforeShellExecution)).toEqual({ command: 'git status --porcelain', workdir: '/work/project' });
    expect(cursorProvider.shellCall?.(cursorPreToolUseShell)).toEqual({ command: 'npm test', workdir: '/work/project' });
    expect(cursorProvider.shellCall?.({ ...cursorPreToolUseShell, tool_name: 'Read' })).toBeUndefined();
    expect(cursorProvider.workspaceRoots?.(cursorBeforeShellExecution)).toEqual(['/work/project']);
  });

  it("reads Gemini's run_shell_command", () => {
    expect(geminiProvider.shellCall?.({ hook_event_name: 'BeforeTool', cwd: '/w', tool_name: 'run_shell_command', tool_input: { command: 'ls', dir_path: '/w/core' } })).toEqual({
      command: 'ls',
      workdir: '/w/core'
    });
  });

  it("reads Antigravity's run_command", () => {
    expect(antigravityProvider.shellCall?.(antigravityPreTool('run_command', RUN_COMMAND_ARGS))).toEqual({ command: 'npm test', workdir: '/repo' });
  });

  it('takes no relative or non-string working directory, and nothing from a non-shell call', () => {
    expect(geminiProvider.shellCall?.({ hook_event_name: 'BeforeTool', tool_name: 'run_shell_command', tool_input: { command: 'ls', dir_path: 'core' } })).toEqual({ command: 'ls' });
    expect(geminiProvider.shellCall?.({ hook_event_name: 'BeforeTool', tool_name: 'run_shell_command', tool_input: { command: 7, dir_path: ['/x'] } })).toBeUndefined();
    expect(codexProvider.shellCall?.({ hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: 'ls' } })).toBeUndefined();
    expect(cursorProvider.workspaceRoots?.({ workspace_roots: ['relative', '/abs'] })).toEqual(['/abs']);
  });
});

describe.each(['codex', 'cursor', 'gemini'] as const)('the checkout a %s turn worked in', (agentId) => {
  let world: TempWorld;
  let base: string;
  let workspace: string;
  let core: string;
  let worktree: string;
  let agent: Agent;

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, HOME: world.home } }).toString().trim();

  /** `<home>/code/core` on main, and a worktree of it on a ticket branch; the agent sits in `code`. */
  beforeEach(async () => {
    world = await makeTempEnv();
    base = await fs.realpath(world.home);
    workspace = path.join(base, 'code');
    core = path.join(workspace, 'core');
    worktree = path.join(workspace, '.worktrees', 'core-AWT-9');
    agent = agents[agentId](`s-${Math.random().toString(36).slice(2)}`, workspace);

    await fs.mkdir(path.join(core, 'src'), { recursive: true });
    await fs.writeFile(path.join(core, 'src', 'a.ts'), 'a\n');
    git(core, 'init', '-q', '-b', 'main');
    git(core, 'config', 'user.email', 'dev@company.com');
    git(core, 'config', 'user.name', 'Dev');
    git(core, 'remote', 'add', 'origin', 'git@github.com:acme/core.git');
    git(core, 'add', '.');
    git(core, 'commit', '-qm', 'one');
    git(core, 'worktree', 'add', '-q', '-b', 'AWT-9-totals', worktree);
    await writeJson(resolvePaths(world.env).configFile, { ...defaultConfig(), developerEmail: 'dev@company.com' });
  });
  afterEach(async () => {
    setVerbose(false);
    vi.restoreAllMocks();
    await world.cleanup();
  });

  /** One hook through the entry point the agent calls; returns what it queued. */
  async function hook(payload: Record<string, unknown>): Promise<any[]> {
    const paths = resolvePaths(world.env);
    const before = new Set(await queueEntryFiles(paths.dataDir));

    expect(await runHook(agentId, { env: world.env, input: JSON.stringify(payload), dryRun: false, writeStdout: () => undefined })).toBe(0);

    const added = (await queueEntryFiles(paths.dataDir)).filter((file) => !before.has(file) && file.includes(`${path.sep}queue`));

    return Promise.all(added.map(async (file) => JSON.parse(await fs.readFile(file, 'utf8')).event));
  }

  const summaryOf = (events: any[]): any => events.find((event) => event.event.type === 'turn.summary');

  it('reports the worktree a shell call named as its working directory and committed in', async () => {
    await hook(agent.prompt(workspace));
    // The command names no directory: only the agent's own working directory says where it runs.
    await hook(agent.shell('git commit -qam totals', workspace, worktree));
    await fs.writeFile(path.join(worktree, 'src', 'a.ts'), 'totals\n');
    git(worktree, 'commit', '-qam', 'totals');

    expect(summaryOf(await hook(agent.stop(workspace)))).toMatchObject({
      repository: 'github.com/acme/core',
      branch: 'AWT-9-totals',
      jira_ids: ['AWT-9'],
      work_evidence: 'changed',
      files_changed: ['src/a.ts']
    });
  });

  it('keeps no byte of a shell command in any file the edge writes, the queue or its debug log', async () => {
    const markedDir = path.join(base, 'x', 'MARKER_DIR_7f3a');
    const command = `cd ${markedDir} && echo MARKER_ARG_9c1e && git -C ${worktree} status`;
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

    for (const payload of [agent.prompt(workspace), agent.shell(command, workspace), agent.stop(workspace)]) {
      queued.push(...(await hook(payload)));

      const onDisk = await everything();

      expect(onDisk).not.toContain('MARKER_DIR');
      expect(onDisk).not.toContain('MARKER_ARG');
    }

    // Not vacuous: the command's `git -C` nominated the worktree.
    expect(summaryOf(queued)).toMatchObject({ branch: 'AWT-9-totals', work_evidence: 'referenced' });
    expect(JSON.stringify(queued)).not.toContain('MARKER');
    expect(logged.join('')).not.toContain('MARKER');
  });
});

describe('a Cursor workspace root', () => {
  let world: TempWorld;

  beforeEach(async () => {
    world = await makeTempEnv();
    await writeJson(resolvePaths(world.env).configFile, { ...defaultConfig(), developerEmail: 'dev@company.com' });
  });
  afterEach(() => world.cleanup());

  it('is reported when the turn changed it, though no tool call named it', async () => {
    const base = await fs.realpath(world.home);
    const [web, api] = [path.join(base, 'web'), path.join(base, 'api')];
    const git = (cwd: string, ...args: string[]): string =>
      execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, HOME: world.home } }).toString().trim();

    for (const [dir, branch] of [[web, 'main'], [api, 'AWT-5-api']] as const) {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'a.ts'), 'a\n');
      git(dir, 'init', '-q', '-b', branch);
      git(dir, 'config', 'user.email', 'dev@company.com');
      git(dir, 'config', 'user.name', 'Dev');
      git(dir, 'add', '.');
      git(dir, 'commit', '-qm', 'one');
    }

    // Roots configured, so both folders of the window are this tenant's.
    const paths = resolvePaths(world.env);

    await writeJson(paths.configFile, { ...defaultConfig(), developerEmail: 'dev@company.com', roots: { [base]: { developerEmail: 'dev@company.com' } } });

    const universal = { conversation_id: 'conv-1', generation_id: TURN, workspace_roots: [web, api] };
    const run = async (payload: Record<string, unknown>): Promise<any[]> => {
      const before = new Set(await queueEntryFiles(paths.dataDir));

      expect(await runHook('cursor', { env: world.env, input: JSON.stringify({ ...universal, ...payload }), dryRun: false, writeStdout: () => undefined })).toBe(0);

      const added = (await queueEntryFiles(paths.dataDir)).filter((file) => !before.has(file) && file.includes(`${path.sep}queue`));

      return Promise.all(added.map(async (file) => JSON.parse(await fs.readFile(file, 'utf8')).event));
    };

    await run({ hook_event_name: 'beforeSubmitPrompt', prompt: 'go' });
    // A script run in the first root rewrites the second; nothing the edge reads names it.
    await run({ hook_event_name: 'beforeShellExecution', command: 'npm run generate', cwd: web });
    await fs.writeFile(path.join(api, 'a.ts'), 'generated\n');
    await run({ hook_event_name: 'afterShellExecution', command: 'npm run generate', output: '', duration: 5 });

    const summary = (await run({ hook_event_name: 'stop', status: 'completed' })).find((event) => event.event.type === 'turn.summary');

    expect(summary).toMatchObject({ branch: 'AWT-5-api', jira_ids: ['AWT-5'], work_evidence: 'changed', files_changed: ['a.ts'] });
  });

  it('with no roots configured, bounds the session by its workspace, not by where Cursor ran the hook', async () => {
    const base = await fs.realpath(world.home);
    const [web, other] = [path.join(base, 'web'), path.join(base, 'other')];
    const git = (cwd: string, ...args: string[]): string =>
      execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, HOME: world.home } }).toString().trim();

    for (const [dir, branch] of [[web, 'main'], [other, 'AWT-6-other']] as const) {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'a.ts'), 'a\n');
      git(dir, 'init', '-q', '-b', branch);
      git(dir, 'config', 'user.email', 'dev@company.com');
      git(dir, 'config', 'user.name', 'Dev');
      git(dir, 'add', '.');
      git(dir, 'commit', '-qm', 'one');
    }

    // The hook process runs in the home folder (env.cwd), which holds both checkouts.
    const paths = resolvePaths(world.env);
    const universal = { conversation_id: 'conv-2', generation_id: TURN, workspace_roots: [web] };
    const run = async (payload: Record<string, unknown>): Promise<any[]> => {
      const before = new Set(await queueEntryFiles(paths.dataDir));

      expect(await runHook('cursor', { env: world.env, input: JSON.stringify({ ...universal, ...payload }), dryRun: false, writeStdout: () => undefined })).toBe(0);

      const added = (await queueEntryFiles(paths.dataDir)).filter((file) => !before.has(file) && file.includes(`${path.sep}queue`));

      return Promise.all(added.map(async (file) => JSON.parse(await fs.readFile(file, 'utf8')).event));
    };

    await run({ hook_event_name: 'beforeSubmitPrompt', prompt: 'go' });
    await run({ hook_event_name: 'beforeShellExecution', command: `git -C ${other} commit -qam x`, cwd: web });
    await fs.writeFile(path.join(other, 'a.ts'), 'x\n');
    git(other, 'commit', '-qam', 'x');

    const summary = (await run({ hook_event_name: 'stop', status: 'completed' })).find((event) => event.event.type === 'turn.summary');

    expect(summary?.branch).toBe('main');
    expect(summary?.work_evidence).not.toBe('changed');
  });
});
