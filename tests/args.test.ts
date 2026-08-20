import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli/args.js';

describe('CLI argument parsing', () => {
  it('parses every documented value flag as a value, not a boolean', () => {
    const parsed = parseArgs(['setup', '--endpoint', 'https://b.example', '--token', 't', '--developer-email', 'd@x.com', '--otel', 'none']);

    expect(parsed.command).toBe('setup');
    expect(parsed.flags['endpoint']).toBe('https://b.example');
    expect(parsed.flags['token']).toBe('t');
    expect(parsed.flags['developer-email']).toBe('d@x.com');
    // Regression: --otel was missing from valueFlags, so `--otel none` became
    // a boolean flag plus a stray positional and the selection was ignored.
    expect(parsed.flags['otel']).toBe('none');
    expect(parsed.positional).toEqual([]);
  });

  it('parses --agent for the hook command', () => {
    const parsed = parseArgs(['hook', '--agent', 'cursor', '--dry-run']);

    expect(parsed.flags['agent']).toBe('cursor');
    expect(parsed.flags['dry-run']).toBe(true);
  });
});
