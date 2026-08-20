import fs from 'node:fs';
import path from 'node:path';
import type { Env } from '../../core/types/core.types.js';
import { findExecutable } from '../../core/which.js';
import { readJsonFile } from '../../storage/json-file.js';
import { HOOK_COMMAND_MARKER } from '../constants/provider.constants.js';
import type { DetectionResult } from '../types/provider.types.js';
import { CODEX_CONFIG_FILE, CODEX_EXECUTABLE, CODEX_HOME_DIR, CODEX_HOME_VAR, CODEX_HOOKS_FILE } from './constants/codex.constants.js';

/**
 * Codex's configuration root.
 *
 * @param env - Environment supplying HOME and CODEX_HOME.
 * @returns `$CODEX_HOME`, or `~/.codex`.
 */
export function codexHome(env: Env): string {
  return env.vars[CODEX_HOME_VAR] ?? path.join(env.home, CODEX_HOME_DIR);
}

/**
 * Where Codex reads hook registrations from.
 *
 * @param env - Environment supplying HOME and CODEX_HOME.
 * @returns Absolute path of `hooks.json`.
 */
export function codexHooksJsonPath(env: Env): string {
  return path.join(codexHome(env), CODEX_HOOKS_FILE);
}

/**
 * Where Codex reads its feature flags from.
 *
 * @param env - Environment supplying HOME and CODEX_HOME.
 * @returns Absolute path of `config.toml`.
 */
export function codexConfigTomlPath(env: Env): string {
  return path.join(codexHome(env), CODEX_CONFIG_FILE);
}

/**
 * Whether Codex is installed here, and whether our hooks are registered.
 *
 * @param env - Environment supplying HOME, cwd and PATH.
 * @returns What was found.
 */
export async function detectCodex(env: Env): Promise<DetectionResult> {
  const evidence: string[] = [];

  if (fs.existsSync(codexHome(env))) evidence.push('~/.codex directory exists');

  if (fs.existsSync(path.join(env.cwd, CODEX_HOME_DIR))) evidence.push('.codex directory in working tree');

  const executablePath = findExecutable(env, CODEX_EXECUTABLE);

  if (executablePath) evidence.push(`codex executable on PATH (${executablePath})`);

  const hookConfigPath = codexHooksJsonPath(env);
  const hooksFile = await readJsonFile(hookConfigPath);

  return {
    detected: evidence.length > 0,
    evidence,
    executablePath,
    hookConfigPath,
    hooksInstalled: hooksFile.state === 'ok' && JSON.stringify(hooksFile.value).includes(HOOK_COMMAND_MARKER)
  };
}
