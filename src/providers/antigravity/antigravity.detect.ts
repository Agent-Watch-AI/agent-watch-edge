import fs from 'node:fs';
import path from 'node:path';
import type { Env } from '../../core/types/core.types.js';
import { findExecutable } from '../../core/which.js';
import { readJsonFile } from '../../storage/json-file.js';
import { HOOK_COMMAND_MARKER } from '../constants/provider.constants.js';
import type { DetectionResult } from '../types/provider.types.js';
import {
  ANTIGRAVITY_CLI_DIR_SEGMENTS,
  ANTIGRAVITY_EXECUTABLES,
  ANTIGRAVITY_HOOKS_FILE,
  ANTIGRAVITY_ROOT_SEGMENTS
} from './constants/antigravity.constants.js';

/**
 * Antigravity's configuration root.
 *
 * It shares Gemini's home directory: `~/.gemini/config`.
 *
 * @param env - Environment supplying HOME.
 * @returns Absolute path of the config root.
 */
export function antigravityRoot(env: Env): string {
  return path.join(env.home, ...ANTIGRAVITY_ROOT_SEGMENTS);
}

/**
 * Where Antigravity reads named hook groups from.
 *
 * @param env - Environment supplying HOME.
 * @returns Absolute path of `hooks.json`.
 */
export function antigravityHooksPath(env: Env): string {
  return path.join(antigravityRoot(env), ANTIGRAVITY_HOOKS_FILE);
}

/**
 * Whether Antigravity is installed here, and whether our hooks are registered.
 *
 * @param env - Environment supplying HOME and PATH.
 * @returns What was found.
 */
export async function detectAntigravity(env: Env): Promise<DetectionResult> {
  const evidence: string[] = [];

  if (fs.existsSync(path.join(env.home, ...ANTIGRAVITY_CLI_DIR_SEGMENTS))) {
    evidence.push('~/.gemini/antigravity-cli directory exists');
  }

  const executablePath = findFirstExecutable(env);

  if (executablePath) evidence.push(`agy executable on PATH (${executablePath})`);

  const hookConfigPath = antigravityHooksPath(env);
  const read = await readJsonFile(hookConfigPath);

  return {
    detected: evidence.length > 0,
    evidence,
    executablePath,
    hookConfigPath,
    hooksInstalled: read.state === 'ok' && JSON.stringify(read.value).includes(HOOK_COMMAND_MARKER)
  };
}

/**
 * The first of Antigravity's executable names found on PATH.
 *
 * @param env - Environment supplying PATH.
 * @returns The path, or undefined when neither is installed.
 */
function findFirstExecutable(env: Env): string | undefined {
  for (const name of ANTIGRAVITY_EXECUTABLES) {
    const found = findExecutable(env, name);

    if (found) return found;
  }

  return undefined;
}
