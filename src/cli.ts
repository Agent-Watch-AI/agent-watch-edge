#!/usr/bin/env node
import process from 'node:process';
import { realEnv } from './core/env.js';
import { setVerbose } from './core/logger.js';
// Parsing lives in its own module so tests can import it without executing
// main(); command modules stay lazily loaded off the hook critical path.
import { boolFlag, parseArgs, stringFlag } from './cli/args.js';
import type { ParsedArgs } from './cli/types/cli.types.js';

const HELP = `agentwatch — telemetry edge for AI coding agents

Usage:
  agentwatch setup [enrollment-url] [--endpoint <url>] [--token <token>] [--developer-email <email>] [--root <path>] [--otel <signals>] [--yes]
  agentwatch status
  agentwatch doctor [--json]
  agentwatch uninstall [--agent <id>] [--purge]
  agentwatch hook --agent <id> [--dry-run]     (invoked by agents; reads stdin)
  agentwatch agents
  agentwatch config
  agentwatch otel-headers

Flags:
  --endpoint <url>          backend base URL events are sent to
  --token <token>           bearer token for the backend
  --developer-email <email> identity attached to turn summaries (default: git config user.email)
  --root <path>             file this tenant's identity under a project root instead of the
                            machine default, so one machine can report to two tenants: work
                            at or below <path> uses this token, everything else keeps the
                            machine's own. Longest matching root wins
  --otel <signals>          native OTLP signals agents export to the backend: comma list of
                            logs,traces,metrics, or "all"/"none" (default: logs — the
                            per-request usage/cost ledger the backend turns into llm.call)
  --yes                     non-interactive: never prompt, fail if required values are missing
                            (alias: --non-interactive)
  --agent <id>              limit the command to one agent (claude | codex | cursor)
  --purge                   uninstall: also delete ~/.agentwatch and queued local data
  --dry-run                 hook: print resulting events to stdout instead of sending
  --json                    doctor: machine-readable output
  --verbose                 extra diagnostics on stderr
  --version                 print version

Configuration:
  global                    ~/.agentwatch/config.json (written by setup)
  per repository            .agentwatch.json in the repo root — overrides the global
                            config for work in that repo; "token", "installationId",
                            "developerEmail", "endpoint", "eventsUrl", "otlpUrl" and
                            "roots" are global-only and ignored there
  per project root          "roots" in the global config — absolute path to the identity
                            used beneath it (see --root). Identity only: what is captured
                            stays machine-wide
`;

/**
 * Dispatch one CLI invocation.
 *
 * Command modules are imported lazily: the `hook` subcommand runs on the coding
 * agent's critical path, and loading setup, doctor and status on the way to it
 * would cost every hook their startup.
 *
 * @returns The process exit code.
 */
async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));

  if (boolFlag(parsed, 'verbose')) setVerbose(true);

  const env = realEnv();

  switch (parsed.command) {
    case 'hook': {
      const { runHook } = await import('./cli/hook.js');

      return runHook(stringFlag(parsed, 'agent') ?? '', { env, dryRun: boolFlag(parsed, 'dry-run') });
    }
    case 'setup': {
      const { runSetup } = await import('./cli/setup.js');

      return runSetup({
        env,
        setupUrl: parsed.positional[0],
        endpoint: stringFlag(parsed, 'endpoint'),
        token: stringFlag(parsed, 'token'),
        developerEmail: stringFlag(parsed, 'developer-email'),
        root: stringFlag(parsed, 'root'),
        otel: stringFlag(parsed, 'otel'),
        yes: boolFlag(parsed, 'yes') || boolFlag(parsed, 'non-interactive')
      });
    }
    case 'status': {
      const { runStatus } = await import('./cli/status.js');

      return runStatus(env);
    }
    case 'doctor': {
      const { runDoctor } = await import('./cli/doctor.js');

      return runDoctor(env, { json: boolFlag(parsed, 'json') });
    }
    case 'uninstall': {
      const { runUninstall } = await import('./cli/uninstall.js');

      return runUninstall({ env, agent: stringFlag(parsed, 'agent'), purge: boolFlag(parsed, 'purge') });
    }
    case 'agents': {
      const { runAgents } = await import('./cli/misc.js');

      return runAgents(env);
    }
    case 'config': {
      const { runConfig } = await import('./cli/misc.js');

      return runConfig(env);
    }
    case 'otel-headers': {
      const { runOtelHeaders } = await import('./cli/misc.js');

      return runOtelHeaders(env);
    }
    default:
      return runFallback(parsed);
  }
}

/**
 * Handle `--version`, `help`, and an unrecognized command.
 *
 * @param parsed - Parsed arguments.
 * @returns The process exit code.
 */
async function runFallback(parsed: ParsedArgs): Promise<number> {
  if (boolFlag(parsed, 'version')) {
    const { createRequire } = await import('node:module');
    const pkg = createRequire(import.meta.url)('../package.json') as { version: string };

    process.stdout.write(pkg.version + '\n');

    return 0;
  }

  process.stdout.write(HELP);

  return parsed.command === undefined || parsed.command === 'help' ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`[agentwatch] fatal: ${(error as Error).stack ?? error}\n`);
    // A crashing hook must not break the calling agent.
    process.exit(process.argv[2] === 'hook' ? 0 : 1);
  }
);
