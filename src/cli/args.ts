/**
 * Hand-rolled argv parsing: the hook subcommand runs on coding agents'
 * critical path, so we keep startup free of CLI-framework imports.
 */
export interface ParsedArgs {
  command?: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { positional: [], flags: {} };
  // Every flag documented as taking a value must be listed here, or its value
  // silently becomes a positional and the flag a boolean (`--otel none` used
  // to ignore the selection entirely).
  const valueFlags = new Set(['agent', 'endpoint', 'token', 'developer-email', 'otel']);
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
