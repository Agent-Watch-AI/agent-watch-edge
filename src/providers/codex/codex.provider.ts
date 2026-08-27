import { hookRefusal } from '../shared/hook-refusal.js';
import type { AgentProvider, HookContext, ProviderHookResponse } from '../provider.js';
import { CODEX_PROMPT_SUBMIT_EVENTS } from './constants/codex.constants.js';
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
  /**
   * A budget refusal on `UserPromptSubmit`, in the only fields Codex's strict
   * parser accepts.
   */
  getBlockResponse: (payload: unknown, message: string): ProviderHookResponse | undefined =>
    hookRefusal(payload, CODEX_PROMPT_SUBMIT_EVENTS, { continue: false, stopReason: message, systemMessage: message }),
  nativeTelemetry: new CodexOtelConfigurator()
};
