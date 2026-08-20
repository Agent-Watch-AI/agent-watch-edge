import fs from 'node:fs';
import path from 'node:path';
import { asRecord } from '../../core/object.js';
import type { Env } from '../../core/types/core.types.js';
import { findExecutable } from '../../core/which.js';
import { readJsonFile } from '../../storage/json-file.js';
import { HOOK_COMMAND_MARKER } from '../constants/provider.constants.js';
import type { DetectionResult } from '../types/provider.types.js';
import { GEMINI_CLI_VAR, GEMINI_EXECUTABLES, GEMINI_HOME_DIR, GEMINI_HOME_VAR, GEMINI_SETTINGS_FILE } from './constants/gemini.constants.js';

/**
 * Gemini CLI's configuration root.
 *
 * @param env - Environment supplying HOME and GEMINI_HOME.
 * @returns `$GEMINI_HOME`, or `~/.gemini`.
 */
export function geminiHome(env: Env): string {
  return env.vars[GEMINI_HOME_VAR] ?? path.join(env.home, GEMINI_HOME_DIR);
}

/**
 * Where Gemini CLI reads hooks and telemetry settings from.
 *
 * @param env - Environment supplying HOME and GEMINI_HOME.
 * @returns Absolute path of `settings.json`.
 */
export function geminiSettingsPath(env: Env): string {
  return path.join(geminiHome(env), GEMINI_SETTINGS_FILE);
}

/**
 * Whether Gemini CLI is installed here, and whether our hooks are registered.
 *
 * @param env - Environment supplying HOME, cwd and PATH.
 * @returns What was found.
 */
export async function detectGemini(env: Env): Promise<DetectionResult> {
  const evidence: string[] = [];

  if (fs.existsSync(geminiHome(env))) evidence.push('~/.gemini directory exists');

  if (fs.existsSync(path.join(env.cwd, GEMINI_HOME_DIR))) evidence.push('.gemini directory in working tree');

  if (env.vars[GEMINI_CLI_VAR]) evidence.push('GEMINI_CLI environment variable set');

  const executablePath = findFirstExecutable(env);

  if (executablePath) evidence.push(`gemini executable on PATH (${executablePath})`);

  const hookConfigPath = geminiSettingsPath(env);

  return {
    detected: evidence.length > 0,
    evidence,
    executablePath,
    hookConfigPath,
    hooksInstalled: await hasOurHooks(hookConfigPath)
  };
}

/**
 * The first of Gemini's executable names found on PATH.
 *
 * @param env - Environment supplying PATH.
 * @returns The path, or undefined when neither is installed.
 */
function findFirstExecutable(env: Env): string | undefined {
  for (const name of GEMINI_EXECUTABLES) {
    const found = findExecutable(env, name);

    if (found) return found;
  }

  return undefined;
}

/**
 * Whether the settings file already names the agentwatch hook command.
 *
 * @param settingsPath - Gemini settings file.
 * @returns True when our marker appears in the hooks block.
 */
async function hasOurHooks(settingsPath: string): Promise<boolean> {
  const read = await readJsonFile(settingsPath);
  const settings = read.state === 'ok' ? asRecord(read.value) : undefined;

  if (!settings) return false;

  return JSON.stringify(settings['hooks'] ?? {}).includes(HOOK_COMMAND_MARKER);
}
