import type { Env } from '../core/env.js';
import type { AgentWatchConfig } from '../config/config.js';
import type { AgentWatchEvent } from '../events/canonical-event.js';
import type { AgentWatchPaths } from '../storage/paths.js';
import type { InstallState } from '../storage/install-state.js';

export interface DetectionResult {
  detected: boolean;
  /** Human-readable reasons, e.g. "~/.claude exists", "claude on PATH". */
  evidence: string[];
  executablePath?: string;
  /** File AgentWatch hooks are (or would be) registered in. */
  hookConfigPath: string;
  hooksInstalled: boolean;
}

export interface SetupContext {
  env: Env;
  paths: AgentWatchPaths;
  config: AgentWatchConfig;
  /** Command line agents will invoke, e.g. "/usr/local/bin/agentwatch hook --agent claude". */
  hookCommand: string;
  /** Mutated in place by install/uninstall; persisted by the caller. */
  installState: InstallState;
}

export interface SetupOutcome {
  ok: boolean;
  changed: boolean;
  /** User-facing notes: required manual steps, skip reasons, errors. */
  messages: string[];
}

export interface HookContext {
  env: Env;
  config: AgentWatchConfig;
}

export interface ProviderHookResponse {
  /** Written verbatim to stdout; omit for protocol-safe silence. */
  stdout?: string;
  exitCode: number;
}

export interface NativeTelemetryStatus {
  supported: boolean;
  /** Configured by AgentWatch. */
  configured: boolean;
  /** Foreign telemetry configuration we refuse to overwrite. */
  conflict?: string;
  detail?: string;
}

export interface NativeTelemetryConfigurator {
  supported(env: Env): Promise<boolean>;
  inspect(context: SetupContext): Promise<NativeTelemetryStatus>;
  configure(context: SetupContext): Promise<SetupOutcome>;
  uninstall(context: SetupContext): Promise<SetupOutcome>;
}

export interface AgentProvider {
  id: string;
  displayName: string;
  detect(env: Env): Promise<DetectionResult>;
  installHooks(context: SetupContext): Promise<SetupOutcome>;
  uninstallHooks(context: SetupContext): Promise<SetupOutcome>;
  parseHookEvent(payload: unknown, context: HookContext): Promise<AgentWatchEvent[]>;
  getHookResponse(payload: unknown): ProviderHookResponse;
  nativeTelemetry?: NativeTelemetryConfigurator;
}

/** Substring identifying AgentWatch-owned hook entries in agent configs. */
export const HOOK_COMMAND_MARKER = 'agentwatch';
