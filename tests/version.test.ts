import { describe, expect, it } from 'vitest';
import { parseVersion, meetsMinVersion } from '../src/core/version.js';

describe('version helpers', () => {
  it('parses a version out of CLI output', () => {
    expect(parseVersion('2.1.196 (Claude Code)')).toBe('2.1.196');
    expect(parseVersion('claude 2.2.0')).toBe('2.2.0');
    expect(parseVersion('no digits here')).toBeUndefined();
  });

  it('compares dotted versions numerically', () => {
    expect(meetsMinVersion('2.1.196', '2.1.196')).toBe(true);
    expect(meetsMinVersion('2.2.0', '2.1.196')).toBe(true);
    expect(meetsMinVersion('2.1.195', '2.1.196')).toBe(false);
    expect(meetsMinVersion('2.1', '2.1.196')).toBe(false);
    expect(meetsMinVersion('10.0.0', '2.1.196')).toBe(true);
  });
});
