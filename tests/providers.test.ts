import { describe, expect, it } from 'vitest';
import { providers } from '../src/providers/registry.js';
import { loadProvider, providerIds } from '../src/providers/loaders.js';

describe('the two agent lists', () => {
  // `PROVIDER_LOADERS` in loaders.ts and `providers` in registry.ts are
  // maintained by hand and cannot be derived from each other — deriving the
  // eager list from the loaders would import every agent, which is the cost
  // loaders.ts exists to avoid. An agent in only one of them installs hooks
  // whose every invocation warns "unknown agent" and drops that agent's
  // telemetry, while `setup`, `status` and `doctor` all report success.
  it('name the same agents', () => {
    expect([...providerIds].sort()).toEqual(providers.map((provider) => provider.id).sort());
  });

  it('every registered agent is loadable by its own id', async () => {
    for (const provider of providers) {
      expect((await loadProvider(provider.id))?.id).toBe(provider.id);
    }
  });
});
