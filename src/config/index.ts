/**
 * What the edge is configured to do: the global file, the repository overlay
 * on top of it, and the routes derived from the endpoint.
 */
export type {
  AgentWatchConfig,
  CaptureConfig,
  ConfigLoadResult,
  EffectiveConfig,
  MergedConfig,
  OtelConfig,
  OtelSignalName,
  RootedConfig,
  RootOverride
} from './types/config.types.js';

export { CONTENT_CAPTURE_FLAGS, OTEL_SIGNAL_NAMES, REPO_CONFIG_NAME, ROOTS_KEY } from './constants/config.constants.js';
export { captureSchema, configSchema, deliverySchema, emitSchema, otelSchema } from './schemas/config.schema.js';
export { defaultConfig, enabledSignalNames, eventsUrl, joinUrl, otelEnabled, otlpBaseUrl, parseOtelSignals } from './config.js';
export { ensureInstallationId, loadConfig, saveConfig } from './config-store.js';
export { findRepoConfigFile, loadEffectiveConfig, mergeRepoConfig } from './repo-config.js';
export { applyRootOverride, selectRoot } from './root-config.js';
