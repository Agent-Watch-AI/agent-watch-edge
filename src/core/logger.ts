import process from 'node:process';

/**
 * All diagnostics go to stderr. Hook stdout belongs to the agent's hook
 * protocol and must never receive log output.
 */
let verbose = false;

export function setVerbose(on: boolean): void {
  verbose = on;
}

export function debugEnabled(vars: Record<string, string | undefined> = process.env): boolean {
  const flag = vars['AGENTWATCH_DEBUG'] ?? '';
  const debugVar = vars['DEBUG'] ?? '';
  return verbose || flag === '1' || flag.toLowerCase() === 'true' || debugVar.includes('agentwatch');
}

export function debugLog(...parts: unknown[]): void {
  if (debugEnabled()) {
    process.stderr.write(`[agentwatch] ${parts.map(formatPart).join(' ')}\n`);
  }
}

export function warnLog(...parts: unknown[]): void {
  process.stderr.write(`[agentwatch] warning: ${parts.map(formatPart).join(' ')}\n`);
}

function formatPart(part: unknown): string {
  if (typeof part === 'string') return part;
  if (part instanceof Error) return part.message;
  try {
    return JSON.stringify(part);
  } catch {
    return String(part);
  }
}
