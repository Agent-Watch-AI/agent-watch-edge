import process from 'node:process';
import {
  COLOR_BOLD,
  COLOR_GREEN,
  COLOR_GREY,
  COLOR_RED,
  COLOR_RESET,
  COLOR_YELLOW,
  ESC,
  NO_COLOR_VAR
} from './constants/cli.constants.js';
import type { CheckLevel, LevelSymbols } from './types/cli.types.js';

export type { CheckLevel, LevelSymbols } from './types/cli.types.js';

/**
 * Human-facing output helpers.
 *
 * Only setup, status and doctor use these. A hook execution never writes to
 * stdout through this module: stdout belongs to the agent's hook protocol, and
 * a stray line there is a protocol error.
 */
const useColor = Boolean(process.stdout.isTTY) && !process.env[NO_COLOR_VAR];

/** Status glyphs, one per outcome. */
export const symbols: LevelSymbols = {
  ok: paint('✓', COLOR_GREEN),
  warn: paint('!', COLOR_YELLOW),
  fail: paint('✗', COLOR_RED),
  off: paint('○', COLOR_GREY)
};

/**
 * Emphasize a heading.
 *
 * @param text - The text.
 * @returns The text, bold when the terminal supports it.
 */
export function bold(text: string): string {
  return paint(text, COLOR_BOLD);
}

/**
 * De-emphasize a detail.
 *
 * @param text - The text.
 * @returns The text, dimmed when the terminal supports it.
 */
export function dim(text: string): string {
  return paint(text, COLOR_GREY);
}

/**
 * The glyph for one check outcome.
 *
 * @param level - The outcome.
 * @returns Its glyph.
 */
export function levelSymbol(level: CheckLevel): string {
  if (level === 'ok') return symbols.ok;

  if (level === 'warn') return symbols.warn;

  return symbols.fail;
}

/**
 * Write one line to stdout.
 *
 * @param line - The line, without its newline.
 */
export function println(line = ''): void {
  process.stdout.write(line + '\n');
}

/**
 * Write one line to stderr.
 *
 * Refusals go here, not to stdout: a scripted rollout reads the exit code and
 * the error stream, and a failure printed among the progress lines is a failure
 * nobody sees.
 *
 * @param line - The line, without its newline.
 */
export function printErrln(line = ''): void {
  process.stderr.write(line + '\n');
}

/**
 * Wrap text in an ANSI colour, when the terminal wants colour at all.
 *
 * @param text - The text.
 * @param code - SGR parameter.
 * @returns The wrapped, or bare, text.
 */
function paint(text: string, code: string): string {
  return useColor ? `${ESC}[${code}m${text}${ESC}[${COLOR_RESET}m` : text;
}
