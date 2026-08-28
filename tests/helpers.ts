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

/**
 * Every queue entry file, wherever its identity partition put it.
 *
 * The queue is one directory per identity, so a test that seeds or inspects it
 * through `paths.queueDir` has to look one level down.
 */
export async function queueEntryFiles(queueDir: string): Promise<string[]> {
  const found: string[] = [];
  const pending: string[] = [queueDir];

  while (pending.length > 0) {
    const dir = pending.pop()!;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) pending.push(full);

      if (entry.isFile() && entry.name.endsWith('.json')) found.push(full);
    }
  }

  return found.sort();
}

/** The queue entries themselves, parsed, in filename order. */
export async function readQueueEntries<T = any>(queueDir: string): Promise<T[]> {
  const files = await queueEntryFiles(queueDir);

  return Promise.all(files.map((file) => readJson<T>(file)));
}
