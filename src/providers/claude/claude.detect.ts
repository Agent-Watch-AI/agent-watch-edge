import fs from 'node:fs';
import path from 'node:path';
import { asRecord } from '../../core/object.js';
import type { Env } from '../../core/types/core.types.js';
import { findExecutable } from '../../core/which.js';
import { readJsonFile } from '../../storage/json-file.js';
import { HOOK_COMMAND_MARKER } from '../constants/provider.constants.js';
import type { DetectionResult } from '../types/provider.types.js';
import { CLAUDE_EXECUTABLE, CLAUDE_HOME_DIR, CLAUDE_SETTINGS_FILE } from './constants/claude.constants.js';

/**
 * Where Claude Code keeps the settings file AgentWatch registers hooks in.
 *
 * @param env - Environment supplying HOME.
 * @returns Absolute path of `~/.claude/settings.json`.
 */
export function claudeSettingsPath(env: Env): string {
  return path.join(env.home, CLAUDE_HOME_DIR, CLAUDE_SETTINGS_FILE);
}

/**
 * Whether Claude Code is installed here, and whether our hooks are registered.
 *
 * Detection is evidence-based rather than a single test: a developer may have
 * the CLI on PATH without a home directory yet, or a project-local `.claude`
 * without a global install.
 *
 * @param env - Environment supplying HOME, cwd and PATH.
 * @returns What was found.
 */
export async function detectClaude(env: Env): Promise<DetectionResult> {
  const evidence: string[] = [];

  if (fs.existsSync(path.join(env.home, CLAUDE_HOME_DIR))) evidence.push('~/.claude directory exists');

  if (fs.existsSync(path.join(env.cwd, CLAUDE_HOME_DIR))) evidence.push('.claude directory in working tree');

  const executablePath = findExecutable(env, CLAUDE_EXECUTABLE);

  if (executablePath) evidence.push(`claude executable on PATH (${executablePath})`);

  const hookConfigPath = claudeSettingsPath(env);

  return {
    detected: evidence.length > 0,
    evidence,
    executablePath,
    hookConfigPath,
    hooksInstalled: await hasOurHooks(hookConfigPath)
  };
}

/**
 * Whether the settings file already names the agentwatch hook command.
 *
 * @param settingsPath - Claude settings file.
 * @returns True when our marker appears in the hooks block.
 */
async function hasOurHooks(settingsPath: string): Promise<boolean> {
  const read = await readJsonFile(settingsPath);
  const settings = read.state === 'ok' ? asRecord(read.value) : undefined;

  if (!settings) return false;

  return JSON.stringify(settings['hooks'] ?? {}).includes(HOOK_COMMAND_MARKER);
}
