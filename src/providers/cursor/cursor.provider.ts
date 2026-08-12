import type { AgentProvider, HookContext, ProviderHookResponse } from '../provider.js';
import { detectCursor } from './cursor.detect.js';
import { installCursorHooks, uninstallCursorHooks } from './cursor.hooks.js';
import { parseCursorHookEvent } from './cursor.adapter.js';

export const cursorProvider: AgentProvider = {
  id: 'cursor',
  displayName: 'Cursor',
  detect: detectCursor,
  installHooks: installCursorHooks,
  uninstallHooks: uninstallCursorHooks,
  parseHookEvent: async (payload: unknown, context: HookContext) => parseCursorHookEvent(payload, context),
  /**
   * Cursor's before* hooks fail open and treat an absent `permission` field
   * as allow; exit 0 with empty stdout is the observation-only response that
   * never blocks the agent.
   */
  getHookResponse: (_payload: unknown): ProviderHookResponse => ({ exitCode: 0 })
  // No nativeTelemetry: Cursor has no OTel export, so there is no llm.call
  // ledger source. Turn summaries stay usage_status=pending until Cursor
  // enriches its transcripts with usage (see cursor-transcript.ts).
};
