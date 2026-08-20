import process from 'node:process';
import { DEBUG_NAMESPACE, DEBUG_NAMESPACE_VAR, DEBUG_VAR, LOG_PREFIX, TRUTHY_DEBUG_VALUES } from './constants/core.constants.js';

/**
 * All diagnostics go to stderr. Hook stdout belongs to the agent's hook
 * protocol and must never receive log output.
 *
 * The `--verbose` flag is process-wide state, so it lives here as the module's
 * one deliberate mutable cell rather than being threaded through every call.
 */
let verbose = false;

/**
 * Turn on verbose diagnostics for the rest of the process.
 *
 * @param on - Whether `--verbose` was passed.
 */
export function setVerbose(on: boolean): void {
  verbose = on;
}

/**
 * Whether debug diagnostics should be written.
 *
 * @param vars - Environment to read; defaults to the real process env.
 * @returns True when `--verbose`, AGENTWATCH_DEBUG or DEBUG asked for them.
 */
export function debugEnabled(vars: Readonly<Record<string, string | undefined>> = process.env): boolean {
  if (verbose) return true;

  const flag = (vars[DEBUG_VAR] ?? '').toLowerCase();

  if (TRUTHY_DEBUG_VALUES.has(flag)) return true;

  return (vars[DEBUG_NAMESPACE_VAR] ?? '').includes(DEBUG_NAMESPACE);
}

/**
 * Write a diagnostic line to stderr when debugging is on.
 *
 * @param parts - Message fragments; objects are JSON-encoded, Errors reduced
 *   to their message.
 */
export function debugLog(...parts: readonly unknown[]): void {
  if (!debugEnabled()) return;

  process.stderr.write(`${LOG_PREFIX} ${formatParts(parts)}\n`);
}

/**
 * Write a warning to stderr. Always shown: a warning the user cannot see is
 * not a warning.
 *
 * @param parts - Message fragments, formatted like {@link debugLog}.
 */
export function warnLog(...parts: readonly unknown[]): void {
  process.stderr.write(`${LOG_PREFIX} warning: ${formatParts(parts)}\n`);
}

/**
 * Render message fragments as one space-separated line.
 *
 * @param parts - Fragments of any shape.
 * @returns The joined text.
 */
function formatParts(parts: readonly unknown[]): string {
  const rendered: string[] = [];

  for (const part of parts) rendered.push(formatPart(part));

  return rendered.join(' ');
}

/**
 * Render one fragment, never throwing on a cyclic or exotic value.
 *
 * @param part - Fragment of any shape.
 * @returns Its text form.
 */
function formatPart(part: unknown): string {
  if (typeof part === 'string') return part;

  if (part instanceof Error) return part.message;

  try {
    return JSON.stringify(part) ?? String(part);
  } catch {
    return String(part);
  }
}
