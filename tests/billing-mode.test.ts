import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { makeTempEnv, writeJson, type TempWorld } from './helpers.js';
import { detectBillingMode } from '../src/billing/billing-mode.js';

describe('billing mode detection', () => {
  let world: TempWorld;

  beforeEach(async () => {
    world = await makeTempEnv();
  });
  afterEach(() => world.cleanup());

  describe('claude', () => {
    it('reports subscription for a claude.ai OAuth account with a subscription billing type', async () => {
      await writeJson(path.join(world.home, '.claude.json'), {
        oauthAccount: { emailAddress: 'dev@company.com', billingType: 'stripe_subscription' }
      });
      expect(await detectBillingMode('claude', world.env)).toBe('subscription');
    });

    it('keeps subscription when ANTHROPIC_API_KEY is exported but not approved for Claude Code', async () => {
      // A key exported for other tooling does not change how Claude Code
      // bills; only an approved key (customApiKeyResponses) does.
      await writeJson(path.join(world.home, '.claude.json'), {
        oauthAccount: { billingType: 'stripe_subscription' }
      });
      world.env.vars['ANTHROPIC_API_KEY'] = 'sk-ant-xxx';
      expect(await detectBillingMode('claude', world.env)).toBe('subscription');
    });

    it('reports api when the environment key was approved for Claude Code (key-tail entry)', async () => {
      const apiKey = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz';

      await writeJson(path.join(world.home, '.claude.json'), {
        oauthAccount: { billingType: 'stripe_subscription' },
        customApiKeyResponses: { approved: [apiKey.slice(-20)], rejected: [] }
      });
      world.env.vars['ANTHROPIC_API_KEY'] = apiKey;
      expect(await detectBillingMode('claude', world.env)).toBe('api');
    });

    it('reports api for an environment key when no Claude state exists at all', async () => {
      world.env.vars['ANTHROPIC_API_KEY'] = 'sk-ant-xxx';
      expect(await detectBillingMode('claude', world.env)).toBe('api');
    });

    it('reports api for Bedrock/Vertex sessions', async () => {
      world.env.vars['CLAUDE_CODE_USE_BEDROCK'] = '1';
      expect(await detectBillingMode('claude', world.env)).toBe('api');
    });

    it('reports unknown for an unrecognized billing type instead of guessing', async () => {
      await writeJson(path.join(world.home, '.claude.json'), {
        oauthAccount: { billingType: 'some_future_value' }
      });
      expect(await detectBillingMode('claude', world.env)).toBe('unknown');
    });

    it('reports unknown for an OAuth account without a billing type', async () => {
      await writeJson(path.join(world.home, '.claude.json'), {
        oauthAccount: { emailAddress: 'dev@company.com' }
      });
      expect(await detectBillingMode('claude', world.env)).toBe('unknown');
    });

    it('reports unknown without any auth signal', async () => {
      expect(await detectBillingMode('claude', world.env)).toBe('unknown');
    });
  });

  describe('codex', () => {
    it('reports subscription for ChatGPT login', async () => {
      await writeJson(path.join(world.home, '.codex', 'auth.json'), { auth_mode: 'chatgpt', tokens: {} });
      expect(await detectBillingMode('codex', world.env)).toBe('subscription');
    });

    it('reports api for API-key login', async () => {
      await writeJson(path.join(world.home, '.codex', 'auth.json'), { auth_mode: 'apikey', OPENAI_API_KEY: 'sk-xxx' });
      expect(await detectBillingMode('codex', world.env)).toBe('api');
    });

    it('reports api when only an API key is present without auth_mode', async () => {
      await writeJson(path.join(world.home, '.codex', 'auth.json'), { OPENAI_API_KEY: 'sk-xxx' });
      expect(await detectBillingMode('codex', world.env)).toBe('api');
    });

    it('reports unknown without an auth file', async () => {
      expect(await detectBillingMode('codex', world.env)).toBe('unknown');
    });
  });

  it('reports unknown for unrecognized agents', async () => {
    expect(await detectBillingMode('imaginary', world.env)).toBe('unknown');
  });
});
