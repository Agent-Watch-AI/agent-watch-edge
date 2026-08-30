import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveDeveloperEmail, runSetup } from '../src/cli/setup.js';
import { runDoctor } from '../src/cli/doctor.js';
import { symbols } from '../src/cli/ui.js';
import { defaultConfig } from '../src/config/config.js';
import { saveConfig } from '../src/config/config-store.js';
import type { AgentWatchConfig } from '../src/config/types/config.types.js';
import type { GitRunner } from '../src/git/types/git.types.js';
import { resolvePaths } from '../src/storage/paths.js';
import { makeTempEnv, readJson, type TempWorld } from './helpers.js';

/** A git that answers `config --get user.email` with exactly this. */
function gitSaying(email: string | undefined): GitRunner {
  return async () => email;
}

function configWith(developerEmail: string | undefined): AgentWatchConfig {
  return { ...defaultConfig(), developerEmail };
}

describe('resolveDeveloperEmail', () => {
  let world: TempWorld;

  beforeEach(async () => {
    world = await makeTempEnv();
  });
  afterEach(() => world.cleanup());

  it('prefers the --developer-email flag over git and the stored config', async () => {
    const resolved = await resolveDeveloperEmail(
      { env: world.env, developerEmail: 'flag@company.com', gitRun: gitSaying('git@company.com') },
      configWith('stored@company.com'),
      undefined
    );

    expect(resolved).toBe('flag@company.com');
  });

  it('keeps the stored identity when no flag is given', async () => {
    const resolved = await resolveDeveloperEmail({ env: world.env, gitRun: gitSaying('git@company.com') }, configWith('stored@company.com'), undefined);

    expect(resolved).toBe('stored@company.com');
  });

  it('falls back to git config user.email', async () => {
    const resolved = await resolveDeveloperEmail({ env: world.env, gitRun: gitSaying('git@company.com') }, configWith(undefined), undefined);

    expect(resolved).toBe('git@company.com');
  });

  it('asks when git has no identity and the run is interactive', async () => {
    const questions: string[] = [];
    const resolved = await resolveDeveloperEmail({ env: world.env, gitRun: gitSaying(undefined) }, configWith(undefined), async (question) => {
      questions.push(question);

      return 'typed@company.com';
    });

    expect(resolved).toBe('typed@company.com');
    expect(questions).toHaveLength(1);
  });

  it('resolves to nothing when git has no identity and the run cannot ask', async () => {
    const resolved = await resolveDeveloperEmail({ env: world.env, gitRun: gitSaying(undefined) }, configWith(undefined), undefined);

    expect(resolved).toBeUndefined();
  });

  it('treats a whitespace-only git identity as no identity', async () => {
    const resolved = await resolveDeveloperEmail({ env: world.env, gitRun: gitSaying('   ') }, configWith(undefined), undefined);

    expect(resolved).toBeUndefined();
  });
});

describe('setup without a resolvable developer identity', () => {
  let world: TempWorld;

  beforeEach(async () => {
    world = await makeTempEnv();
    await fs.mkdir(path.join(world.home, '.claude'), { recursive: true });
  });
  afterEach(() => world.cleanup());

  /** Everything an unattended install passes, minus the identity. */
  function unattended(overrides: Record<string, unknown> = {}) {
    return {
      env: world.env,
      endpoint: 'https://backend.example.com',
      token: 'tok-1',
      yes: true,
      gitRun: gitSaying(undefined),
      hookCommandFor: (id: string) => `agentwatch hook --agent ${id}`,
      ...overrides
    };
  }

  async function captureStderr(run: () => Promise<number>): Promise<{ code: number; stderr: string }> {
    const chunks: string[] = [];
    const original = process.stderr.write.bind(process.stderr);

    process.stderr.write = ((chunk: unknown) => {
      chunks.push(String(chunk));

      return true;
    }) as typeof process.stderr.write;

    try {
      return { code: await run(), stderr: chunks.join('') };
    } finally {
      process.stderr.write = original;
    }
  }

  it('exits non-zero and writes no config file', async () => {
    const { code } = await captureStderr(() => runSetup(unattended()));

    expect(code).toBe(1);
    await expect(fs.stat(resolvePaths(world.env).configFile)).rejects.toThrow();
  });

  it('names both remedies on stderr', async () => {
    const { stderr } = await captureStderr(() => runSetup(unattended()));

    expect(stderr).toContain('git config --global user.email');
    expect(stderr).toContain('--developer-email');
  });

  it('completes with zero prompts when the copied command carries --yes', async () => {
    const questions: string[] = [];
    const code = await runSetup(
      unattended({
        gitRun: gitSaying('git@company.com'),
        ask: async (question: string) => {
          questions.push(question);

          return '';
        }
      })
    );

    expect(code).toBe(0);
    expect(questions).toEqual([]);
  });

  it('lets --developer-email override the machine git identity', async () => {
    const code = await runSetup(unattended({ developerEmail: 'flag@company.com', gitRun: gitSaying('wrong@old-employer.com') }));

    expect(code).toBe(0);
    expect((await readJson(resolvePaths(world.env).configFile)).developerEmail).toBe('flag@company.com');
  });
});

describe('doctor developer identity check', () => {
  let world: TempWorld;

  beforeEach(async () => {
    world = await makeTempEnv();
  });
  afterEach(() => world.cleanup());

  async function captureStdout(run: () => Promise<number>): Promise<{ code: number; stdout: string }> {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);

    process.stdout.write = ((chunk: unknown) => {
      chunks.push(String(chunk));

      return true;
    }) as typeof process.stdout.write;

    try {
      return { code: await run(), stdout: chunks.join('') };
    } finally {
      process.stdout.write = original;
    }
  }

  it('fails the human report when nothing can name the developer', async () => {
    const { code, stdout } = await captureStdout(() => runDoctor(world.env, { gitRun: gitSaying(undefined) }));

    expect(code).toBe(1);
    expect(stdout).toContain(`${symbols.fail} developer identity`);
    expect(stdout).toContain('git config --global user.email');
    expect(stdout).toContain('--developer-email');
  });

  it('carries the condition as a failure in --json', async () => {
    const { stdout } = await captureStdout(() => runDoctor(world.env, { json: true, gitRun: gitSaying(undefined) }));

    const check = JSON.parse(stdout).checks.find((entry: { name: string }) => entry.name === 'developer identity');

    expect(check.level).toBe('fail');
    expect(check.detail).toContain('--developer-email');
  });

  it('passes once the config names a developer', async () => {
    await saveConfig(resolvePaths(world.env), { ...defaultConfig(), developerEmail: 'dev@company.com', installationId: 'inst-t' });

    const { stdout } = await captureStdout(() => runDoctor(world.env, { json: true, gitRun: gitSaying(undefined) }));

    const check = JSON.parse(stdout).checks.find((entry: { name: string }) => entry.name === 'developer identity');

    expect(check).toEqual({ name: 'developer identity', level: 'ok', detail: 'dev@company.com' });
  });
});
