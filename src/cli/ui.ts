import process from 'node:process';

/** Human-facing output helpers. Only setup/status/doctor use these; hook
 * executions never write to stdout through this module. */
const ESC = '\u001b';
const useColor = Boolean(process.stdout.isTTY) && !process.env['NO_COLOR'];

export const symbols = {
  ok: paint('✓', '32'),
  warn: paint('!', '33'),
  fail: paint('✗', '31'),
  off: paint('○', '90')
};

export function bold(text: string): string {
  return useColor ? `${ESC}[1m${text}${ESC}[0m` : text;
}

export function dim(text: string): string {
  return useColor ? `${ESC}[90m${text}${ESC}[0m` : text;
}

function paint(text: string, code: string): string {
  return useColor ? `${ESC}[${code}m${text}${ESC}[0m` : text;
}

export function println(line = ''): void {
  process.stdout.write(line + '\n');
}
