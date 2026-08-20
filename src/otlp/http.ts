import { asRecord } from '../core/object.js';
import { OTLP_HTTP_SIGNALS, RE_OTLP_HTTP_PATH } from './constants/otlp.constants.js';
import type { DecodedOtlpJson, OtlpHttpSignal } from './types/otlp.types.js';

export { OTLP_HTTP_SIGNALS } from './constants/otlp.constants.js';
export type { DecodedOtlpJson, OtlpHttpSignal } from './types/otlp.types.js';

/**
 * Which OTLP signal a request path names.
 *
 * Matches only the endpoints the example receiver actually serves: an
 * unrecognized path must 404 rather than be silently accepted, or an exporter
 * misconfiguration looks like success while the data goes nowhere.
 *
 * @param requestPath - Request path.
 * @returns The signal, or undefined when the path is not one of ours.
 */
export function otlpSignalFromPath(requestPath: string): OtlpHttpSignal | undefined {
  const signal = RE_OTLP_HTTP_PATH.exec(requestPath)?.[1];

  return OTLP_HTTP_SIGNALS.find((candidate) => candidate === signal);
}

/**
 * Decode an OTLP/JSON request body.
 *
 * A malformed payload is reported rather than acknowledged: an exporter that
 * receives 200 for a body nobody could read will never retry it.
 *
 * @param body - Raw request bytes.
 * @returns The decoded envelope, or a failure.
 */
export function decodeOtlpJson(body: Uint8Array): DecodedOtlpJson {
  try {
    const payload = asRecord(JSON.parse(Buffer.from(body).toString('utf8')));

    if (!payload) return { ok: false };

    return { ok: true, payload };
  } catch {
    return { ok: false };
  }
}
