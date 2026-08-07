import type { AgentProvider, HookContext, ProviderHookResponse } from '../provider.js';
import { detectClaude } from './claude.detect.js';
import { installClaudeHooks, uninstallClaudeHooks } from './claude.hooks.js';
import { parseClaudeHookEvent } from './claude.adapter.js';
import { ClaudeOtelConfigurator } from './claude.otel.js';

export const claudeProvider: AgentProvider = {
  id: 'claude',
  displayName: 'Claude Code',
  detect: detectClaude,
  installHooks: installClaudeHooks,
  uninstallHooks: uninstallClaudeHooks,
  parseHookEvent: async (payload: unknown, context: HookContext) => parseClaudeHookEvent(payload, context),
  /**
   * Exit 0 with empty stdout: stdout of UserPromptSubmit/SessionStart hooks is
   * injected into the model's context, so a passive observer must stay silent.
   */
  getHookResponse: (_payload: unknown): ProviderHookResponse => ({ exitCode: 0 }),
  nativeTelemetry: new ClaudeOtelConfigurator()
};
