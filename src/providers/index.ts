/**
 * One AgentProvider per coding agent: how to detect it, how to register hooks
 * and native telemetry in its own config, and how to translate its hook
 * payloads into canonical events.
 */
export type {
  AgentProvider,
  DetectionResult,
  HookContext,
  McpToolName,
  NativeTelemetryConfigurator,
  NativeTelemetryStatus,
  ProviderHookResponse,
  SetupContext,
  SetupOutcome,
  ToolKind,
  ToolStatus
} from './types/provider.types.js';

export { HOOK_COMMAND_MARKER, KNOWN_AGENT_IDS } from './constants/provider.constants.js';
export { isAgentWatchHookCommand } from './provider.js';
export { getProvider, providerIds, providers } from './registry.js';
export { classifyTool, contentEvidence, extractCommand, extractFilePath, parseMcpToolName, toolCompleteType, toolStartType } from './shared/tooling.js';
export { baseEvent, filePathPatch, promptPatch, providerPatch, responsePatch, toolPatch, withPatch } from './shared/event-builder.js';
export { registerOurHandlers, stripOurHandlers, sweepUnregisteredEvents, withHooksBlock, writeJsonValidated } from './shared/hook-config.js';
export { hookRefusal } from './shared/hook-refusal.js';
export { withHookInstall, withOtelInstall, withoutAgent, withoutHookInstall, withoutOtelInstall } from './shared/install-record.js';
