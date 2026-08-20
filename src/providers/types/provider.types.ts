import type { AgentWatchConfig } from '../../config/types/config.types.js';
import type { Env } from '../../core/types/core.types.js';
import type { AgentWatchEvent } from '../../events/types/events.types.js';
import type { AgentWatchPaths, InstallState } from '../../storage/types/storage.types.js';

/** What detection found out about one agent on this machine. */
export interface DetectionResult {
  readonly detected: boolean;
  /** Human-readable reasons, e.g. "~/.claude exists", "claude on PATH". */
  readonly evidence: readonly string[];
  readonly executablePath?: string;
  /** File AgentWatch hooks are (or would be) registered in. */
  readonly hookConfigPath: string;
  readonly hooksInstalled: boolean;
}

export interface SetupContext {
  readonly env: Env;
  readonly paths: AgentWatchPaths;
  readonly config: AgentWatchConfig;
  /** Command line agents will invoke, e.g. "/usr/local/bin/agentwatch hook --agent claude". */
  readonly hookCommand: string;
  /** What setup has recorded so far; an operation returns the next version. */
  readonly installState: InstallState;
}

export interface SetupOutcome {
  readonly ok: boolean;
  readonly changed: boolean;
  /** User-facing notes: required manual steps, skip reasons, errors. */
  readonly messages: readonly string[];
  /**
   * Install state after this operation, when it recorded anything.
   *
   * Returned rather than mutated in place: setup runs several operations per
   * agent and persists once at the end, and an operation that edited a shared
   * object would make the order of those calls part of the result.
   */
  readonly installState?: InstallState;
}

export interface HookContext {
  readonly env: Env;
  readonly config: AgentWatchConfig;
}

export interface ProviderHookResponse {
  /** Written verbatim to stdout; omit for protocol-safe silence. */
  readonly stdout?: string;
  readonly exitCode: number;
}

export interface NativeTelemetryStatus {
  readonly supported: boolean;
  /** Configured by AgentWatch. */
  readonly configured: boolean;
  /** Foreign telemetry configuration we refuse to overwrite. */
  readonly conflict?: string;
  readonly detail?: string;
}

export interface NativeTelemetryConfigurator {
  supported(env: Env): Promise<boolean>;
  inspect(context: SetupContext): Promise<NativeTelemetryStatus>;
  configure(context: SetupContext): Promise<SetupOutcome>;
  uninstall(context: SetupContext): Promise<SetupOutcome>;
}

export interface AgentProvider {
  readonly id: string;
  readonly displayName: string;
  detect(env: Env): Promise<DetectionResult>;
  installHooks(context: SetupContext): Promise<SetupOutcome>;
  uninstallHooks(context: SetupContext): Promise<SetupOutcome>;
  parseHookEvent(payload: unknown, context: HookContext): Promise<AgentWatchEvent[]>;
  getHookResponse(payload: unknown): ProviderHookResponse;
  /**
   * Working directory this payload was produced in, when the provider does not
   * report it as a top-level `cwd`. Git context, repository config and ticket
   * candidates all hang off this path, so a provider that nests it (Antigravity
   * reports `common.workspacePaths`) has to say where it is.
   */
  resolveCwd?(payload: unknown): string | undefined;
  readonly nativeTelemetry?: NativeTelemetryConfigurator;
}

/** How a tool call is classified for canonical event mapping. */
export type ToolKind = 'shell' | 'mcp' | 'file-read' | 'file-edit' | 'other';

/** Lifecycle position of a tool event. */
export type ToolStatus = 'started' | 'completed' | 'failed';

/** "mcp__server__tool" split into its parts. */
export interface McpToolName {
  readonly server?: string;
  readonly tool?: string;
}
