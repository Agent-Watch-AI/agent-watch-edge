import { antigravityProvider } from './antigravity/antigravity.provider.js';
import { claudeProvider } from './claude/claude.provider.js';
import { codexProvider } from './codex/codex.provider.js';
import { cursorProvider } from './cursor/cursor.provider.js';
import { geminiProvider } from './gemini/gemini.provider.js';
import type { AgentProvider } from './types/provider.types.js';

/** Adding an agent = implementing AgentProvider and registering it here. */
export const providers: readonly AgentProvider[] = [claudeProvider, codexProvider, cursorProvider, geminiProvider, antigravityProvider];

/**
 * Index built once at module load: the hook path resolves a provider on every
 * single invocation, and a linear scan there is pure waste (STYLEGUIDE 3.2).
 */
const byId: ReadonlyMap<string, AgentProvider> = new Map(providers.map((provider) => [provider.id, provider]));

/**
 * The provider for an agent id.
 *
 * @param id - Agent id as passed to `agentwatch hook --agent <id>`.
 * @returns The provider, or undefined for an unknown agent.
 */
export function getProvider(id: string): AgentProvider | undefined {
  return byId.get(id);
}

/** Every agent id the CLI accepts, for help and error messages. */
export const providerIds: readonly string[] = providers.map((provider) => provider.id);
