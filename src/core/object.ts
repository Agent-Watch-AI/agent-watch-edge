import type { UnknownRecord } from './types/core.types.js';

export type { UnknownRecord } from './types/core.types.js';

/**
 * Drop every key whose value is `undefined`, returning a new object.
 *
 * Canonical events are serialized straight to JSON, and an explicit
 * `"field": undefined` is not representable there — the property has to be
 * absent instead. Building a fresh object (rather than deleting keys) also
 * keeps the result monomorphic for V8 (STYLEGUIDE 3.4).
 *
 * @param value - Object to compact; left untouched.
 * @returns A copy holding only the defined entries.
 */
export function compact<T extends object>(value: T): T {
  const out: UnknownRecord = {};

  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;

    out[key] = entry;
  }

  return out as T;
}

/**
 * Copy an object without the given keys.
 *
 * The replacement for `delete obj.key`: same result, no hidden-class
 * transition on the original object (STYLEGUIDE 3.4).
 *
 * @param value - Source object; left untouched.
 * @param keys - Keys to leave out. A Set, so the filter is O(1) per entry.
 * @returns A copy without those keys.
 */
export function omitKeys<T extends UnknownRecord>(value: T, keys: ReadonlySet<string>): T {
  const out: UnknownRecord = {};

  for (const [key, entry] of Object.entries(value)) {
    if (keys.has(key)) continue;

    out[key] = entry;
  }

  return out as T;
}

/**
 * Narrow an untrusted value to a plain JSON object.
 *
 * Arrays are rejected on purpose: every caller wants a keyed record, and
 * `typeof [] === 'object'` would otherwise let one through.
 *
 * @param value - Value of unknown shape.
 * @returns The value as a record, or undefined when it is not one.
 */
export function asRecord(value: unknown): UnknownRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;

  return value as UnknownRecord;
}

/**
 * Type guard form of {@link asRecord}, for use in conditions.
 *
 * @param value - Value of unknown shape.
 * @returns True when the value is a plain JSON object.
 */
export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * An array, or an empty one for anything else.
 *
 * @param value - Value of unknown shape.
 * @returns The value when it is an array, otherwise an empty array.
 */
export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * First key that holds a usable string, checked in the given order.
 *
 * Numbers are stringified: agents report the same attribute (a sequence
 * number, an id) as either type depending on version and exporter.
 *
 * @param record - Attribute bag to read.
 * @param keys - Candidate keys, most specific first.
 * @returns The first non-empty value, or undefined when none matches.
 */
export function firstString(record: UnknownRecord, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];

    if (typeof value === 'string' && value.length > 0) return value;

    if (typeof value === 'number') return String(value);
  }

  return undefined;
}

/**
 * First key that holds a finite number, checked in the given order.
 *
 * Numeric strings are accepted: OTLP/JSON encodes 64-bit integers as strings,
 * so token counts arrive either way.
 *
 * @param record - Attribute bag to read.
 * @param keys - Candidate keys, most specific first.
 * @returns The first finite value, or undefined when none matches.
 */
export function firstNumber(record: UnknownRecord, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];

    if (typeof value === 'number' && Number.isFinite(value)) return value;

    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);

      if (Number.isFinite(parsed)) return parsed;
    }
  }

  return undefined;
}

/**
 * First argument that is a non-empty string.
 *
 * @param values - Candidates in priority order.
 * @returns The first usable string, or undefined when there is none.
 */
export function firstStringOf(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }

  return undefined;
}
