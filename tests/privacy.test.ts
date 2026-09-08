import { describe, expect, it } from 'vitest';
import { sanitizeText, sanitizeValue } from '../src/privacy/sanitizer.js';
import { REDACTED } from '../src/privacy/constants/privacy.constants.js';

describe('sanitizeText', () => {
  it('redacts API keys and tokens', () => {
    expect(sanitizeText('key is sk-abc1234567890abcdef')).not.toContain('sk-abc1234567890abcdef');
    expect(sanitizeText('ghp_abcdefghijklmnopqrstuv123456')).toContain(REDACTED);
    expect(sanitizeText('AKIAIOSFODNN7EXAMPLE')).toContain(REDACTED);
    expect(sanitizeText('xoxb-123456789012-abcdefghij')).toContain(REDACTED);
  });

  it('redacts bearer/authorization values but keeps the scheme', () => {
    const out = sanitizeText('Authorization: Bearer abc.def-ghi_jkl123');

    expect(out).toContain('Bearer');
    expect(out).not.toContain('abc.def-ghi_jkl123');
  });

  it('redacts JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

    expect(sanitizeText(`token=${jwt}`)).not.toContain(jwt);
  });

  it('redacts credentials embedded in URLs', () => {
    const out = sanitizeText('cloning https://user:hunter2secret@github.com/acme/repo.git');

    expect(out).not.toContain('hunter2secret');
    expect(out).toContain('github.com/acme/repo.git');
  });

  it('redacts private key blocks', () => {
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----';

    expect(sanitizeText(key)).not.toContain('MIIEow');
  });

  it('redacts password assignments', () => {
    expect(sanitizeText('password=correcthorse')).not.toContain('correcthorse');
    expect(sanitizeText('api_key: "abc123secret"')).not.toContain('abc123secret');
  });
});

describe('sanitizeValue', () => {
  it('recursively redacts values under sensitive keys', () => {
    const input = {
      headers: { Authorization: 'Bearer topsecrettoken', accept: 'application/json' },
      nested: [{ api_key: 'zzz-secret-zzz' }],
      note: 'safe text'
    };
    const out = sanitizeValue(input);

    expect(out.headers.Authorization).toBe(REDACTED);
    expect(out.headers.accept).toBe('application/json');
    expect(out.nested[0]!.api_key).toBe(REDACTED);
    expect(out.note).toBe('safe text');
  });

  it('scrubs secrets inside deeply nested strings', () => {
    const out = sanitizeValue({ a: { b: { c: 'export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuv123456' } } });

    expect(JSON.stringify(out)).not.toContain('ghp_abcdefghijklmnopqrstuv123456');
  });

  it('leaves non-sensitive structures intact', () => {
    const input = { count: 3, ok: true, list: [1, 2, 3], when: null };

    expect(sanitizeValue(input)).toEqual(input);
  });
});

describe('sanitizeValue on object keys', () => {
  it('scrubs a secret that sits in a key, not only in a value', () => {
    const out = sanitizeValue({ 'sk-abcdefghijklmnopqrstuvwx': 'value', note: 'see sk-abcdefghijklmnopqrstuvwx' });

    expect(JSON.stringify(out)).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    expect(Object.keys(out)).toContain('note');
  });

  it('scrubs a secret key whose value is not a string', () => {
    expect(JSON.stringify(sanitizeValue({ 'ghp_abcdefghijklmnopqrstuv123456': 1 }))).not.toContain('ghp_abcdefghijklmnopqrstuv123456');
  });

  it('keeps both entries when two distinct keys redact to the same string', () => {
    const out = sanitizeValue({ 'ghp_abcdefghijklmnopqrstuv123456': 1, 'ghp_zyxwvutsrqponmlkjihg654321': 2 });
    const values = Object.values(out);

    expect(Object.keys(out)).toHaveLength(2);
    expect(values).toContain(1);
    expect(values).toContain(2);
  });

  it('still drops the value under a sensitive key after the key itself is scrubbed', () => {
    const out = sanitizeValue({ 'authorization-ghp_abcdefghijklmnopqrstuv123456': 'Bearer topsecrettoken' });

    expect(Object.values(out)).toEqual([REDACTED]);
    expect(JSON.stringify(out)).not.toContain('ghp_abcdefghijklmnopqrstuv123456');
  });

  it('keeps a __proto__ own key instead of silently dropping it, and does not retarget the copy', () => {
    const input = JSON.parse('{"__proto__":{"polluted":1},"a":2}') as Record<string, unknown>;
    const out = sanitizeValue(input) as Record<string, unknown> & { polluted?: unknown };

    expect(Object.keys(out)).toEqual(['__proto__', 'a']);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(out.polluted).toBeUndefined();
  });
});
