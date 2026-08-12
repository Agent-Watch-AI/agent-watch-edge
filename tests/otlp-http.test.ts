import { describe, expect, it } from 'vitest';
import { decodeOtlpJson, otlpSignalFromPath } from '../src/otlp/http.js';

describe('example OTLP/HTTP request validation', () => {
  it.each([
    ['/v1/otlp/v1/logs', 'logs'],
    ['/v1/otlp/v1/traces', 'traces'],
    ['/v1/otlp/v1/metrics', 'metrics']
  ] as const)('accepts the supported endpoint %s', (path, signal) => {
    expect(otlpSignalFromPath(path)).toBe(signal);
  });

  it.each([
    '/v1/otlp/v1/unknown',
    '/v1/otlp/logs',
    '/v1/otlp/v1/logs/extra'
  ])('rejects unsupported endpoint %s', (path) => {
    expect(otlpSignalFromPath(path)).toBeUndefined();
  });

  it('decodes an OTLP JSON object', () => {
    expect(decodeOtlpJson(Buffer.from('{"resourceLogs":[]}'))).toEqual({
      ok: true,
      payload: { resourceLogs: [] }
    });
  });

  it.each(['{not-json', 'null', '[]', '"logs"'])('rejects malformed OTLP JSON payload %s', (body) => {
    expect(decodeOtlpJson(Buffer.from(body))).toEqual({ ok: false });
  });
});
