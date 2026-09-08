import { describe, expect, it } from 'vitest';
import { compact, omitKeys } from '../src/core/object.js';

const withProto = (): Record<string, unknown> => JSON.parse('{"__proto__":{"polluted":1},"a":2,"b":3}') as Record<string, unknown>;

describe('compact', () => {
  it('drops undefined entries and keeps the rest', () => {
    expect(compact({ a: 1, b: undefined, c: 'x' })).toEqual({ a: 1, c: 'x' });
  });

  it('keeps a __proto__ own key and returns a plain object', () => {
    const out = compact(withProto()) as Record<string, unknown> & { polluted?: unknown };

    expect(Object.keys(out)).toEqual(['__proto__', 'a', 'b']);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(out.polluted).toBeUndefined();
  });
});

describe('omitKeys', () => {
  it('copies without the named keys', () => {
    expect(omitKeys({ a: 1, b: 2 }, new Set(['b']))).toEqual({ a: 1 });
  });

  it('keeps a __proto__ own key and returns a plain object', () => {
    const out = omitKeys(withProto(), new Set(['b'])) as Record<string, unknown> & { polluted?: unknown };

    expect(Object.keys(out)).toEqual(['__proto__', 'a']);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(out.polluted).toBeUndefined();
  });
});
