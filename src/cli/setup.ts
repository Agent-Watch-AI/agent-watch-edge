import process from 'node:process';
import readline from 'node:readline/promises';
import { defaultConfig, enabledSignalNames, eventsUrl, parseOtelSignals } from '../config/config.js';
import { ensureInstallationId, saveConfig } from '../config/config-store.js';
import type { AgentWatchConfig, OtelConfig } from '../config/types/config.types.js';
import { collectGitContext, developerIdentity } from '../git/git-context.js';
import { ManualEnrollmentProvider } from '../enrollment/manual-enrollment.js';
import type { EnrollmentResult } from '../enrollment/types/enrollment.types.js';
import { providers } from '../providers/registry.js';
import type { AgentProvider, DetectionResult, SetupContext, SetupOutcome } from '../providers/types/provider.types.js';
import { saveInstallState } from '../storage/install-state.js';
import type { InstallState } from '../storage/types/storage.types.js';
import { buildCliContext, buildHookCommand, buildQueue } from './context.js';
import { DEVELOPER_EMAIL_PROMPT, DEVELOPER_IDENTITY_REMEDIES, NO_CONFIG_WRITTEN, NO_DEVELOPER_IDENTITY } from './constants/cli.constants.js';
import type { CliContext, SetupOptions } from './types/cli.types.js';
import { bold, dim, printErrln, println, symbols } from './ui.js';

export type { SetupOptions } from './types/cli.types.js';

/** One detected agent. */
interface Detected {
  readonly provider: AgentProvider;
  readonly detection: DetectionResult;
}

/**
 * `agentwatch setup` — configure the backend, then register hooks and native
 * telemetry in every detected agent.
 *
 * Ordered so nothing is written until everything that can be validated has
 * been: a `--otel` typo, an unparseable existing config or a missing endpoint
 * fails the run before the first file is touched.
 *
 * @param options - Environment, flags and the interactive prompt.
 * @returns 0 when every step succeeded, else 1.
 */
export async function runSetup(options: SetupOptions): Promise<number> {
  const context = await buildCliContext(options.env);

  println(bold('AgentWatch Setup'));
  println();

  if (context.configState === 'invalid') {
    println(`${symbols.fail} existing config at ${context.paths.configFile} is invalid: ${context.configError}`);
    println('  fix or delete it, then re-run setup');

    return 1;
  }

  // A fresh install starts from the real defaults (full capture), not the
  // fail-safe metadata-only fallback the hook runtime uses.
  const baseConfig = context.configState === 'missing' ? defaultConfig() : context.config;
  const otel = resolveOtel(baseConfig, options.otel);

  if (!otel) {
    println(`${symbols.fail} invalid --otel value "${options.otel}" (expected "all", "none" or a comma list of logs,traces,metrics)`);

    return 1;
  }

  reportRepository(await collectGitContext({ cwd: options.env.cwd, includeChangedFiles: false }));
  println();

  const detected = await reportDetection(options);

  if (detected.length === 0) {
    println('No supported agents found. Install Claude Code or Codex and re-run `agentwatch setup`.');

    return 1;
  }

  const ask = interactivePrompt(options);
  const enrolled = await enroll(options, baseConfig, ask);

  if ('error' in enrolled) {
    println(`${symbols.fail} ${enrolled.error}`);

    return 1;
  }

  const developerEmail = await resolveDeveloperEmail(options, baseConfig, ask);

  if (!developerEmail) {
    reportMissingIdentity();

    return 1;
  }

  const config = ensureInstallationId({
    ...baseConfig,
    endpoint: enrolled.endpoint,
    token: enrolled.token,
    developerEmail,
    otel,
    emit: { ...baseConfig.emit, llmCalls: true }
  });

  await saveConfig(context.paths, config);
  await offerBacklogRetarget(context, baseConfig, config, ask);

  println(`${symbols.ok} backend: ${config.endpoint}`);
  println(`${symbols.ok} developer: ${developerEmail}`);
  println(`${symbols.ok} otel signals: ${enabledSignalNames(otel).join(', ') || 'none'}`);
  println(dim(`  config: ${context.paths.configFile}`));
  println();

  const failures = await installAgents(options, context, config, detected);

  println(failures === 0 ? `${symbols.ok} setup complete` : `${symbols.warn} setup finished with ${failures} skipped step(s) — see above`);
  println(dim('  run `agentwatch status` anytime, `agentwatch doctor` to diagnose'));

  return failures === 0 ? 0 : 1;
}

/**
 * The OTLP signal selection for this run.
 *
 * Validated before any prompt or file write: a typo must fail the whole run
 * rather than silently configure the wrong signals.
 *
 * @param baseConfig - Config the run starts from.
 * @param flag - Raw `--otel` value, when given.
 * @returns The selection, or undefined when the flag is invalid.
 */
function resolveOtel(baseConfig: AgentWatchConfig, flag: string | undefined): OtelConfig | undefined {
  if (flag === undefined) return baseConfig.otel;

  return parseOtelSignals(flag);
}

/**
 * Print the repository context. Informational; never fails the run.
 *
 * @param git - Collected git context.
 */
function reportRepository(git: Awaited<ReturnType<typeof collectGitContext>>): void {
  if (!git.repositoryRoot) {
    println(`${symbols.off} no Git repository detected here (that's fine)`);

    return;
  }

  println(`${symbols.ok} repository: ${git.repository ?? git.repositoryRoot}${git.branch ? dim(`  (branch: ${git.branch})`) : ''}`);
}

/**
 * Detect every supported agent and report what was found.
 *
 * @param options - Environment.
 * @returns The agents that were detected.
 */
async function reportDetection(options: SetupOptions): Promise<Detected[]> {
  println(bold('Detected coding agents:'));

  const results = await Promise.all(providers.map(async (provider) => ({ provider, detection: await provider.detect(options.env) })));

  for (const { provider, detection } of results) {
    println(detection.detected ? `${symbols.ok} ${provider.displayName}` : `${symbols.off} ${provider.displayName} not detected`);
  }

  println();

  return results.filter(({ detection }) => detection.detected);
}

/**
 * Acquire the backend endpoint and token.
 *
 * @param options - Flags and the interactive prompt.
 * @param baseConfig - Config the run starts from.
 * @param ask - The prompt, when the run is interactive.
 * @returns The enrollment result, or the message to show.
 */
async function enroll(
  options: SetupOptions,
  baseConfig: AgentWatchConfig,
  ask: ((question: string) => Promise<string>) | undefined
): Promise<EnrollmentResult | { error: string }> {
  try {
    return await new ManualEnrollmentProvider().enroll({
      setupUrl: options.setupUrl,
      endpoint: options.endpoint ?? baseConfig.endpoint,
      token: options.token ?? baseConfig.token,
      ask
    });
  } catch (error) {
    return { error: (error as Error).message };
  }
}

/**
 * The developer identity this install will be attributed to.
 *
 * Resolution runs through `developerIdentity()` — the same function the hook
 * path and the pre-turn budget check use — so what setup writes is exactly what
 * the gate will later ask the platform about. The flag is the only override,
 * for a machine whose git identity is someone else's.
 *
 * Nothing is asked when the identity is already known: the prompt exists for
 * the machine that has no answer, not to re-confirm one we already trust.
 *
 * @param options - Flags, environment and the git runner override.
 * @param baseConfig - Config the run starts from.
 * @param ask - The prompt, when the run is interactive.
 * @returns The identity, or undefined when nothing names the developer.
 */
export async function resolveDeveloperEmail(
  options: SetupOptions,
  baseConfig: AgentWatchConfig,
  ask: ((question: string) => Promise<string>) | undefined
): Promise<string | undefined> {
  const flag = options.developerEmail?.trim();

  if (flag) return flag;

  const detected = await developerIdentity(baseConfig.developerEmail, options.env.cwd, { home: options.env.home, run: options.gitRun });

  if (detected) return detected;

  if (!ask) return undefined;

  return (await ask(DEVELOPER_EMAIL_PROMPT)).trim() || undefined;
}

/**
 * Refuse the install, naming both ways to fix it.
 *
 * An install nobody can be attributed to reports success while enforcing
 * nothing: every per-developer decision is keyed on this identity, and an
 * unknown one is allowed silently. Better a loud non-zero exit here than a
 * customer who believes they are covered.
 */
function reportMissingIdentity(): void {
  printErrln(`${symbols.fail} ${NO_DEVELOPER_IDENTITY}`);
  printErrln(`  ${DEVELOPER_IDENTITY_REMEDIES}`);
  printErrln(`  ${NO_CONFIG_WRITTEN}`);
}

/**
 * Offer to re-route a backlog queued for a previous backend.
 *
 * Backlog queued for the previous backend must not silently expire pinned to a
 * URL nothing will ever drain — but moving captured content to a *different*
 * backend is a routing decision only the user can make, because the previous URL
 * may belong to another organization. So: ask, never assume.
 *
 * @param context - Resolved CLI context.
 * @param previousConfig - Config before this run.
 * @param config - Config this run just wrote.
 * @param ask - The prompt, when the run is interactive.
 */
async function offerBacklogRetarget(
  context: CliContext,
  previousConfig: AgentWatchConfig,
  config: AgentWatchConfig,
  ask: ((question: string) => Promise<string>) | undefined
): Promise<void> {
  const previousUrl = eventsUrl(previousConfig);
  const configuredUrl = eventsUrl(config);

  if (!previousUrl || !configuredUrl || previousUrl === configuredUrl) return;

  const queue = buildQueue({ ...context, config });
  const stranded = await queue.pendingFor(previousUrl);

  if (stranded === 0) return;

  const answer = ask
    ? (await ask(`${stranded} offline event(s) are queued for the previous backend (${previousUrl}). Deliver them to the new backend? [y/N]: `)).trim().toLowerCase()
    : '';

  if (answer !== 'y' && answer !== 'yes') {
    println(`${symbols.warn} keeping ${stranded} offline event(s) pinned to the previous backend; they expire after ${config.delivery.maxEventAgeDays} day(s)`);

    return;
  }

  const retargeted = await queue.retarget(configuredUrl, previousUrl);

  println(retargeted ? `${symbols.ok} offline backlog re-routed to the new backend` : `${symbols.warn} queue busy; backlog not re-routed — re-run setup to retry`);
}

/**
 * Register hooks and native telemetry in every detected agent.
 *
 * Install state is threaded from one operation to the next and persisted once at
 * the end, so a failure part-way through cannot leave a record claiming
 * something was installed that was not.
 *
 * @param options - Environment and the hook-command override.
 * @param context - Resolved CLI context.
 * @param config - The configuration just written.
 * @param detected - Agents to install into.
 * @returns How many steps were skipped or failed.
 */
async function installAgents(options: SetupOptions, context: CliContext, config: AgentWatchConfig, detected: readonly Detected[]): Promise<number> {
  let installState = context.installState;
  let failures = 0;

  for (const { provider } of detected) {
    println(bold(provider.displayName));

    const setupContext: SetupContext = {
      env: options.env,
      paths: context.paths,
      config,
      hookCommand: (options.hookCommandFor ?? ((id: string) => buildHookCommand(options.env, id)))(provider.id),
      installState
    };
    const hooks = await provider.installHooks(setupContext);

    installState = printOutcome(hooks, installState);

    if (!hooks.ok) failures++;

    if (provider.nativeTelemetry && (await provider.nativeTelemetry.supported(options.env))) {
      const otel = await provider.nativeTelemetry.configure({ ...setupContext, installState });

      installState = printOutcome(otel, installState);

      if (!otel.ok) failures++;
    }

    println();
  }

  await saveInstallState(context.paths, installState);

  return failures;
}

/**
 * Print an outcome and carry its install state forward.
 *
 * @param outcome - What the operation reported.
 * @param current - Install state before it ran.
 * @returns The install state to pass to the next operation.
 */
function printOutcome(outcome: SetupOutcome, current: InstallState): InstallState {
  for (const message of outcome.messages) {
    println(`${outcome.ok ? symbols.ok : symbols.warn} ${message}`);
  }

  return outcome.installState ?? current;
}

/**
 * The prompt this run may use, if any.
 *
 * `--yes` wins over an injected prompt as well as over the terminal: the
 * command a developer copies out of the product carries it, and that command
 * has to run to completion on a machine where nobody is typing.
 *
 * @param options - Flags and the injected prompt.
 * @returns The prompt, or undefined when the run must not block on input.
 */
function interactivePrompt(options: SetupOptions): ((question: string) => Promise<string>) | undefined {
  if (options.yes) return undefined;

  return options.ask ?? defaultAsk();
}

/**
 * The terminal prompt, when there is a terminal.
 *
 * @returns The prompt, or undefined when stdin is not a TTY.
 */
function defaultAsk(): ((question: string) => Promise<string>) | undefined {
  if (!process.stdin.isTTY) return undefined;

  return async (question: string) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  };
}
