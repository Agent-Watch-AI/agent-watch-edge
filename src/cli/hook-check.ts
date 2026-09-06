import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { asRecord } from '../core/object.js';
import type { Env } from '../core/types/core.types.js';
import { findExecutable } from '../core/which.js';
import { isAgentWatchHookCommand, tokenizeHookCommand } from '../providers/provider.js';
import { readJsonFile } from '../storage/json-file.js';
import type { Check } from './types/cli.types.js';

const CLI_PATH = fileURLToPath(new URL('../cli.js', import.meta.url));
const VERSION_TIMEOUT_MS = 1500;
const VERSION_MANAGER_PATH = /(?:\.nvm|\.fnm|fnm_multishells|\.asdf|\.volta)[/\\]/;
const NODE_NAME = /^node(?:[\d.]*|js)?(?:\.exe)?$/;
const VERSION_OUTPUT = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?\s*$/;
const REMEDY = 'Install Node.js 20+ on the coding agent launch PATH, reinstall @agent-watch-ai/edge, then run agentwatch setup from that installation and restart the agent. GUI applications may have a different PATH.';

/**
 * Inspect commands only from a provider's user hook file, never repository config.
 *
 * The whole file is walked rather than a `hooks` key: Antigravity nests its
 * handlers under its own group name. Only commands `isAgentWatchHookCommand`
 * claims are collected, so a wider walk cannot pick up a foreign command.
 *
 * @param file - User hook configuration path.
 * @param env - Launch environment to validate.
 * @returns A finding for every distinct managed command.
 */
export async function installedHookChecks(file: string, env: Env): Promise<Check[]> {
  const read = await readJsonFile(file);

  if (read.state !== 'ok') return [];

  const commands = new Set(collectCommands(read.value));

  return Promise.all([...commands].map((command) => checkHookCommand(command, env)));
}

/**
 * Validate a recognized hook without invoking a shell or an unknown installation.
 * @param command - Command from a user-scoped hook file.
 * @param env - Coding agent launch environment.
 * @param currentCli - Trusted running CLI, injectable for isolated tests.
 * @param timeoutMs - Maximum version probe duration.
 * @returns A diagnostic without command output or credential values.
 */
export async function checkHookCommand(command: string, env: Env, currentCli = CLI_PATH, timeoutMs = VERSION_TIMEOUT_MS): Promise<Check> {
  const name = 'installed hook command';
  const fail = (detail: string): Check => ({ name, level: 'fail', detail: `${detail}. ${REMEDY}` });

  if (!isAgentWatchHookCommand(command)) return fail('Unrecognized hook command; inspect user hook configuration manually');

  const tokens = tokenizeHookCommand(command)!;
  const prefix = tokens.slice(0, tokens.indexOf('hook'));
  const executable = resolveExecutable(prefix[0]!, env);
  const script = prefix.length === 2 ? prefix[1]! : executable;

  if (!executable || !(await executableFile(executable))) return fail('Missing executable or stale nvm/fnm/asdf path');

  if (!script || !path.isAbsolute(script)) return fail('Hook script no longer resolves to an absolute installation');

  const actual = await fs.realpath(script).catch(() => undefined);
  const expected = await fs.realpath(currentCli).catch(() => undefined);

  if (!actual) return fail('Missing CLI script or stale absolute path');

  // Not a failure on its own: pnpm, yarn, volta and Windows install a wrapper
  // script whose realpath is never dist/cli.js, so a healthy install lands
  // here too. A hook pointing at something unresolvable already failed above.
  if (!expected || actual !== expected) {
    return { name, level: 'warn', detail: `Hook resolves to a different AgentWatch installation than this one; version probe skipped. ${REMEDY}` };
  }

  const runtime = prefix.length === 2 ? executable : findExecutable(env, 'node');

  if (!runtime || !(await executableFile(runtime))) return fail('Missing Node.js runtime on the agent PATH');

  if (prefix.length === 2 && !NODE_NAME.test(path.basename(runtime))) return fail('Unsupported runtime; version probe skipped');

  // Only our verified CLI runs; the original shell command is never executed.
  const ok = await new Promise<boolean>((resolve) => {
    execFile(runtime, [actual, '--version'], {
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 4096,
      cwd: env.home,
      env: { PATH: env.vars['PATH'] ?? '', HOME: env.home }
    }, (error, stdout) => resolve(!error && VERSION_OUTPUT.test(stdout)));
  });

  if (!ok) return fail('Hook --version failed or timed out');

  const versionManaged = VERSION_MANAGER_PATH.test(executable);

  return {
    name,
    level: versionManaged ? 'warn' : 'ok',
    detail: versionManaged
      ? `Resolved, but tied to a version-manager path that may become stale. ${REMEDY}`
      : 'CLI and Node.js resolve; bounded --version passed. Repeat doctor with the GUI agent launch PATH if it differs.'
  };
}

function collectCommands(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectCommands);

  const record = asRecord(value);

  if (!record) return [];

  const command = record['command'];

  if (typeof command === 'string') return isAgentWatchHookCommand(command) ? [command] : [];

  return Object.values(record).flatMap(collectCommands);
}

function resolveExecutable(value: string, env: Env): string | undefined {
  if (path.isAbsolute(value)) return value;

  return findExecutable(env, value);
}

async function executableFile(file: string): Promise<boolean> {
  try {
    await fs.access(file, fs.constants.X_OK);

    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}
