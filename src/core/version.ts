/** First dotted version (x.y.z) found in CLI output, if any. */
export function parseVersion(output: string): string | undefined {
  return /\d+\.\d+\.\d+/.exec(output)?.[0];
}

/** Numeric segment-wise comparison; missing segments count as 0. */
export function meetsMinVersion(version: string, min: string): boolean {
  const a = version.split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (Number.isNaN(left) || Number.isNaN(right)) return false;
    if (left !== right) return left > right;
  }
  return true;
}
