import type { AgentProvider, HookContext, ProviderHookResponse } from '../provider.js';
import { detectCodex } from './codex.detect.js';
import { installCodexHooks, uninstallCodexHooks } from './codex.hooks.js';
import { parseCodexHookEvent } from './codex.adapter.js';
import { CodexOtelConfigurator } from './codex.otel.js';

export const codexProvider: AgentProvider = {
  id: 'codex',
  displayName: 'OpenAI Codex',
  detect: detectCodex,
  installHooks: installCodexHooks,
  uninstallHooks: uninstallCodexHooks,
  parseHookEvent: async (payload: unknown, context: HookContext) => parseCodexHookEvent(payload, context),
  /**
   * Codex treats empty stdout + exit 0 as explicit success (verified in
   * output_parser.rs). Anything else risks tripping its strict JSON parser.
   */
  getHookResponse: (_payload: unknown): ProviderHookResponse => ({ exitCode: 0 }),
  nativeTelemetry: new CodexOtelConfigurator()
};
