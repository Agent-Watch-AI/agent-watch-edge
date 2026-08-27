import { hookRefusal } from '../shared/hook-refusal.js';
import type { AgentProvider, HookContext, ProviderHookResponse } from '../provider.js';
import { CLAUDE_PROMPT_SUBMIT_EVENTS } from './constants/claude.constants.js';
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
  /**
   * A budget refusal on `UserPromptSubmit`: Claude erases the prompt and shows
   * the reason. Any other hook gets nothing, so no tool call and no session
   * event can be refused by this path.
   */
  getBlockResponse: (payload: unknown, message: string): ProviderHookResponse | undefined =>
    hookRefusal(payload, CLAUDE_PROMPT_SUBMIT_EVENTS, { decision: 'block', reason: message }),
  nativeTelemetry: new ClaudeOtelConfigurator()
};
