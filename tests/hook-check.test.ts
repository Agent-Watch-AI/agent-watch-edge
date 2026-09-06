import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkHookCommand, installedHookChecks } from '../src/cli/hook-check.js';
import { makeTempEnv, type TempWorld } from './helpers.js';

describe('stored hook command diagnostics', () => {
  let world: TempWorld;
  let cli: string;
  let bin: string;

  beforeEach(async () => {
    world = await makeTempEnv();
    const dir = path.join(world.home, 'global bin with spaces');

    await fs.mkdir(dir);
    cli = path.join(dir, 'cli.js');
    bin = path.join(dir, 'agentwatch');
    await fs.writeFile(cli, '#!/usr/bin/env node\nconsole.log("0.2.5");\n', { mode: 0o755 });
    await fs.symlink(cli, bin);
    await fs.symlink(process.execPath, path.join(dir, 'node'));
    world.env.vars['PATH'] = dir;
  });
  afterEach(() => world.cleanup());

  it('validates a global installation with quoted spaces', async () => {
    expect((await checkHookCommand(`"${bin}" hook --agent claude`, world.env, cli)).level).toBe('ok');
    expect((await checkHookCommand('agentwatch hook --agent codex', world.env, cli)).level).toBe('ok');
  });
  it('detects missing Node despite the doctor process itself running', async () => {
    world.env.vars['PATH'] = '';
    expect((await checkHookCommand(`"${bin}" hook --agent claude`, world.env, cli)).detail).toContain('Missing Node.js');
  });
  it('detects stale absolute version-manager paths', async () => {
    expect((await checkHookCommand('"/missing/.nvm/v20/bin/agentwatch" hook --agent claude', world.env, cli)).detail).toContain('stale');
  });
  it('does not execute a different installation or shell fragments', async () => {
    // A wrapper-script install (pnpm, volta, Windows) lands here too, so this
    // is a warning that skips the probe, not a failed doctor run.
    const other = await checkHookCommand(`"${bin}" hook --agent claude`, world.env, '/another/cli.js');

    expect(other.level).toBe('warn');
    expect(other.detail).toContain('different AgentWatch installation');
    expect((await checkHookCommand(`"${bin}" hook --agent claude; touch /tmp/untrusted`, world.env, cli)).level).toBe('fail');
  });
  it('bounds a hung version command', async () => {
    await fs.writeFile(cli, 'setInterval(() => {}, 1000);');
    expect((await checkHookCommand(`"${bin}" hook --agent claude`, world.env, cli, 50)).detail).toContain('timed out');
  });

  it('finds commands under a provider group key, not just `hooks`', async () => {
    const file = path.join(world.home, 'antigravity-hooks.json');

    // Antigravity nests handlers under its own group name; a `hooks`-only walk
    // reported nothing for it at all.
    await fs.writeFile(file, JSON.stringify({ agentwatch: { PreToolUse: [{ hooks: [{ command: `"${bin}" hook --agent antigravity` }] }] } }));
    const checks = await installedHookChecks(file, world.env);

    expect(checks).toHaveLength(1);
    expect(checks[0]!.level).toBe('warn');
  });
});
