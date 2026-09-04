import {
  ENFORCEMENT_PATH,
  EVENTS_PATH,
  OTEL_ALL,
  OTEL_NONE,
  OTEL_SIGNAL_NAMES,
  OTEL_SIGNAL_NAME_SET,
  OTLP_BASE_PATH,
  RE_TRAILING_SLASHES
} from './constants/config.constants.js';
import { configSchema } from './schemas/config.schema.js';
import type { AgentWatchConfig, OtelConfig, OtelSignalName } from './types/config.types.js';

export { captureSchema, configSchema, deliverySchema, emitSchema, enforcementSchema, otelSchema } from './schemas/config.schema.js';
export type { AgentWatchConfig, CaptureConfig, EnforcementConfig, OtelConfig, OtelSignalName } from './types/config.types.js';

/**
 * The configuration a deliberate `agentwatch setup` writes: metadata only.
 *
 * @returns A config with every default applied.
 */
export function defaultConfig(): AgentWatchConfig {
  return configSchema.parse({});
}

/**
 * Whether any native OTLP signal is enabled.
 *
 * @param config - Effective configuration.
 * @returns True when at least one signal is on.
 */
export function otelEnabled(config: AgentWatchConfig): boolean {
  return config.otel.logs || config.otel.traces || config.otel.metrics;
}

/**
 * Names of the enabled OTLP signals, for setup and status messages.
 *
 * @param otel - The signal selection.
 * @returns Enabled signal names in canonical order.
 */
export function enabledSignalNames(otel: OtelConfig): OtelSignalName[] {
  return OTEL_SIGNAL_NAMES.filter((name) => otel[name]);
}

/**
 * Parse the `--otel` CLI value: "all", "none", or a comma list of
 * logs/traces/metrics.
 *
 * Returns undefined — rather than ignoring the bad name — so setup can fail
 * the whole run on a typo instead of silently configuring the wrong signals.
 *
 * @param value - Raw flag value.
 * @returns The selection, or undefined when a name is unknown.
 */
export function parseOtelSignals(value: string): OtelConfig | undefined {
  const normalized = value.trim().toLowerCase();

  if (normalized === OTEL_ALL) return { logs: true, traces: true, metrics: true };

  if (normalized === OTEL_NONE) return { logs: false, traces: false, metrics: false };

  const signals: OtelConfig = { logs: false, traces: false, metrics: false };

  for (const part of normalized.split(',')) {
    const name = part.trim();

    if (name === '') continue;

    if (!OTEL_SIGNAL_NAME_SET.has(name)) return undefined;

    signals[name as OtelSignalName] = true;
  }

  return signals;
}

/**
 * Where product events are POSTed.
 *
 * @param config - Effective configuration.
 * @returns The events URL, or undefined when no backend is configured.
 */
export function eventsUrl(config: AgentWatchConfig): string | undefined {
  if (config.eventsUrl) return config.eventsUrl;

  if (!config.endpoint) return undefined;

  return joinUrl(config.endpoint, EVENTS_PATH);
}

/**
 * Base URL agents' native OTLP exporters point at.
 *
 * Standard OTLP/HTTP exporters append /v1/logs, /v1/traces and /v1/metrics to
 * this base themselves, so it must stay a base and not a signal route.
 *
 * @param config - Effective configuration.
 * @returns The OTLP base URL, or undefined when no backend is configured.
 */
export function otlpBaseUrl(config: AgentWatchConfig): string | undefined {
  if (config.otlpUrl) return config.otlpUrl;

  if (!config.endpoint) return undefined;

  return joinUrl(config.endpoint, OTLP_BASE_PATH);
}

/**
 * Where the pre-turn budget check asks its question.
 *
 * Derived from the same base as everything else, so a tenant configures one
 * endpoint; the override exists for the same reason the other two do — a
 * deployment that does not put every route behind one host.
 *
 * @param config - Effective configuration.
 * @returns The decision URL, or undefined when no backend is configured.
 */
export function enforcementUrl(config: AgentWatchConfig): string | undefined {
  if (config.enforcementUrl) return config.enforcementUrl;

  if (!config.endpoint) return undefined;

  return joinUrl(config.endpoint, ENFORCEMENT_PATH);
}

/**
 * Join a base URL and a path without doubling the separator.
 *
 * @param base - Base URL, with or without a trailing slash.
 * @param suffix - Path beginning with a slash.
 * @returns The joined URL.
 */
export function joinUrl(base: string, suffix: string): string {
  return base.replace(RE_TRAILING_SLASHES, '') + suffix;
}
