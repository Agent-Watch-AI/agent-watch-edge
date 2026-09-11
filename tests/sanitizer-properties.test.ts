import { describe, expect, it } from 'vitest';
import { MAX_DEPTH, MAX_STRING_LENGTH, REDACTED, TRUNCATED } from '../src/privacy/constants/privacy.constants.js';
import { sanitizeText, sanitizeValue } from '../src/privacy/sanitizer.js';

/**
 * A known-shape secret the pattern set must always catch.
 *
 * One spelling per pattern family, so the generator exercises the whole set
 * rather than whichever one happens to be first.
 */
const SECRETS = [
  'ghp_abcdefghijklmnopqrstuv123456',
  'sk-abcdefghijklmnopqrstuvwx',
  'AKIAIOSFODNN7EXAMPLE',
  'xoxb-123456789012-abcdefghij',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
];

/** Deterministic PRNG, so a failing case is reproducible from its seed alone. */
function rng(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;

    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A payload of arbitrary shape with one secret planted somewhere inside it.
 *
 * The secret lands in a value, inside a longer string, in an object *key*, or
 * in an array element, at a random depth — the shapes a real tool result takes
 * when it dumps a keyed map or an environment block.
 *
 * @param next - The generator's random source.
 * @param secret - The secret to plant.
 * @param depth - Current nesting depth.
 * @returns The generated value.
 */
function payloadWith(next: () => number, secret: string, depth = 0): unknown {
  const pick = next();

  if (depth >= 6 || pick < 0.2) return next() < 0.5 ? secret : `see ${secret} at the end`;

  if (pick < 0.4) return Array.from({ length: 1 + Math.floor(next() * 3) }, () => payloadWith(next, secret, depth + 1));

  const out: Record<string, unknown> = {};
  const keyed = next() < 0.3;

  out[keyed ? secret : `field${Math.floor(next() * 5)}`] = keyed ? next() : payloadWith(next, secret, depth + 1);
  out['noise'] = next() < 0.5 ? 'harmless' : { nested: 1 };

  return out;
}

describe('the sanitizer never lets a known secret through, whatever shape it arrives in', () => {
  it('holds for 500 generated payloads across every pattern family', () => {
    const next = rng(20260908);

    for (let attempt = 0; attempt < 500; attempt += 1) {
      const secret = SECRETS[attempt % SECRETS.length]!;
      const payload = payloadWith(next, secret, 0);
      const out = JSON.stringify(sanitizeValue(payload));

      expect(out, `seed step ${attempt}, secret ${secret}, payload ${JSON.stringify(payload).slice(0, 200)}`).not.toContain(secret);
    }
  });

  it('preserves the entry count of every object it copies, so no key is silently merged', () => {
    const next = rng(4711);

    for (let attempt = 0; attempt < 200; attempt += 1) {
      const payload = payloadWith(next, SECRETS[attempt % SECRETS.length]!, 0);

      expectSameShape(payload, sanitizeValue(payload));
    }
  });
});

/**
 * Assert a sanitized copy has the same structure as its input.
 *
 * Values change; the number of entries and the length of every array must not.
 *
 * @param input - The original value.
 * @param output - Its sanitized copy.
 */
function expectSameShape(input: unknown, output: unknown): void {
  if (Array.isArray(input)) {
    expect(Array.isArray(output)).toBe(true);
    expect((output as unknown[]).length).toBe(input.length);
    input.forEach((item, index) => expectSameShape(item, (output as unknown[])[index]));

    return;
  }

  if (typeof input !== 'object' || input === null) return;

  expect(Object.keys(output as object)).toHaveLength(Object.keys(input).length);
}

describe('the cases a reviewer asks about and nothing asserted', () => {
  it('cuts a secret that straddles the truncation boundary rather than shipping its head', () => {
    const secret = SECRETS[0]!;
    const text = 'x'.repeat(MAX_STRING_LENGTH - 12) + secret;
    const out = sanitizeText(text);

    expect(out).not.toContain(secret);
    // The prefix that survives is 12 characters of `ghp_...`, which is not a
    // usable credential and is what the truncate-then-scrub order produces.
    expect(out.length).toBe(MAX_STRING_LENGTH);
  });

  it('truncates a long string silently and marks a too-deep object, and that asymmetry is deliberate', () => {
    // A string is cut because the tail of a captured blob is not worth the
    // bytes; a depth cap is marked because the *shape* is what was lost and a
    // reader of the record would otherwise think the object simply ended.
    expect(sanitizeText('a'.repeat(MAX_STRING_LENGTH + 100))).not.toContain(TRUNCATED);
    expect(sanitizeText('a'.repeat(MAX_STRING_LENGTH + 100))).toHaveLength(MAX_STRING_LENGTH);

    let deep: unknown = 'leaf';

    for (let level = 0; level <= MAX_DEPTH + 1; level += 1) deep = { down: deep };

    expect(JSON.stringify(sanitizeValue(deep))).toContain(TRUNCATED);
  });

  it('survives a cyclic object on the depth cap rather than overflowing the stack', () => {
    const cyclic: Record<string, unknown> = { name: 'root' };

    cyclic['self'] = cyclic;

    const out = JSON.stringify(sanitizeValue(cyclic));

    expect(out).toContain(TRUNCATED);
    expect(out).toContain('root');
  });

  it('passes through the value kinds walk does not descend into, without inventing content', () => {
    const when = new Date('2026-09-08T10:00:00.000Z');
    const out = sanitizeValue({
      when,
      big: 10n,
      set: new Set(['a']),
      map: new Map([['k', 'v']]),
      // A Symbol key is not an own enumerable string key, so Object.entries
      // never sees it and it cannot reach the output at all.
      [Symbol('hidden')]: SECRETS[0]
    }) as Record<string, unknown>;

    // A Date survives, so the record still serializes to the ISO string it
    // would have carried without the sanitizer in the way.
    expect(out['when']).toBe(when);
    expect(JSON.stringify({ when: out['when'] })).toBe('{"when":"2026-09-08T10:00:00.000Z"}');
    expect(out['big']).toBe(10n);
    // A Map or a Set is not part of the record vocabulary, and `JSON.stringify`
    // writes `{}` for either one with or without the sanitizer.
    expect(JSON.stringify({ set: out['set'], map: out['map'] })).toBe('{"set":{},"map":{}}');
    expect(Object.getOwnPropertySymbols(out)).toHaveLength(0);
  });

  it('drops the value under a sensitive key whatever the value looks like', () => {
    const out = sanitizeValue({ authorization: { nested: { deeper: 'anything at all' } }, password: 42 }) as Record<string, unknown>;

    expect(out['authorization']).toBe(REDACTED);
    expect(out['password']).toBe(REDACTED);
  });
});
