import type { AgentProvider } from './types/provider.types.js';

/**
 * One dynamic import per agent, so a hook loads the agent it was invoked for
 * and no other.
 *
 * The hook path resolves exactly one provider per invocation, and importing the
 * eager registry pulled in all five with their adapters, schemas and constants
 * — measurably the largest single cost in the hook's own import graph, paid ten
 * to fifteen times per turn on every developer's machine. `cli.ts` already goes
 * to trouble to lazy-import command modules "so the hook path does not pay
 * their startup"; this is the same argument applied to the agents.
 *
 * The literal is the single source of the supported agent ids: `registry.ts`
 * builds its eager list from these keys, so a sixth agent is one entry here.
 */
const PROVIDER_LOADERS: Readonly<Record<string, () => Promise<AgentProvider>>> = {
  claude: async () => (await import('./claude/claude.provider.js')).claudeProvider,
  codex: async () => (await import('./codex/codex.provider.js')).codexProvider,
  cursor: async () => (await import('./cursor/cursor.provider.js')).cursorProvider,
  gemini: async () => (await import('./gemini/gemini.provider.js')).geminiProvider,
  antigravity: async () => (await import('./antigravity/antigravity.provider.js')).antigravityProvider
};

/** Every agent id the CLI accepts, for help and error messages. */
export const providerIds: readonly string[] = Object.keys(PROVIDER_LOADERS);

/**
 * The provider for an agent id, loading only that agent's code.
 *
 * @param id - Agent id as passed to `agentwatch hook --agent <id>`.
 * @returns The provider, or undefined for an unknown agent.
 */
export async function loadProvider(id: string): Promise<AgentProvider | undefined> {
  const load = PROVIDER_LOADERS[id];

  if (!load) return undefined;

  return load();
}
