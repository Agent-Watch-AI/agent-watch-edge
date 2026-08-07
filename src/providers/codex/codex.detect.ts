import fs from 'node:fs';
import path from 'node:path';
import type { Env } from '../../core/env.js';
import { findExecutable } from '../../core/which.js';
import { readJsonFile } from '../../storage/json-file.js';
import { HOOK_COMMAND_MARKER, type DetectionResult } from '../provider.js';

export function codexHome(env: Env): string {
  return env.vars['CODEX_HOME'] ?? path.join(env.home, '.codex');
}

export function codexHooksJsonPath(env: Env): string {
  return path.join(codexHome(env), 'hooks.json');
}

export function codexConfigTomlPath(env: Env): string {
  return path.join(codexHome(env), 'config.toml');
}

export async function detectCodex(env: Env): Promise<DetectionResult> {
  const evidence: string[] = [];
  if (fs.existsSync(codexHome(env))) evidence.push('~/.codex directory exists');
  if (fs.existsSync(path.join(env.cwd, '.codex'))) evidence.push('.codex directory in working tree');
  const executablePath = findExecutable(env, 'codex');
  if (executablePath) evidence.push(`codex executable on PATH (${executablePath})`);

  const hookConfigPath = codexHooksJsonPath(env);
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
