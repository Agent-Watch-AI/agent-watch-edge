export const OTLP_HTTP_SIGNALS = ['logs', 'traces', 'metrics'] as const;

export type OtlpHttpSignal = (typeof OTLP_HTTP_SIGNALS)[number];

const OTLP_HTTP_PATH = /^\/v1\/otlp\/v1\/(logs|traces|metrics)$/;

/** Match only the OTLP/HTTP endpoints supported by the example receiver. */
export function otlpSignalFromPath(path: string): OtlpHttpSignal | undefined {
  const signal = OTLP_HTTP_PATH.exec(path)?.[1];
  return OTLP_HTTP_SIGNALS.find((candidate) => candidate === signal);
}

export type DecodedOtlpJson =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false };

/** Decode an OTLP/JSON request without acknowledging malformed payloads. */
export function decodeOtlpJson(body: Uint8Array): DecodedOtlpJson {
  try {
    const payload: unknown = JSON.parse(Buffer.from(body).toString('utf8'));
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return { ok: false };
    return { ok: true, payload: payload as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}
