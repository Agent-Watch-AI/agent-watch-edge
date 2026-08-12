import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import type { Env } from '../core/env.js';
import { providers } from '../providers/registry.js';
import type { SetupContext } from '../providers/provider.js';
import { eventsUrl, otlpBaseUrl } from '../config/config.js';
import { loadEffectiveConfig } from '../config/repo-config.js';
import { findExecutable } from '../core/which.js';
import { parseVersion, meetsMinVersion } from '../core/version.js';
import { buildCliContext, buildHookCommand, buildQueue } from './context.js';
import { bold, dim, println, symbols } from './ui.js';

/** prompt_id (== OTel prompt.id) appeared in this Claude Code release; older
 *  versions fall back to session-scoped turn tracking with empty turn_id. */
const CLAUDE_MIN_VERSION_FOR_PROMPT_ID = '2.1.196';

type Level = 'ok' | 'warn' | 'fail';

interface Check {
  name: string;
  level: Level;
  detail?: string;
}

export async function runDoctor(env: Env, options: { json?: boolean } = {}): Promise<number> {
  const checks: Check[] = [];
  const context = await buildCliContext(env);

  // Runtime
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push({
    name: 'Node.js version',
    level: nodeMajor >= 20 ? 'ok' : 'fail',
    detail: `v${process.versions.node}${nodeMajor >= 20 ? '' : ' (need >= 20)'}`
  });

  // Configuration (never reveal the token)
  if (context.configState === 'ok') {
    checks.push({ name: 'configuration', level: 'ok', detail: context.paths.configFile });
  } else if (context.configState === 'missing') {
    checks.push({ name: 'configuration', level: 'warn', detail: 'not found — run `agentwatch setup`' });
  } else {
    checks.push({ name: 'configuration', level: 'fail', detail: context.configError });
  }
  checks.push({
    name: 'backend endpoint',
    level: context.config.endpoint ? 'ok' : 'warn',
    detail: context.config.endpoint ?? 'not configured'
  });
  checks.push({
    name: 'auth token',
    level: 'ok',
    detail: context.config.token ? 'present (hidden)' : 'none configured'
  });

  // Backend connectivity: any HTTP answer proves reachability.
  const url = eventsUrl(context.config);
  if (url) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ events: [] }),
        signal: AbortSignal.timeout(4000)
      });
      checks.push({
        name: 'backend connectivity',
        level: response.ok ? 'ok' : 'warn',
        detail: `${url} -> HTTP ${response.status}`
      });
    } catch (error) {
      checks.push({ name: 'backend connectivity', level: 'fail', detail: `${url} unreachable (${(error as Error).name})` });
    }
  }
  const otlp = otlpBaseUrl(context.config);
  if (otlp) checks.push({ name: 'OTLP base URL', level: 'ok', detail: otlp });

  // Git availability
  const gitVersion = await execGitVersion();
  checks.push({ name: 'git available', level: gitVersion ? 'ok' : 'warn', detail: gitVersion ?? 'git not found on PATH' });

  // Agents
  for (const provider of providers) {
    const detection = await provider.detect(env);
    if (!detection.detected) {
      checks.push({ name: `${provider.displayName}`, level: 'warn', detail: 'not detected' });
      continue;
    }
    checks.push({ name: `${provider.displayName} detected`, level: 'ok', detail: detection.evidence.join('; ') });
    if (provider.id === 'claude') {
      checks.push(await claudeVersionCheck(env));
    }
    if (provider.id === 'cursor') {
      checks.push({
        name: 'Cursor token usage',
        level: 'warn',
        detail: 'Cursor transcripts carry no token usage yet — Cursor turn summaries stay usage_status=pending until Cursor enriches them'
      });
      checks.push({
        name: 'Cursor CLI hooks',
        level: 'warn',
        detail: 'cursor-agent (CLI) currently emits only shell hook events (known Cursor issue); IDE sessions are fully covered'
      });
    }
    checks.push({
      name: `${provider.displayName} hooks`,
      level: detection.hooksInstalled ? 'ok' : 'warn',
      detail: detection.hooksInstalled ? detection.hookConfigPath : 'not installed — run `agentwatch setup`'
    });
    if (provider.nativeTelemetry) {
      const setupContext: SetupContext = {
        env,
        paths: context.paths,
        config: context.config,
        hookCommand: buildHookCommand(env, provider.id),
        installState: context.installState
      };
      const otelStatus = await provider.nativeTelemetry.inspect(setupContext);
      checks.push({
        name: `${provider.displayName} native OpenTelemetry`,
        level: otelStatus.configured ? 'ok' : 'fail',
        detail: otelStatus.configured
          ? (otelStatus.detail ?? 'configured (llm.call ledger enabled)')
          : (otelStatus.conflict ?? otelStatus.detail ?? 'not configured — llm.call records would be lost')
      });
    }
  }

  // Queue state & write permissions
  const queue = buildQueue(context);
  const pending = await queue.pendingCount();
  const oldest = await queue.oldestPendingAgeMs();
  checks.push({
    name: 'delivery queue',
    level: pending === 0 ? 'ok' : oldest !== undefined && oldest > 24 * 3600 * 1000 ? 'warn' : 'ok',
    detail: `${pending} pending${oldest !== undefined ? `, oldest ${Math.round(oldest / 60000)} min` : ''}`
  });
  checks.push(await writableCheck('data directory writable', context.paths.dataDir));
  checks.push(await writableCheck('config directory writable', context.paths.configDir));

  // Repository overrides for the current directory; privacy posture is
  // reported from the EFFECTIVE config so it matches what hooks actually do
  // here.
  let effectiveCapture = context.config.capture;
  try {
    const effective = await loadEffectiveConfig(context.paths, env.cwd);
    effectiveCapture = effective.config.capture;
    if (effective.repoConfigFile) {
      checks.push({
        name: 'repo config',
        level: effective.warnings.length > 0 ? 'warn' : 'ok',
        detail: effective.warnings.length > 0 ? `${effective.repoConfigFile}: ${effective.warnings.join('; ')}` : effective.repoConfigFile
      });
    }
  } catch {
    // Repo overrides are best-effort; their absence is not a finding.
  }

  const contentFlags = (['prompts', 'responses', 'toolInput', 'toolOutput'] as const).filter((flag) => effectiveCapture[flag]);
  checks.push({
    name: 'privacy',
    level: 'ok',
    detail: contentFlags.length === 0 ? 'content capture disabled (metadata only)' : `content capture ENABLED for: ${contentFlags.join(', ')} (effective for this directory)`
  });

  if (options.json) {
    println(JSON.stringify({ schemaVersion: 1, checks }, null, 2));
  } else {
    println(bold('AgentWatch Doctor'));
    println();
    for (const check of checks) {
      const symbol = check.level === 'ok' ? symbols.ok : check.level === 'warn' ? symbols.warn : symbols.fail;
      println(`${symbol} ${check.name}${check.detail ? dim(` — ${check.detail}`) : ''}`);
    }
    println();
  }
  return checks.some((check) => check.level === 'fail') ? 1 : 0;
}

async function writableCheck(name: string, dir: string): Promise<Check> {
  try {
    await fs.mkdir(dir, { recursive: true });
    const probe = path.join(dir, `.probe-${process.pid}`);
    await fs.writeFile(probe, 'ok');
    await fs.rm(probe, { force: true });
    return { name, level: 'ok', detail: dir };
  } catch (error) {
    return { name, level: 'fail', detail: `${dir}: ${(error as Error).message}` };
  }
}

async function claudeVersionCheck(env: Env): Promise<Check> {
  const name = 'Claude Code version';
  const bin = findExecutable(env, 'claude');
  if (!bin) return { name, level: 'warn', detail: `claude not on PATH; cannot verify >= ${CLAUDE_MIN_VERSION_FOR_PROMPT_ID} (needed for turn correlation)` };
  const output = await new Promise<string | undefined>((resolve) => {
    execFile(bin, ['--version'], { timeout: 5000 }, (error, stdout) => resolve(error ? undefined : stdout));
  });
  const version = output ? parseVersion(output) : undefined;
  if (!version) return { name, level: 'warn', detail: `could not determine version (need >= ${CLAUDE_MIN_VERSION_FOR_PROMPT_ID} for turn correlation)` };
  const ok = meetsMinVersion(version, CLAUDE_MIN_VERSION_FOR_PROMPT_ID);
  return {
    name,
    level: ok ? 'ok' : 'warn',
    detail: ok ? version : `${version} — prompt_id turn correlation needs >= ${CLAUDE_MIN_VERSION_FOR_PROMPT_ID}; turn_id will be empty`
  };
}

function execGitVersion(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('git', ['--version'], { timeout: 2000 }, (error, stdout) => {
      resolve(error ? undefined : stdout.trim());
    });
  });
}
