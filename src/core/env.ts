import os from 'node:os';
import process from 'node:process';
import type { Env } from './types/core.types.js';

export type { Env } from './types/core.types.js';

/**
 * The real process environment.
 *
 * The single place the package reads ambient state from. Everything
 * downstream takes an `Env` argument instead, which is what lets the test
 * suite run every command against a temporary HOME.
 *
 * @returns An Env bound to this process.
 */
export function realEnv(): Env {
  return {
    home: os.homedir(),
    platform: process.platform,
    cwd: process.cwd(),
    vars: process.env,
    now: () => new Date()
  };
}
