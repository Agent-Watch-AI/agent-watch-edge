import { FLAG_PREFIX, VALUE_FLAGS } from './constants/cli.constants.js';
import type { ParsedArgs } from './types/cli.types.js';

export type { ParsedArgs } from './types/cli.types.js';

/**
 * Parse argv.
 *
 * Hand-rolled on purpose: the `hook` subcommand runs on the coding agent's
 * critical path, and importing a CLI framework would cost every hook
 * invocation the framework's startup.
 *
 * @param argv - Arguments after the executable and script.
 * @returns The command, positionals and flags.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let command: string | undefined;
  let index = 0;

  while (index < argv.length) {
    const arg = argv[index]!;

    if (!arg.startsWith(FLAG_PREFIX)) {
      if (command === undefined) {
        command = arg;
        index += 1;
        continue;
      }

      positional.push(arg);
      index += 1;
      continue;
    }

    const name = arg.slice(FLAG_PREFIX.length);
    const value = argv[index + 1];

    if (VALUE_FLAGS.has(name) && value !== undefined && !value.startsWith(FLAG_PREFIX)) {
      flags[name] = value;
      index += 2;
      continue;
    }

    flags[name] = true;
    index += 1;
  }

  return { command, positional, flags };
}

/**
 * A flag's value when it was given as a string.
 *
 * @param parsed - Parsed arguments.
 * @param name - Flag name without the `--`.
 * @returns The value, or undefined when absent or boolean.
 */
export function stringFlag(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags[name];

  return typeof value === 'string' ? value : undefined;
}

/**
 * Whether a boolean flag was given.
 *
 * @param parsed - Parsed arguments.
 * @param name - Flag name without the `--`.
 * @returns True when present.
 */
export function boolFlag(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags[name] === true;
}
