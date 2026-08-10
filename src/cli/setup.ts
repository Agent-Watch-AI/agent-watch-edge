import readline from 'node:readline/promises';
import process from 'node:process';
import type { Env } from '../core/env.js';
import { providers } from '../providers/registry.js';
import type { SetupContext } from '../providers/provider.js';
import { ManualEnrollmentProvider } from '../enrollment/manual-enrollment.js';
import { ensureInstallationId, saveConfig } from '../config/config-store.js';
import { defaultConfig, enabledSignalNames, eventsUrl, parseOtelSignals } from '../config/config.js';
import { saveInstallState } from '../storage/install-state.js';
import { collectGitContext, gitUserEmail } from '../git/git-context.js';
import { buildCliContext, buildHookCommand, buildQueue } from './context.js';
import { bold, dim, println, symbols } from './ui.js';

export interface SetupOptions {
  env: Env;
  setupUrl?: string;
  endpoint?: string;
  token?: string;
  /** Developer identity for turn summaries; falls back to `git config user.email`. */
  developerEmail?: string;
  /** OTLP signal selection: "all", "none" or comma list of logs,traces,metrics. */
  otel?: string;
  /** Non-interactive: fail instead of prompting. */
  yes?: boolean;
  ask?: (question: string) => Promise<string>;
  hookCommandFor?: (providerId: string) => string;
}

export async function runSetup(options: SetupOptions): Promise<number> {
  const context = await buildCliContext(options.env);
  println(bold('AgentWatch Setup'));
  println();

  if (context.configState === 'invalid') {
    println(`${symbols.fail} existing config at ${context.paths.configFile} is invalid: ${context.configError}`);
    println('  fix or delete it, then re-run setup');
    return 1;
  }
  if (context.configState === 'missing') {
    // Fresh install: start from the real defaults (full capture), not the
    // fail-safe metadata-only fallback the hook runtime uses.
    context.config = defaultConfig();
  }

  // Validate before any prompt or file write: a typo must fail the whole run.
  let otel = context.config.otel;
  if (options.otel !== undefined) {
    const parsedOtel = parseOtelSignals(options.otel);
    if (!parsedOtel) {
      println(`${symbols.fail} invalid --otel value "${options.otel}" (expected "all", "none" or a comma list of logs,traces,metrics)`);
      return 1;
    }
    otel = parsedOtel;
  }

  // Step 1 — repository context (informational; never fails).
  const git = await collectGitContext({ cwd: options.env.cwd, includeChangedFiles: false });
  if (git.repositoryRoot) {
    println(`${symbols.ok} repository: ${git.repository ?? git.repositoryRoot}${git.branch ? dim(`  (branch: ${git.branch})`) : ''}`);
  } else {
    println(`${symbols.off} no Git repository detected here (that's fine)`);
  }
  println();

  // Step 2 — agent detection.
  println(bold('Detected coding agents:'));
  const detections = await Promise.all(providers.map(async (provider) => ({ provider, detection: await provider.detect(options.env) })));
  for (const { provider, detection } of detections) {
    println(detection.detected ? `${symbols.ok} ${provider.displayName}` : `${symbols.off} ${provider.displayName} not detected`);
  }
  const detected = detections.filter(({ detection }) => detection.detected);
  println();
  if (detected.length === 0) {
    println('No supported agents found. Install Claude Code or Codex and re-run `agentwatch setup`.');
    return 1;
  }

  // Step 3 — endpoint configuration (behind the enrollment abstraction).
  const ask = options.ask ?? defaultAsk(options.yes ?? false);
  const enrollment = new ManualEnrollmentProvider();
  let enrolled;
  try {
    enrolled = await enrollment.enroll({
      setupUrl: options.setupUrl,
      endpoint: options.endpoint ?? context.config.endpoint,
      token: options.token ?? context.config.token,
      ask
    });
  } catch (error) {
    println(`${symbols.fail} ${(error as Error).message}`);
    return 1;
  }

  // Developer identity for turn summaries: flag > existing config > git; the
  // interactive prompt only confirms/overrides the detected default.
  let developerEmail = options.developerEmail ?? context.config.developerEmail ?? (await gitUserEmail(options.env.cwd, { home: options.env.home }));
  if (!options.developerEmail && !context.config.developerEmail && ask) {
    const answer = (await ask(`Developer email${developerEmail ? ` [${developerEmail}]` : ''}: `)).trim();
    if (answer) developerEmail = answer;
  }

  const config = ensureInstallationId({
    ...context.config,
    endpoint: enrolled.endpoint,
    token: enrolled.token,
    developerEmail,
    otel,
    emit: { ...context.config.emit, llmCalls: true }
  });
  await saveConfig(context.paths, config);
  // Backlog queued for the previous backend must not silently expire pinned
  // to a URL nothing will ever drain again — but moving captured content to a
  // different backend is a routing decision only the user can make (the
  // previous URL may belong to another organization). Ask; never assume.
  const previousEventsUrl = eventsUrl(context.config);
  const configuredEventsUrl = eventsUrl(config);
  if (previousEventsUrl && configuredEventsUrl && previousEventsUrl !== configuredEventsUrl) {
    const queue = buildQueue({ ...context, config });
    const stranded = await queue.pendingFor(previousEventsUrl);
    if (stranded > 0) {
      const answer = ask ? (await ask(`${stranded} offline event(s) are queued for the previous backend (${previousEventsUrl}). Deliver them to the new backend? [y/N]: `)).trim().toLowerCase() : '';
      if (answer === 'y' || answer === 'yes') {
        const retargeted = await queue.retarget(configuredEventsUrl, previousEventsUrl);
        println(retargeted ? `${symbols.ok} offline backlog re-routed to the new backend` : `${symbols.warn} queue busy; backlog not re-routed — re-run setup to retry`);
      } else {
        println(`${symbols.warn} keeping ${stranded} offline event(s) pinned to the previous backend; they expire after ${config.delivery.maxEventAgeDays} day(s)`);
      }
    }
  }
  println(`${symbols.ok} backend: ${enrolled.endpoint}`);
  if (developerEmail) println(`${symbols.ok} developer: ${developerEmail}`);
  println(`${symbols.ok} otel signals: ${enabledSignalNames(otel).join(', ') || 'none'}`);
  println(dim(`  config: ${context.paths.configFile}`));
  println();

  // Steps 4+5 — hooks and native OpenTelemetry per detected agent.
  let failures = 0;
  for (const { provider } of detected) {
    println(bold(provider.displayName));
    const setupContext: SetupContext = {
      env: options.env,
      paths: context.paths,
      config,
      hookCommand: (options.hookCommandFor ?? ((id: string) => buildHookCommand(options.env, id)))(provider.id),
      installState: context.installState
    };
    const hooks = await provider.installHooks(setupContext);
    printOutcome(hooks.ok, hooks.messages);
    if (!hooks.ok) failures++;

    if (provider.nativeTelemetry && (await provider.nativeTelemetry.supported(options.env))) {
      const otel = await provider.nativeTelemetry.configure(setupContext);
      printOutcome(otel.ok, otel.messages);
      if (!otel.ok) failures++;
    }
    println();
  }
  await saveInstallState(context.paths, context.installState);

  println(failures === 0 ? `${symbols.ok} setup complete` : `${symbols.warn} setup finished with ${failures} skipped step(s) — see above`);
  println(dim('  run `agentwatch status` anytime, `agentwatch doctor` to diagnose'));
  return failures === 0 ? 0 : 1;
}

function printOutcome(ok: boolean, messages: string[]): void {
  for (const message of messages) {
    println(`${ok ? symbols.ok : symbols.warn} ${message}`);
  }
}

function defaultAsk(nonInteractive: boolean): ((question: string) => Promise<string>) | undefined {
  if (nonInteractive || !process.stdin.isTTY) return undefined;
  return async (question: string) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  };
}
