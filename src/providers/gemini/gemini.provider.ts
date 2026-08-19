import type { AgentProvider, HookContext, ProviderHookResponse } from '../provider.js';
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
  nativeTelemetry: new GeminiOtelConfigurator()
};
