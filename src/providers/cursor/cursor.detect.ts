import fs from 'node:fs';
import path from 'node:path';
import type { Env } from '../../core/env.js';
import { findExecutable } from '../../core/which.js';
import { readJsonFile } from '../../storage/json-file.js';
import { HOOK_COMMAND_MARKER, type DetectionResult } from '../provider.js';

export function cursorHome(env: Env): string {
  return path.join(env.home, '.cursor');
}

export function cursorHooksJsonPath(env: Env): string {
  return path.join(cursorHome(env), 'hooks.json');
}

export async function detectCursor(env: Env): Promise<DetectionResult> {
  const evidence: string[] = [];
  if (fs.existsSync(cursorHome(env))) evidence.push('~/.cursor directory exists');
  if (fs.existsSync(path.join(env.cwd, '.cursor'))) evidence.push('.cursor directory in working tree');
  const executablePath = findExecutable(env, 'cursor') ?? findExecutable(env, 'cursor-agent');
  if (executablePath) evidence.push(`cursor executable on PATH (${executablePath})`);

  const hookConfigPath = cursorHooksJsonPath(env);
  let hooksInstalled = false;
  const hooksFile = await readJsonFile(hookConfigPath);
  if (hooksFile.state === 'ok') {
    hooksInstalled = JSON.stringify(hooksFile.value).includes(HOOK_COMMAND_MARKER);
  }

  return {
    detected: evidence.length > 0,
    evidence,
    executablePath,
    hookConfigPath,
    hooksInstalled
  };
}
