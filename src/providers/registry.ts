import { antigravityProvider } from './antigravity/antigravity.provider.js';
import { claudeProvider } from './claude/claude.provider.js';
import { codexProvider } from './codex/codex.provider.js';
import { cursorProvider } from './cursor/cursor.provider.js';
import { geminiProvider } from './gemini/gemini.provider.js';
import type { AgentProvider } from './types/provider.types.js';

export { loadProvider, providerIds } from './loaders.js';

/**
 * Every provider, eagerly.
 *
 * For the commands that genuinely need all five — `setup`, `status`, `doctor`,
 * `uninstall`, `toggle` — each of which asks every agent about itself. The hook
 * path must not import this module: it needs one agent, and `loadProvider` in
 * `loaders.js` is how it gets exactly that one.
 *
 * Adding an agent = implementing AgentProvider, registering it here, and adding
 * its loader in `loaders.js`.
 */
export const providers: readonly AgentProvider[] = [claudeProvider, codexProvider, cursorProvider, geminiProvider, antigravityProvider];
