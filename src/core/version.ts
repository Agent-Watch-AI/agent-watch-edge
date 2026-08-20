import { RE_SEMVER } from './constants/core.constants.js';

/**
 * First dotted version (x.y.z) found in CLI output.
 *
 * @param output - Raw stdout of a `--version` call.
 * @returns The version, or undefined when the output holds none.
 */
export function parseVersion(output: string): string | undefined {
  return RE_SEMVER.exec(output)?.[0];
}

/**
 * Whether `version` is at least `min`.
 *
 * Segment-wise numeric comparison; a missing segment counts as 0, so "2.1"
 * satisfies "2.1.0". A non-numeric segment fails closed: an unparseable
 * version must not be reported as new enough.
 *
 * @param version - Version found on the machine.
 * @param min - Minimum this feature needs.
 * @returns True when version >= min.
 */
export function meetsMinVersion(version: string, min: string): boolean {
  const actual = version.split('.');
  const required = min.split('.');
  const length = Math.max(actual.length, required.length);

  for (let index = 0; index < length; index++) {
    const left = Number(actual[index] ?? 0);
    const right = Number(required[index] ?? 0);

    if (Number.isNaN(left) || Number.isNaN(right)) return false;

    if (left !== right) return left > right;
  }

  return true;
}
