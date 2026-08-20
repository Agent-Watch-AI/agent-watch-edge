import fs from 'node:fs';
import path from 'node:path';
import type { Env } from '../../core/types/core.types.js';
import { findExecutable } from '../../core/which.js';
import { readJsonFile } from '../../storage/json-file.js';
import { HOOK_COMMAND_MARKER } from '../constants/provider.constants.js';
import type { DetectionResult } from '../types/provider.types.js';
import { CURSOR_EXECUTABLES, CURSOR_HOME_DIR, CURSOR_HOOKS_FILE } from './constants/cursor.constants.js';

/**
 * Cursor's configuration root.
 *
 * @param env - Environment supplying HOME.
 * @returns Absolute path of `~/.cursor`.
 */
export function cursorHome(env: Env): string {
  return path.join(env.home, CURSOR_HOME_DIR);
}

/**
 * Where Cursor reads user-level hook registrations from.
 *
 * @param env - Environment supplying HOME.
 * @returns Absolute path of `hooks.json`.
 */
export function cursorHooksJsonPath(env: Env): string {
  return path.join(cursorHome(env), CURSOR_HOOKS_FILE);
}

/**
 * Whether Cursor is installed here, and whether our hooks are registered.
 *
 * @param env - Environment supplying HOME, cwd and PATH.
 * @returns What was found.
 */
export async function detectCursor(env: Env): Promise<DetectionResult> {
  const evidence: string[] = [];

  if (fs.existsSync(cursorHome(env))) evidence.push('~/.cursor directory exists');

  if (fs.existsSync(path.join(env.cwd, CURSOR_HOME_DIR))) evidence.push('.cursor directory in working tree');

  const executablePath = findFirstExecutable(env);

  if (executablePath) evidence.push(`cursor executable on PATH (${executablePath})`);

  const hookConfigPath = cursorHooksJsonPath(env);
  const hooksFile = await readJsonFile(hookConfigPath);

  return {
    detected: evidence.length > 0,
    evidence,
    executablePath,
    hookConfigPath,
    hooksInstalled: hooksFile.state === 'ok' && JSON.stringify(hooksFile.value).includes(HOOK_COMMAND_MARKER)
  };
}

/**
 * The first of Cursor's executable names found on PATH.
 *
 * The editor ships `cursor`; the CLI agent ships `cursor-agent`, and a machine
 * may have either.
 *
 * @param env - Environment supplying PATH.
 * @returns The path, or undefined when neither is installed.
 */
function findFirstExecutable(env: Env): string | undefined {
  for (const name of CURSOR_EXECUTABLES) {
    const found = findExecutable(env, name);

    if (found) return found;
  }

  return undefined;
}
