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
 * `null` is checked before truthiness, and that is not a formality: `null` is
 * how `deliverableUrl` records "a URL was written here and refused", and it
 * means something a *missing* field does not. Read by truthiness the two are
 * the same value, so a refused `roots[].eventsUrl` fell through to the
 * machine-global `endpoint` — the root's own destination being unusable is
 * exactly when it must not inherit the other tenant's. A consultant whose
 * `roots["/work/clientA"]` points `eventsUrl` at an internal `http:` collector
 * would have had every prompt, response and branch name under that directory
 * POSTed to their corporate backend under clientA's bearer.
 *
 * So a refusal is sticky where an absence is derivable. `otlpBaseUrl` holds the
 * same rule for the same reason; `enforcementUrl` deliberately does not, and
 * says why.
 *
 * @param config - Effective configuration.
 * @returns The events URL, or undefined when no backend is configured or the
 *   one configured here was refused.
 */
export function eventsUrl(config: AgentWatchConfig): string | undefined {
  if (config.eventsUrl === null) return undefined;

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
 * @returns The OTLP base URL, or undefined when no backend is configured or the
 *   one configured here was refused.
 */
export function otlpBaseUrl(config: AgentWatchConfig): string | undefined {
  // Refused, not absent — see `eventsUrl`. Worse here than there: `otel-headers`
  // hands the root's bearer to the agent's exporter only when the root's OTLP
  // base equals the machine's, so a refused root URL that fell back to the
  // machine's made those two equal and opened the guard.
  if (config.otlpUrl === null) return undefined;

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
 * The one accessor that does *not* hold `eventsUrl`'s rule, and deliberately.
 * There, refusing to derive is fail-safe: nothing leaves. Here it is fail-open
 * — `resolveEnforcement` answers `ALLOW` when there is no URL to ask, and
 * `enforcementWouldAsk` stops the caller even paying for the identity lookup —
 * so one `http:` line in a field nobody uses would switch every `block` cap on
 * the machine off silently. The security argument does not carry either: the
 * derived URL is a path on an `endpoint` already validated as `https:`, so
 * deriving sends the bearer nowhere it was not already going. `doctor` reports
 * the refused field as `configuration: fail` regardless.
 *
 * What that does not mean is that a root cannot reach the wrong host through
 * it. `enforcementUrl` has no `roots[]` field, so the URL is the machine's
 * while the bearer is the root's, and `requestDecision` sends them together: a
 * root that claims its own backend still asks the *machine's* enforcement
 * service about its tenant, and hands over that tenant's credential, the
 * developer id, the checkout path and the model to do it. This predates the
 * rule and the answer is a per-root enforcement URL, sketched in
 * `config.constants.ts`. Clearing it here instead would only bring the
 * fail-open back per root.
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

/**
 * Whether the machine has consented to tool arguments and results leaving it.
 *
 * Native provider logs carry both with no per-field filter, so this one answer
 * decides whether a Codex or Gemini exporter may be configured at all — and
 * `doctor` needs the same answer to explain why one was not.
 *
 * @param config - Effective configuration.
 * @returns True when global consent and both tool flags are on.
 */
export function toolContentConsented(config: AgentWatchConfig): boolean {
  return config.contentCaptureConsent && config.capture.toolInput && config.capture.toolOutput;
}
