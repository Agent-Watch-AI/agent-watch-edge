import type { z } from 'zod';
import type { captureSchema, configSchema, enforcementSchema, otelSchema, rootOverrideSchema } from '../schemas/config.schema.js';

export type CaptureConfig = z.infer<typeof captureSchema>;
export type OtelConfig = z.infer<typeof otelSchema>;
export type EnforcementConfig = z.infer<typeof enforcementSchema>;
export type AgentWatchConfig = z.infer<typeof configSchema>;
export type RootOverride = z.infer<typeof rootOverrideSchema>;

/** A config with one project root's identity applied, and which root won. */
export interface RootedConfig {
  readonly config: AgentWatchConfig;
  readonly root?: { readonly path: string; readonly override: RootOverride };
}

/** Name of one native OTLP signal. */
export type OtelSignalName = keyof OtelConfig;

/**
 * Outcome of loading the global config. `missing` and `invalid` both carry a
 * usable fallback: hooks must keep running with a broken config file, just
 * with content capture off.
 */
export type ConfigLoadResult =
  | { readonly state: 'ok'; readonly config: AgentWatchConfig }
  | { readonly state: 'missing'; readonly config: AgentWatchConfig }
  | { readonly state: 'invalid'; readonly error: string; readonly config: AgentWatchConfig };

/** A config with the repository overlay applied, and what was refused. */
export interface MergedConfig {
  readonly config: AgentWatchConfig;
  readonly warnings: readonly string[];
}

export interface EffectiveConfig extends MergedConfig {
  /** Path of the applied repo overrides file, when one was found. */
  readonly repoConfigFile?: string;
  /** Project root whose identity was applied, when one matched. */
  readonly rootPath?: string;
}
