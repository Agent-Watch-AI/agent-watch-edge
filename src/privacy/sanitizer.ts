import { REDACTED, SECRET_PATTERNS, SENSITIVE_KEY_PATTERN } from './secret-patterns.js';

const MAX_DEPTH = 12;
const MAX_STRING_LENGTH = 8192;

/** Redact known secret shapes inside a string. */
export function sanitizeText(text: string): string {
  let out = text.length > MAX_STRING_LENGTH ? text.slice(0, MAX_STRING_LENGTH) : text;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement ?? REDACTED);
  }
  return out;
}

/**
 * Recursively sanitize any value before it leaves the machine: values under
 * sensitive keys are dropped wholesale; every string is pattern-scrubbed.
 */
export function sanitizeValue<T>(value: T): T {
  return walk(value, 0) as T;
}

function walk(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return '[TRUNCATED]';
  if (typeof value === 'string') return sanitizeText(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      out[key] = REDACTED;
    } else {
      out[key] = walk(entry, depth + 1);
    }
  }
  return out;
}
