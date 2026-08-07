import fs from 'node:fs';
import path from 'node:path';
import type { Env } from '../../core/env.js';
import { findExecutable } from '../../core/which.js';
import { readJsonFile } from '../../storage/json-file.js';
import { HOOK_COMMAND_MARKER, type DetectionResult } from '../provider.js';

export function claudeSettingsPath(env: Env): string {
  return path.join(env.home, '.claude', 'settings.json');
}

export async function detectClaude(env: Env): Promise<DetectionResult> {
  const evidence: string[] = [];
  const configDir = path.join(env.home, '.claude');
  if (fs.existsSync(configDir)) evidence.push('~/.claude directory exists');
  if (fs.existsSync(path.join(env.cwd, '.claude'))) evidence.push('.claude directory in working tree');
  const executablePath = findExecutable(env, 'claude');
  if (executablePath) evidence.push(`claude executable on PATH (${executablePath})`);

  const hookConfigPath = claudeSettingsPath(env);
  let hooksInstalled = false;
  const settings = await readJsonFile(hookConfigPath);
  if (settings.state === 'ok' && typeof settings.value === 'object' && settings.value !== null) {
    hooksInstalled = JSON.stringify((settings.value as Record<string, unknown>)['hooks'] ?? {}).includes(HOOK_COMMAND_MARKER);
  }

  return {
    detected: evidence.length > 0,
    evidence,
    executablePath,
    hookConfigPath,
    hooksInstalled
  };
}
