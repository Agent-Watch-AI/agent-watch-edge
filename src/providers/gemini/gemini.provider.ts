import { hookRefusal } from '../shared/hook-refusal.js';
import type { AgentProvider, HookContext, ProviderHookResponse } from '../provider.js';
import { GEMINI_PROMPT_EVENTS } from './constants/gemini.constants.js';
import { detectGemini } from './gemini.detect.js';
import { installGeminiHooks, uninstallGeminiHooks } from './gemini.hooks.js';
import { parseGeminiHookEvent } from './gemini.adapter.js';
import { GeminiOtelConfigurator } from './gemini.otel.js';

export const geminiProvider: AgentProvider = {
  id: 'gemini',
  displayName: 'Gemini CLI',
  detect: detectGemini,
  installHooks: installGeminiHooks,
  uninstallHooks: uninstallGeminiHooks,
  parseHookEvent: async (payload: unknown, context: HookContext) => parseGeminiHookEvent(payload, context),
  getHookResponse: (_payload: unknown): ProviderHookResponse => ({ exitCode: 0 }),
  /**
   * A budget refusal on the prompt hook: `decision: "deny"` makes Gemini CLI
   * discard the user's message and show the reason. The gate is the prompt-hook
   * set across both namings — exactly the hooks a refusal may travel on.
   */
  getBlockResponse: (payload: unknown, message: string): ProviderHookResponse | undefined =>
    hookRefusal(payload, GEMINI_PROMPT_EVENTS, { decision: 'deny', reason: message }),
  nativeTelemetry: new GeminiOtelConfigurator()
};
