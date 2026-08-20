/**
 * Add an untrusted value to a running total, ignoring anything unusable.
 *
 * Token counts come from transcripts and OTLP attributes, where a field may be
 * missing, null, or a string. `undefined + 1` would poison the whole sum with
 * NaN, so a value that is not a finite number leaves the total as it was —
 * including its "not reported at all" undefined state.
 *
 * @param current - Total so far; undefined when nothing has been added yet.
 * @param value - Candidate addend of unknown shape.
 * @returns The new total, or `current` when the value was unusable.
 */
export function add(current: number | undefined, value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return current;

  return (current ?? 0) + value;
}

/**
 * An untrusted value as a number, treating anything unusable as zero.
 *
 * For weights and ratios, where "missing" and "zero" are the same thing.
 *
 * @param value - Candidate of unknown shape.
 * @returns The finite number, or 0.
 */
export function finiteOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Sum the values that are actually present.
 *
 * Returns undefined for an all-empty input rather than 0: "no agent reported
 * this token class" and "the agent reported zero" are different facts, and
 * collapsing them would invent usage data downstream.
 *
 * @param values - Values to sum; undefined entries are skipped.
 * @returns The sum, or undefined when no value was present.
 */
export function sumPresent(values: readonly (number | undefined)[]): number | undefined {
  let total: number | undefined;

  for (const value of values) {
    if (value === undefined) continue;

    total = (total ?? 0) + value;
  }

  return total;
}
