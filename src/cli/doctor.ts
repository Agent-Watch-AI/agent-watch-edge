import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { eventsUrl, otlpBaseUrl } from '../config/config.js';
import { loadEffectiveConfig } from '../config/repo-config.js';
import { CONTENT_CAPTURE_FLAGS } from '../config/constants/config.constants.js';
import type { CaptureConfig } from '../config/types/config.types.js';
import type { Env } from '../core/types/core.types.js';
import { meetsMinVersion, parseVersion } from '../core/version.js';
import { findExecutable } from '../core/which.js';
import { developerIdentity } from '../git/git-context.js';
import { providers } from '../providers/registry.js';
import type { AgentProvider, SetupContext } from '../providers/types/provider.types.js';
import { buildCliContext, buildHookCommand, buildQueue } from './context.js';
import {
  BACKEND_PROBE_TIMEOUT_MS,
  CLAUDE_MIN_VERSION_FOR_PROMPT_ID,
  CLAUDE_VERSION_TIMEOUT_MS,
  DEVELOPER_IDENTITY_CHECK,
  DEVELOPER_IDENTITY_REMEDIES,
  GIT_VERSION_TIMEOUT_MS,
  MIN_NODE_MAJOR,
  NO_DEVELOPER_IDENTITY,
  STALE_QUEUE_AGE_MS
} from './constants/cli.constants.js';
import type { Check, CliContext, DoctorOptions } from './types/cli.types.js';
import { bold, dim, levelSymbol, println } from './ui.js';

/**
 * `agentwatch doctor` — every reason telemetry might not be arriving, in one
 * pass.
 *
 * Each check is independent and self-contained, which is what makes the output
 * useful: a developer reads down the list and the first non-ok line is the thing
 * to fix.
 *
 * @param env - Ambient environment.
 * @param options - Output options and the git runner override.
 * @returns 1 when any check failed, else 0.
 */
export async function runDoctor(env: Env, options: DoctorOptions = {}): Promise<number> {
  const context = await buildCliContext(env);
  const checks: Check[] = [
    nodeVersionCheck(),
    configurationCheck(context),
    ...endpointChecks(context),
    await developerIdentityCheck(env, context, options),
    ...(await connectivityChecks(context)),
    await gitCheck(),
    await buildFreshnessCheck(),
    ...(await agentChecks(env, context)),
    ...(await queueChecks(context)),
    await writableCheck('data directory writable', context.paths.dataDir),
    await writableCheck('config directory writable', context.paths.configDir),
    ...(await repositoryChecks(env, context))
  ];

  if (options.json) {
    println(JSON.stringify({ schemaVersion: 1, checks }, null, 2));

    return exitCode(checks);
  }

  println(bold('AgentWatch Doctor'));
  println();

  for (const check of checks) {
    println(`${levelSymbol(check.level)} ${check.name}${check.detail ? dim(` — ${check.detail}`) : ''}`);
  }

  println();

  return exitCode(checks);
}

/**
 * Whether the runtime is new enough.
 *
 * @returns The check.
 */
function nodeVersionCheck(): Check {
  const major = Number(process.versions.node.split('.')[0]);

  return {
    name: 'Node.js version',
    level: major >= MIN_NODE_MAJOR ? 'ok' : 'fail',
    detail: `v${process.versions.node}${major >= MIN_NODE_MAJOR ? '' : ` (need >= ${MIN_NODE_MAJOR})`}`
  };
}

/**
 * Whether the configuration file is present and readable.
 *
 * @param context - Resolved CLI context.
 * @returns The check.
 */
function configurationCheck(context: CliContext): Check {
  if (context.configState === 'ok') return { name: 'configuration', level: 'ok', detail: context.paths.configFile };

  if (context.configState === 'missing') return { name: 'configuration', level: 'warn', detail: 'not found — run `agentwatch setup`' };

  return { name: 'configuration', level: 'fail', detail: context.configError };
}

/**
 * Whether a backend and a token are configured. Never reveals the token.
 *
 * @param context - Resolved CLI context.
 * @returns The checks.
 */
function endpointChecks(context: CliContext): Check[] {
  return [
    { name: 'backend endpoint', level: context.config.endpoint ? 'ok' : 'warn', detail: context.config.endpoint ?? 'not configured' },
    { name: 'auth token', level: 'ok', detail: context.config.token ? 'present (hidden)' : 'none configured' }
  ];
}

/**
 * Whether anything on this machine can name the developer.
 *
 * `fail`, not `warn`: per-developer enforcement is keyed on this identity, and
 * an unknown one is allowed silently — so a machine that cannot name its
 * developer is a machine that reports healthy while enforcing nothing. A
 * scripted rollout has to be able to fail it instead of shipping it.
 *
 * @param env - Ambient environment.
 * @param context - Resolved CLI context.
 * @param options - Carries the git runner override.
 * @returns The check.
 */
async function developerIdentityCheck(env: Env, context: CliContext, options: DoctorOptions): Promise<Check> {
  const identity = await developerIdentity(context.config.developerEmail, env.cwd, { home: env.home, run: options.gitRun });

  if (!identity) return { name: DEVELOPER_IDENTITY_CHECK, level: 'fail', detail: `${NO_DEVELOPER_IDENTITY}; ${DEVELOPER_IDENTITY_REMEDIES}` };

  return { name: DEVELOPER_IDENTITY_CHECK, level: 'ok', detail: identity };
}

/**
 * Whether the backend answers at all, and where OTLP would go.
 *
 * Any HTTP answer proves reachability: the check is about the network path, not
 * about whether an empty batch is accepted.
 *
 * @param context - Resolved CLI context.
 * @returns The checks.
 */
async function connectivityChecks(context: CliContext): Promise<Check[]> {
  const checks: Check[] = [];
  const url = eventsUrl(context.config);

  if (url) checks.push(await probeBackend(url));

  const otlp = otlpBaseUrl(context.config);

  if (otlp) checks.push({ name: 'OTLP base URL', level: 'ok', detail: otlp });

  return checks;
}

/**
 * Post an empty batch and report what came back.
 *
 * @param url - The events URL.
 * @returns The check.
 */
async function probeBackend(url: string): Promise<Check> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: [] }),
      signal: AbortSignal.timeout(BACKEND_PROBE_TIMEOUT_MS)
    });

    return { name: 'backend connectivity', level: response.ok ? 'ok' : 'warn', detail: `${url} -> HTTP ${response.status}` };
  } catch (error) {
    return { name: 'backend connectivity', level: 'fail', detail: `${url} unreachable (${(error as Error).name})` };
  }
}

/**
 * Whether git is available for enrichment.
 *
 * @returns The check.
 */
async function gitCheck(): Promise<Check> {
  const version = await execVersion('git', ['--version'], GIT_VERSION_TIMEOUT_MS);

  return { name: 'git available', level: version ? 'ok' : 'warn', detail: version?.trim() ?? 'git not found on PATH' };
}

/**
 * Per-agent checks: detected, hooked, and exporting telemetry.
 *
 * @param env - Ambient environment.
 * @param context - Resolved CLI context.
 * @returns The checks, in provider order.
 */
async function agentChecks(env: Env, context: CliContext): Promise<Check[]> {
  const checks: Check[] = [];

  for (const provider of providers) {
    const detection = await provider.detect(env);

    if (!detection.detected) {
      checks.push({ name: provider.displayName, level: 'warn', detail: 'not detected' });
      continue;
    }

    checks.push({ name: `${provider.displayName} detected`, level: 'ok', detail: detection.evidence.join('; ') });
    checks.push(...(await providerCaveats(provider, env)));
    checks.push({
      name: `${provider.displayName} hooks`,
      level: detection.hooksInstalled ? 'ok' : 'warn',
      detail: detection.hooksInstalled ? detection.hookConfigPath : 'not installed — run `agentwatch setup`'
    });

    if (provider.nativeTelemetry) checks.push(await otelCheck(provider, env, context));
  }

  return checks;
}

/**
 * Known limitations of one agent, reported as warnings.
 *
 * These are not misconfigurations the developer can fix; they exist so an
 * absent number is explained rather than mistaken for a bug in the edge.
 *
 * @param provider - The agent's provider.
 * @param env - Ambient environment.
 * @returns The checks, empty for agents with no caveats.
 */
async function providerCaveats(provider: AgentProvider, env: Env): Promise<Check[]> {
  if (provider.id === 'claude') return [await claudeVersionCheck(env)];

  if (provider.id !== 'cursor') return [];

  return [
    {
      name: 'Cursor token usage',
      level: 'warn',
      detail: 'Cursor transcripts carry no token usage yet — Cursor turn summaries stay usage_status=pending until Cursor enriches them'
    },
    {
      name: 'Cursor CLI hooks',
      level: 'warn',
      detail: 'cursor-agent (CLI) currently emits only shell hook events (known Cursor issue); IDE sessions are fully covered'
    }
  ];
}

/**
 * Whether Claude Code is new enough for prompt-id turn correlation.
 *
 * @param env - Ambient environment.
 * @returns The check.
 */
async function claudeVersionCheck(env: Env): Promise<Check> {
  const name = 'Claude Code version';
  const bin = findExecutable(env, 'claude');

  if (!bin) {
    return { name, level: 'warn', detail: `claude not on PATH; cannot verify >= ${CLAUDE_MIN_VERSION_FOR_PROMPT_ID} (needed for turn correlation)` };
  }

  const output = await execVersion(bin, ['--version'], CLAUDE_VERSION_TIMEOUT_MS);
  const version = output ? parseVersion(output) : undefined;

  if (!version) {
    return { name, level: 'warn', detail: `could not determine version (need >= ${CLAUDE_MIN_VERSION_FOR_PROMPT_ID} for turn correlation)` };
  }

  if (meetsMinVersion(version, CLAUDE_MIN_VERSION_FOR_PROMPT_ID)) return { name, level: 'ok', detail: version };

  return {
    name,
    level: 'warn',
    detail: `${version} — prompt_id turn correlation needs >= ${CLAUDE_MIN_VERSION_FOR_PROMPT_ID}; turn_id will be empty`
  };
}

/**
 * Whether one agent's native telemetry is configured.
 *
 * This one is `fail` rather than `warn`: without it there is no llm.call ledger
 * at all, so every turn's cost would be missing.
 *
 * @param provider - The agent's provider.
 * @param env - Ambient environment.
 * @param context - Resolved CLI context.
 * @returns The check.
 */
async function otelCheck(provider: AgentProvider, env: Env, context: CliContext): Promise<Check> {
  const setupContext: SetupContext = {
    env,
    paths: context.paths,
    config: context.config,
    hookCommand: buildHookCommand(env, provider.id),
    installState: context.installState
  };
  const status = await provider.nativeTelemetry!.inspect(setupContext);

  return {
    name: `${provider.displayName} native OpenTelemetry`,
    level: status.configured ? 'ok' : 'fail',
    detail: status.configured
      ? (status.detail ?? 'configured (llm.call ledger enabled)')
      : (status.conflict ?? status.detail ?? 'not configured — llm.call records would be lost')
  };
}

/**
 * Whether the offline queue is healthy.
 *
 * @param context - Resolved CLI context.
 * @returns The check.
 */
async function queueChecks(context: CliContext): Promise<Check[]> {
  const queue = buildQueue(context);
  const pending = await queue.pendingCount();
  const oldest = await queue.oldestPendingAgeMs();
  const stale = pending > 0 && oldest !== undefined && oldest > STALE_QUEUE_AGE_MS;

  return [
    {
      name: 'delivery queue',
      level: stale ? 'warn' : 'ok',
      detail: `${pending} pending${oldest !== undefined ? `, oldest ${Math.round(oldest / 60000)} min` : ''}`
    }
  ];
}

/**
 * Repository overrides for this directory, and the resulting privacy posture.
 *
 * The posture is reported from the EFFECTIVE config so it matches what hooks
 * actually do here, not what the global file says.
 *
 * @param env - Ambient environment.
 * @param context - Resolved CLI context.
 * @returns The checks.
 */
async function repositoryChecks(env: Env, context: CliContext): Promise<Check[]> {
  const checks: Check[] = [];
  let capture: CaptureConfig = context.config.capture;

  try {
    const effective = await loadEffectiveConfig(context.paths, env.cwd);

    capture = effective.config.capture;

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

  const enabled = CONTENT_CAPTURE_FLAGS.filter((flag) => capture[flag]);

  checks.push({
    name: 'privacy',
    level: 'ok',
    detail:
      enabled.length === 0
        ? 'content capture disabled (metadata only)'
        : `content capture ENABLED for: ${enabled.join(', ')} (effective for this directory)`
  });

  return checks;
}

/**
 * Whether a directory can actually be written to.
 *
 * @param name - Check name.
 * @param dir - Directory to probe.
 * @returns The check.
 */
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

/**
 * Whether the running build matches the sources beside it.
 *
 * Only meaningful for a checkout linked with `npm link` or run from `dist`
 * directly — a published install has no `src` and is skipped. It exists because
 * a stale `dist` is invisible from the outside and looks exactly like a broken
 * agent: a provider added to the registry but never rebuilt made every hook
 * answer `unknown agent`, for days, while the agent dutifully called it on every
 * tool use.
 *
 * @returns The check.
 */
async function buildFreshnessCheck(): Promise<Check> {
  const name = 'build up to date';
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const [srcTime, distTime] = await Promise.all([newestMtime(path.join(root, 'src')), newestMtime(path.join(root, 'dist'))]);

  if (srcTime === undefined || distTime === undefined) {
    return { name, level: 'ok', detail: 'published install (no sources to compare)' };
  }

  if (srcTime <= distTime) return { name, level: 'ok', detail: 'dist is newer than src' };

  return { name, level: 'warn', detail: 'src is newer than dist — run `npm run build`; the installed CLI is running stale code' };
}

/**
 * Newest mtime anywhere under a directory.
 *
 * @param dir - Directory to walk.
 * @returns Epoch milliseconds, or undefined when the directory does not exist.
 */
async function newestMtime(dir: string): Promise<number | undefined> {
  let newest: number | undefined;

  const walk = async (current: string): Promise<void> => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);

      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }

      const stat = await fs.stat(full);

      if (newest === undefined || stat.mtimeMs > newest) newest = stat.mtimeMs;
    }
  };

  try {
    await walk(dir);
  } catch {
    return undefined;
  }

  return newest;
}

/**
 * Run a `--version`-style command, treating any failure as no answer.
 *
 * @param command - Executable.
 * @param args - Its arguments.
 * @param timeoutMs - Kill budget.
 * @returns Its stdout, or undefined.
 */
function execVersion(command: string, args: readonly string[], timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(command, [...args], { timeout: timeoutMs }, (error, stdout) => resolve(error ? undefined : stdout));
  });
}

/**
 * The process exit code for a set of checks.
 *
 * @param checks - Everything that was checked.
 * @returns 1 when anything failed, else 0.
 */
function exitCode(checks: readonly Check[]): number {
  return checks.some((check) => check.level === 'fail') ? 1 : 0;
}
