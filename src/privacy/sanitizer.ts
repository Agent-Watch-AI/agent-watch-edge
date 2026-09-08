import { isRecord } from '../core/object.js';
import { MAX_DEPTH, MAX_STRING_LENGTH, REDACTED, SECRET_PATTERNS, SENSITIVE_KEY_PATTERN, TRUNCATED } from './constants/privacy.constants.js';

/**
 * Redact known credential shapes inside a string, and cap its length.
 *
 * @param text - Text about to leave the machine.
 * @returns The scrubbed text.
 */
export function sanitizeText(text: string): string {
  let out = text.length > MAX_STRING_LENGTH ? text.slice(0, MAX_STRING_LENGTH) : text;

  for (const { pattern, replacement } of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement ?? REDACTED);
  }

  return out;
}

/**
 * Recursively sanitize any value before it leaves the machine.
 *
 * Two independent defences, because either alone leaks: a value under a
 * sensitive *key* is dropped whole whatever it looks like, and every string is
 * pattern-scrubbed whatever key it sits under — keys included, because captured
 * material contains keyed maps whose keys are the credential. Both run
 * regardless of the user's capture settings — those decide what we collect, not
 * whether secrets are removed from it.
 *
 * The sensitive-key test reads the *raw* key, since scrubbing it first could
 * destroy the very word ("authorization") the test matches on.
 *
 * @param value - Value to sanitize; left untouched.
 * @returns A sanitized copy of the same shape.
 */
export function sanitizeValue<T>(value: T): T {
  return walk(value, 0) as T;
}

/**
 * Depth-bounded copy with redaction applied at every level.
 *
 * @param value - Current node.
 * @param depth - Depth of this node.
 * @returns The sanitized node.
 */
function walk(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return TRUNCATED;

  if (typeof value === 'string') return sanitizeText(value);

  if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1));

  if (!isRecord(value)) return value;

  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

  for (const [key, entry] of Object.entries(value)) {
    out[freeKey(out, sanitizeText(key))] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : walk(entry, depth + 1);
  }

  return { ...out };
}

/**
 * First unused spelling of an already-sanitized key.
 *
 * Two distinct keys can scrub to the same string, and plain assignment would
 * then silently merge two entries into one — data loss in the module whose job
 * is to be trustworthy. Collisions get a `:2`, `:3` suffix instead, so the copy
 * always holds as many entries as the original.
 *
 * @param out - Object being built; only read here.
 * @param key - Sanitized key to place.
 * @returns The key itself, or the first free suffixed spelling of it.
 */
function freeKey(out: Record<string, unknown>, key: string): string {
  if (!(key in out)) return key;

  let suffix = 2;

  while (`${key}:${suffix}` in out) suffix += 1;

  return `${key}:${suffix}`;
}
