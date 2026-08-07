#!/usr/bin/env node
import process from 'node:process';
import { realEnv } from './core/env.js';
import { setVerbose } from './core/logger.js';

/**
 * Hand-rolled argv parsing: the hook subcommand runs on coding agents'
 * critical path, so we keep startup free of CLI-framework imports and load
 * command modules lazily.
 */
interface ParsedArgs {
  command?: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { positional: [], flags: {} };
  const valueFlags = new Set(['agent', 'endpoint', 'token']);
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index]!;
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (valueFlags.has(name) && index + 1 < argv.length && !argv[index + 1]!.startsWith('--')) {
        parsed.flags[name] = argv[index + 1]!;
        index += 2;
        continue;
      }
      parsed.flags[name] = true;
      index += 1;
      continue;
    }
    if (!parsed.command) parsed.command = arg;
    else parsed.positional.push(arg);
    index += 1;
  }
  return parsed;
}

const HELP = `agentwatch — telemetry bridge for AI coding agents

Usage:
  agentwatch setup [enrollment-url] [--endpoint <url>] [--token <token>] [--yes]
  agentwatch status
  agentwatch doctor [--json]
  agentwatch uninstall [--agent <id>] [--purge]
  agentwatch hook --agent <id> [--dry-run]     (invoked by agents; reads stdin)
  agentwatch agents
  agentwatch config
  agentwatch otel-headers

Flags:
  --verbose        extra diagnostics on stderr
  --version        print version
`;

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.flags['verbose']) setVerbose(true);
  const env = realEnv();

  switch (parsed.command) {
    case 'hook': {
      const { runHook } = await import('./cli/hook.js');
      const agent = typeof parsed.flags['agent'] === 'string' ? (parsed.flags['agent'] as string) : '';
      return runHook(agent, { env, dryRun: parsed.flags['dry-run'] === true });
    }
    case 'setup': {
      const { runSetup } = await import('./cli/setup.js');
      return runSetup({
        env,
        setupUrl: parsed.positional[0],
        endpoint: typeof parsed.flags['endpoint'] === 'string' ? (parsed.flags['endpoint'] as string) : undefined,
        token: typeof parsed.flags['token'] === 'string' ? (parsed.flags['token'] as string) : undefined,
        yes: parsed.flags['yes'] === true
      });
    }
    case 'status': {
      const { runStatus } = await import('./cli/status.js');
      return runStatus(env);
    }
    case 'doctor': {
      const { runDoctor } = await import('./cli/doctor.js');
      return runDoctor(env, { json: parsed.flags['json'] === true });
    }
    case 'uninstall': {
      const { runUninstall } = await import('./cli/uninstall.js');
      return runUninstall({
        env,
        agent: typeof parsed.flags['agent'] === 'string' ? (parsed.flags['agent'] as string) : undefined,
        purge: parsed.flags['purge'] === true
      });
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
    default: {
      if (parsed.flags['version']) {
        const { createRequire } = await import('node:module');
        const pkg = createRequire(import.meta.url)('../package.json') as { version: string };
        process.stdout.write(pkg.version + '\n');
        return 0;
      }
      process.stdout.write(HELP);
      return parsed.command === undefined || parsed.command === 'help' ? 0 : 1;
    }
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`[agentwatch] fatal: ${(error as Error).stack ?? error}\n`);
    // A crashing hook must not break the calling agent.
    process.exit(process.argv[2] === 'hook' ? 0 : 1);
  }
);
