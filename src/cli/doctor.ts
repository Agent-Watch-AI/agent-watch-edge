import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import type { Env } from '../core/env.js';
import { providers } from '../providers/registry.js';
import type { SetupContext } from '../providers/provider.js';
import { eventsUrl, otlpBaseUrl } from '../config/config.js';
import { buildCliContext, buildHookCommand, buildQueue } from './context.js';
import { bold, dim, println, symbols } from './ui.js';

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
        level: otelStatus.configured ? 'ok' : otelStatus.conflict ? 'warn' : 'warn',
        detail: otelStatus.configured ? 'configured' : (otelStatus.conflict ?? otelStatus.detail ?? 'not configured')
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

  // Privacy posture
  const capture = context.config.capture;
  const contentFlags = (['prompts', 'responses', 'toolInput', 'toolOutput'] as const).filter((flag) => capture[flag]);
  checks.push({
    name: 'privacy',
    level: 'ok',
    detail: contentFlags.length === 0 ? 'content capture disabled (metadata only)' : `content capture ENABLED for: ${contentFlags.join(', ')}`
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

function execGitVersion(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('git', ['--version'], { timeout: 2000 }, (error, stdout) => {
      resolve(error ? undefined : stdout.trim());
    });
  });
}
