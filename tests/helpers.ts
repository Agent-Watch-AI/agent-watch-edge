import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import type { Env } from '../src/core/env.js';

export interface TempWorld {
  env: Env;
  home: string;
  cleanup(): Promise<void>;
}

/**
 * Isolated environment: temp HOME, empty PATH (no real executables detected),
 * config/data dirs inside the temp tree. Tests never touch the developer's
 * real Claude/Codex configuration.
 */
export async function makeTempEnv(overrides: Partial<Env> = {}): Promise<TempWorld> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agentwatch-test-'));
  const env: Env = {
    home,
    platform: process.platform,
    cwd: home,
    vars: {
      AGENTWATCH_CONFIG_DIR: path.join(home, '.agentwatch'),
      AGENTWATCH_DATA_DIR: path.join(home, 'agentwatch-data'),
      PATH: ''
    },
    now: () => new Date(),
    ...overrides
  };
  return {
    env,
    home,
    cleanup: async () => {
      await fs.rm(home, { recursive: true, force: true });
    }
  };
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2));
}

export async function readJson<T = any>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
}
