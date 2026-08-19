import fs from 'node:fs';
import path from 'node:path';
import type { Env } from '../../core/env.js';
import { findExecutable } from '../../core/which.js';
import { readJsonFile } from '../../storage/json-file.js';
import { HOOK_COMMAND_MARKER, type DetectionResult } from '../provider.js';

export function geminiHome(env: Env): string {
  return env.vars['GEMINI_HOME'] ?? path.join(env.home, '.gemini');
}

export function geminiSettingsPath(env: Env): string {
  return path.join(geminiHome(env), 'settings.json');
}

export async function detectGemini(env: Env): Promise<DetectionResult> {
  const evidence: string[] = [];
  const homeDir = geminiHome(env);
  if (fs.existsSync(homeDir)) evidence.push('~/.gemini directory exists');
  if (fs.existsSync(path.join(env.cwd, '.gemini'))) evidence.push('.gemini directory in working tree');
  if (env.vars['GEMINI_CLI']) evidence.push('GEMINI_CLI environment variable set');
  const executablePath = findExecutable(env, 'gemini') ?? findExecutable(env, 'gemini-cli');
  if (executablePath) evidence.push(`gemini executable on PATH (${executablePath})`);

  const hookConfigPath = geminiSettingsPath(env);
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
