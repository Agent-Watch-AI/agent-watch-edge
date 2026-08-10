import path from 'node:path';
import type { Env } from '../core/env.js';
import type { UsageBillingMode } from '../events/canonical-event.js';
import { readJsonFile } from '../storage/json-file.js';
import { sha256Hex } from '../events/event-id.js';

/**
 * How the developer pays for this agent: flat subscription (Claude Pro/Max,
 * ChatGPT plan) or per-token API billing. Detected from the agent's local
 * auth state; any read problem degrades to 'unknown'.
 */
export async function detectBillingMode(agentId: string, env: Env): Promise<UsageBillingMode> {
  try {
    if (agentId === 'claude') return await detectClaude(env);
    if (agentId === 'codex') return await detectCodex(env);
  } catch {
    // fall through
  }
  return 'unknown';
}

async function detectClaude(env: Env): Promise<UsageBillingMode> {
  // Bedrock/Vertex sessions always bill per token.
  if (isSet(env.vars['CLAUDE_CODE_USE_BEDROCK']) || isSet(env.vars['CLAUDE_CODE_USE_VERTEX'])) return 'api';
  const state = await readRecord(path.join(env.home, '.claude.json'));
  const apiKey = env.vars['ANTHROPIC_API_KEY'];
  if (isSet(apiKey) && envApiKeyUsed(state, apiKey!)) return 'api';
  const oauth = state?.['oauthAccount'];
  if (typeof oauth !== 'object' || oauth === null) return 'unknown';
  const billingType = (oauth as Record<string, unknown>)['billingType'];
  // Only positively recognized values are classified; anything else stays
  // unknown rather than being guessed.
  if (typeof billingType === 'string' && billingType.includes('subscription')) return 'subscription';
  return 'unknown';
}

/**
 * Claude Code only bills through an environment ANTHROPIC_API_KEY after the
 * user approves it (recorded in customApiKeyResponses); a key merely exported
 * for other tooling leaves the login's billing untouched. Approval entries
 * have varied across Claude Code versions (key hash prefix or key tail), so
 * both forms are recognized.
 */
function envApiKeyUsed(state: Record<string, unknown> | undefined, apiKey: string): boolean {
  // No local Claude state at all: the key is the only auth there is.
  if (!state) return true;
  const responses = asRecord(state['customApiKeyResponses']);
  const approved = Array.isArray(responses?.['approved']) ? responses['approved'] : [];
  const hash = sha256Hex(apiKey);
  return approved.some((entry) => typeof entry === 'string' && entry.length >= 8 && (hash.startsWith(entry) || apiKey.endsWith(entry)));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

async function detectCodex(env: Env): Promise<UsageBillingMode> {
  const auth = await readRecord(path.join(env.home, '.codex', 'auth.json'));
  if (!auth) return 'unknown';
  const mode = auth['auth_mode'];
  if (mode === 'chatgpt') return 'subscription';
  if (mode === 'apikey') return 'api';
  if (typeof auth['OPENAI_API_KEY'] === 'string' && auth['OPENAI_API_KEY'].length > 0) return 'api';
  return 'unknown';
}

async function readRecord(filePath: string): Promise<Record<string, unknown> | undefined> {
  const read = await readJsonFile(filePath);
  if (read.state !== 'ok' || typeof read.value !== 'object' || read.value === null || Array.isArray(read.value)) return undefined;
  return read.value as Record<string, unknown>;
}

function isSet(value: string | undefined): boolean {
  return typeof value === 'string' && value !== '' && value !== '0' && value.toLowerCase() !== 'false';
}
