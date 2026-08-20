import fs from 'node:fs';
import path from 'node:path';
import { POSIX_EXECUTABLE_MASK, WINDOWS_EXECUTABLE_EXTENSIONS } from './constants/core.constants.js';
import type { Env } from './types/core.types.js';

/**
 * Locate an executable on PATH.
 *
 * Hand-rolled rather than shelling out to `which`: agent detection runs on the
 * hook path, where a child process per lookup is the most expensive thing the
 * hook would do.
 *
 * @param env - Environment supplying PATH and the platform.
 * @param name - Executable name without extension.
 * @returns Absolute path of the first match, or undefined when not found.
 */
export function findExecutable(env: Env, name: string): string | undefined {
  const dirs = (env.vars['PATH'] ?? '').split(path.delimiter).filter(Boolean);
  const candidates = executableCandidates(env.platform, name);

  for (const dir of dirs) {
    for (const candidate of candidates) {
      const full = path.join(dir, candidate);

      if (isExecutableFile(full, env.platform)) return full;
    }
  }

  return undefined;
}

/**
 * File names to probe for one executable, in resolution order.
 *
 * @param platform - Host platform.
 * @param name - Executable name without extension.
 * @returns Candidate file names.
 */
function executableCandidates(platform: NodeJS.Platform, name: string): readonly string[] {
  if (platform !== 'win32') return [name];

  return [...WINDOWS_EXECUTABLE_EXTENSIONS.map((extension) => `${name}${extension}`), name];
}

/**
 * Whether a path is a file this platform would execute.
 *
 * @param full - Absolute candidate path.
 * @param platform - Host platform; Windows has no executable bit.
 * @returns True when the file exists and is executable.
 */
function isExecutableFile(full: string, platform: NodeJS.Platform): boolean {
  try {
    const stat = fs.statSync(full);

    if (!stat.isFile()) return false;

    return platform === 'win32' || (stat.mode & POSIX_EXECUTABLE_MASK) !== 0;
  } catch {
    // Not here (or not readable); keep looking.
    return false;
  }
}
