import type { AgentProvider } from './provider.js';
import { claudeProvider } from './claude/claude.provider.js';
import { codexProvider } from './codex/codex.provider.js';

/** Adding an agent = implementing AgentProvider and registering it here. */
export const providers: AgentProvider[] = [claudeProvider, codexProvider];

export function getProvider(id: string): AgentProvider | undefined {
  return providers.find((provider) => provider.id === id);
}
