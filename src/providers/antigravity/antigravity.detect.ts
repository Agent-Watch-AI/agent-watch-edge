import fs from 'node:fs';
import path from 'node:path';
import type { Env } from '../../core/env.js';
import { findExecutable } from '../../core/which.js';
import { readJsonFile } from '../../storage/json-file.js';
import { HOOK_COMMAND_MARKER, type DetectionResult } from '../provider.js';

export function antigravityRoot(env: Env): string { return path.join(env.home, '.gemini', 'config'); }
export function antigravityHooksPath(env: Env): string { return path.join(antigravityRoot(env), 'hooks.json'); }

export async function detectAntigravity(env: Env): Promise<DetectionResult> {
  const evidence: string[] = [];
  const cliHome = path.join(env.home, '.gemini', 'antigravity-cli');
  if (fs.existsSync(cliHome)) evidence.push('~/.gemini/antigravity-cli directory exists');
  const executablePath = findExecutable(env, 'agy') ?? findExecutable(env, 'antigravity');
  if (executablePath) evidence.push(`agy executable on PATH (${executablePath})`);
  const hookConfigPath = antigravityHooksPath(env);
  const read = await readJsonFile(hookConfigPath);
  const hooksInstalled = read.state === 'ok' && JSON.stringify(read.value).includes(HOOK_COMMAND_MARKER);
  return { detected: evidence.length > 0, evidence, executablePath, hookConfigPath, hooksInstalled };
}
