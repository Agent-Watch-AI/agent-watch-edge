/**
 * Decoding agents' own OpenTelemetry export into the atomic usage ledger.
 * Published as `@agentwatch-ai/edge/otlp` for backends that ingest it
 * themselves.
 */
export type {
  Attributes,
  DecodedOtlpJson,
  NormalizeOtlpOptions,
  OtlpCallIdentity,
  OtlpCorrelationContext,
  OtlpHttpSignal,
  OtlpProvider,
  OtlpUsage,
  RecordIdentity
} from './types/otlp.types.js';

export { OTLP_HTTP_SIGNALS } from './constants/otlp.constants.js';
export { normalizeOtlpLogs } from './normalize.js';
export { decodeOtlpJson, otlpSignalFromPath } from './http.js';
