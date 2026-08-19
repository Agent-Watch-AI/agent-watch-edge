import type { AgentProvider } from './provider.js';
import { claudeProvider } from './claude/claude.provider.js';
import { codexProvider } from './codex/codex.provider.js';
import { cursorProvider } from './cursor/cursor.provider.js';
import { geminiProvider } from './gemini/gemini.provider.js';
import { antigravityProvider } from './antigravity/antigravity.provider.js';

/** Adding an agent = implementing AgentProvider and registering it here. */
export const providers: AgentProvider[] = [claudeProvider, codexProvider, cursorProvider, geminiProvider, antigravityProvider];

export function getProvider(id: string): AgentProvider | undefined {
  return providers.find((provider) => provider.id === id);
}
