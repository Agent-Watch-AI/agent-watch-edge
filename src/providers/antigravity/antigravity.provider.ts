import type { AgentProvider, HookContext, ProviderHookResponse } from '../provider.js';
import { detectAntigravity } from './antigravity.detect.js';
import { installAntigravityHooks, uninstallAntigravityHooks } from './antigravity.hooks.js';
import { antigravityCwd, antigravityHookEvent, parseAntigravityHookEvent } from './antigravity.adapter.js';

/**
 * `decision` is a required field of both `PreToolHookResult` and
 * `StopHookResult`, and Antigravity has a dedicated `PreToolHookDeniedError`
 * for a pre-tool hook that does not answer. A single `{}` for every hook — the
 * previous behavior — therefore did not merely fail to observe: it blocked
 * every tool call the agent tried to make. The remaining result messages
 * (`PostToolHookResult`, the invocation hooks, `SessionStartHookResult`) carry
 * no decision, so silence is correct for those.
 */
const HOOK_DECISION: Record<string, Record<string, string>> = {
  PreToolUse: { decision: 'allow' },
  Stop: { decision: 'stop' }
};

export const antigravityProvider: AgentProvider = {
  id: 'antigravity',
  displayName: 'Google Antigravity',
  detect: detectAntigravity,
  installHooks: installAntigravityHooks,
  uninstallHooks: uninstallAntigravityHooks,
  parseHookEvent: async (payload: unknown, context: HookContext) => parseAntigravityHookEvent(payload, context),
  getHookResponse: (payload: unknown): ProviderHookResponse => {
    const hook = antigravityHookEvent(payload);
    // An unreadable payload is answered as a pre-tool allow: the one payload
    // shape we cannot classify is also the one where staying silent would
    // stall the agent, and telemetry must never do that.
    const decision = hook === undefined ? HOOK_DECISION['PreToolUse'] : HOOK_DECISION[hook];
    return { stdout: JSON.stringify(decision ?? {}), exitCode: 0 };
  },
  resolveCwd: antigravityCwd
  // No nativeTelemetry: Antigravity exposes no OTLP exporter configuration, so
  // there is no llm.call ledger source and turn summaries stay
  // usage_status=pending. Adding a configurator would claim a capability the
  // agent does not have.
};
