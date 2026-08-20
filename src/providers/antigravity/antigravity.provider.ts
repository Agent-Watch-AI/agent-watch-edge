import type { AgentProvider, HookContext, ProviderHookResponse } from '../types/provider.types.js';
import { antigravityCwd, antigravityHookEvent, parseAntigravityHookEvent } from './antigravity.adapter.js';
import { detectAntigravity } from './antigravity.detect.js';
import { installAntigravityHooks, uninstallAntigravityHooks } from './antigravity.hooks.js';
import {
  ANTIGRAVITY_DISPLAY_NAME,
  ANTIGRAVITY_FALLBACK_DECISION,
  ANTIGRAVITY_HOOK_DECISIONS,
  ANTIGRAVITY_PROVIDER_ID
} from './constants/antigravity.constants.js';

export const antigravityProvider: AgentProvider = {
  id: ANTIGRAVITY_PROVIDER_ID,
  displayName: ANTIGRAVITY_DISPLAY_NAME,
  detect: detectAntigravity,
  installHooks: installAntigravityHooks,
  uninstallHooks: uninstallAntigravityHooks,
  parseHookEvent: async (payload: unknown, context: HookContext) => parseAntigravityHookEvent(payload, context),
  getHookResponse: (payload: unknown): ProviderHookResponse => {
    const hook = antigravityHookEvent(payload);
    const decision = hook === undefined ? ANTIGRAVITY_FALLBACK_DECISION : ANTIGRAVITY_HOOK_DECISIONS[hook];

    return { stdout: JSON.stringify(decision ?? {}), exitCode: 0 };
  },
  resolveCwd: antigravityCwd
  // No nativeTelemetry: Antigravity exposes no OTLP exporter configuration, so
  // there is no llm.call ledger source and turn summaries stay
  // usage_status=pending. Adding a configurator would claim a capability the
  // agent does not have.
};
