import os from 'node:os';
import process from 'node:process';

/**
 * Ambient environment for every command. All filesystem locations, environment
 * variables and PATH lookups flow through this object so tests can run against
 * a temporary HOME without ever touching the developer's real agent configs.
 */
export interface Env {
  home: string;
  platform: NodeJS.Platform;
  cwd: string;
  vars: Record<string, string | undefined>;
  now(): Date;
}

export function realEnv(): Env {
  return {
    home: os.homedir(),
    platform: process.platform,
    cwd: process.cwd(),
    vars: process.env,
    now: () => new Date()
  };
}
