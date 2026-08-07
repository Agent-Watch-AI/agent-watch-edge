import type { Env } from '../core/env.js';
import { providers } from '../providers/registry.js';
import type { SetupContext } from '../providers/provider.js';
import { collectGitContext } from '../git/git-context.js';
import { eventsUrl } from '../config/config.js';
import { buildCliContext, buildHookCommand, buildQueue, buildTransport } from './context.js';
import { bold, dim, println, symbols } from './ui.js';

export async function runStatus(env: Env): Promise<number> {
  const context = await buildCliContext(env);
  println(bold('AgentWatch Bridge'));
  println();

  println(bold('Backend'));
  if (context.configState === 'invalid') {
    println(`${symbols.fail} config invalid: ${context.configError}`);
  } else if (context.config.endpoint) {
    println(`${symbols.ok} ${context.config.endpoint}`);
  } else {
    println(`${symbols.off} not configured — run \`agentwatch setup\``);
  }
  println();

  println(bold('Repository'));
  const git = await collectGitContext({ cwd: env.cwd, includeChangedFiles: false });
  if (git.repositoryRoot) {
    println(`${symbols.ok} ${git.repository ?? git.repositoryRoot}`);
    if (git.branch) println(dim(`  branch: ${git.branch}`));
  } else {
    println(`${symbols.off} not inside a Git repository`);
  }
  println();

  println(bold('Agents'));
  for (const provider of providers) {
    const detection = await provider.detect(env);
    println();
    println(provider.displayName);
    if (!detection.detected) {
      println(`${symbols.off} not detected`);
      continue;
    }
    println(`${symbols.ok} detected ${dim(`(${detection.evidence[0] ?? ''})`)}`);
    println(detection.hooksInstalled ? `${symbols.ok} hooks installed` : `${symbols.off} hooks not installed`);
    if (provider.nativeTelemetry) {
      const setupContext: SetupContext = {
        env,
        paths: context.paths,
        config: context.config,
        hookCommand: buildHookCommand(env, provider.id),
        installState: context.installState
      };
      const otel = await provider.nativeTelemetry.inspect(setupContext);
      if (otel.configured) println(`${symbols.ok} native OpenTelemetry configured`);
      else if (otel.conflict) println(`${symbols.warn} native OpenTelemetry: ${otel.conflict}`);
      else println(`${symbols.off} native OpenTelemetry not configured`);
    }
  }
  println();

  println(bold('Delivery'));
  const queue = buildQueue(context);
  let pending = await queue.pendingCount();
  if (pending > 0 && eventsUrl(context.config)) {
    // Reasonable moment to retry: we're already out of any agent's critical path.
    const transport = buildTransport(context, 3000);
    if (transport) {
      const drained = await queue.drain(transport, context.config.delivery.drainBatchSize);
      if (drained.sent > 0) println(dim(`  retried: ${drained.sent} event(s) delivered`));
      pending = await queue.pendingCount();
    }
  }
  println(pending === 0 ? `${symbols.ok} healthy` : `${symbols.warn} backlog`);
  println(`${pending} pending event(s)`);
  return 0;
}
