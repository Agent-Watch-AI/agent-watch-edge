import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { applyRootOverride, selectRoot, servesMultipleIdentities } from '../src/config/root-config.js';
import { configSchema } from '../src/config/schemas/config.schema.js';
import { loadEffectiveConfig } from '../src/config/repo-config.js';
import { defaultConfig, enforcementUrl, eventsUrl, otlpBaseUrl } from '../src/config/config.js';
import { resolvePaths } from '../src/storage/paths.js';
import { makeTempEnv, writeJson, type TempWorld } from './helpers.js';

const TRIP = '/Users/dev/tripPlanner';
const WATCH = '/Users/dev/agent watch';

describe('project root selection', () => {
  it('matches on path segments, not on the raw string', () => {
    const roots = { [TRIP]: { token: 'trip' } };

    expect(selectRoot(roots, TRIP)?.path).toBe(TRIP);
    expect(selectRoot(roots, path.join(TRIP, 'src', 'deep'))?.path).toBe(TRIP);
    // The prefix trap: a sibling whose name merely starts with a root's name.
    expect(selectRoot(roots, '/Users/dev/tripPlannerOld')).toBeUndefined();
    expect(selectRoot(roots, '/Users/dev/other')).toBeUndefined();
  });

  it('gives the longest root the win, so a nested checkout beats its workspace', () => {
    const nested = path.join(WATCH, 'code', 'vendor');
    const roots = { [WATCH]: { token: 'watch' }, [nested]: { token: 'vendor' } };

    expect(selectRoot(roots, path.join(nested, 'src'))?.override.token).toBe('vendor');
    expect(selectRoot(roots, path.join(WATCH, 'code'))?.override.token).toBe('watch');
  });

  it('ignores a relative root, which would resolve against wherever the hook started', () => {
    expect(selectRoot({ './relative': { token: 'nope' } }, path.resolve('./relative'))).toBeUndefined();
  });

  it('leaves the machine identity alone outside every root, and strips roots from the result', () => {
    const global = { ...defaultConfig(), token: 'machine', roots: { [TRIP]: { token: 'trip' } } };

    const outside = applyRootOverride(global, '/Users/dev/elsewhere');
    const inside = applyRootOverride(global, path.join(TRIP, 'src'));

    expect(outside.config.token).toBe('machine');
    expect(inside.config.token).toBe('trip');
    // Every consumer downstream wants one identity, and `agentwatch config`
    // would otherwise print the other tenants' tokens beside the redacted one.
    expect(outside.config.roots).toBeUndefined();
    expect(inside.config.roots).toBeUndefined();
  });

  it('overlays only the keys a root actually sets', () => {
    const global = { ...defaultConfig(), token: 'machine', developerEmail: 'me@company.com', endpoint: 'https://machine.example.com' };
    const rooted = applyRootOverride({ ...global, roots: { [TRIP]: { token: 'trip' } } }, TRIP);

    expect(rooted.config.token).toBe('trip');
    expect(rooted.config.developerEmail).toBe('me@company.com');
    expect(rooted.config.endpoint).toBe('https://machine.example.com');
  });
});

describe('how many identities a machine sends as', () => {
  it('counts distinct bearers, not the presence of a roots block', () => {
    const base = { ...defaultConfig(), token: 'machine' };

    expect(servesMultipleIdentities(base)).toBe(false);
    // A root that only changes the developer email is the same tenant.
    expect(servesMultipleIdentities({ ...base, roots: { [TRIP]: { developerEmail: 'me@trip.example' } } })).toBe(false);
    expect(servesMultipleIdentities({ ...base, roots: { [TRIP]: { token: 'machine' } } })).toBe(false);
    expect(servesMultipleIdentities({ ...base, roots: { [TRIP]: { token: 'trip' } } })).toBe(true);
    expect(servesMultipleIdentities({ ...defaultConfig(), roots: { [TRIP]: { token: 'trip' } } })).toBe(false);
  });
});

describe('roots reached through a symlink', () => {
  let world: TempWorld;

  beforeEach(async () => {
    world = await makeTempEnv();
  });
  afterEach(() => world.cleanup());

  it('matches the real directory whichever spelling the config or the agent uses', async () => {
    const real = path.join(world.home, 'volumes', 'work', 'trip');
    const alias = path.join(world.home, 'work');

    await fs.mkdir(path.join(real, 'src'), { recursive: true });
    await fs.symlink(path.join(world.home, 'volumes', 'work'), alias);

    const byAlias = { [path.join(alias, 'trip')]: { token: 'trip' } };
    const byReal = { [real]: { token: 'trip' } };

    // Configured through the symlink, reported by the agent as the real path.
    expect(selectRoot(byAlias, path.join(real, 'src'))?.override.token).toBe('trip');
    // And the other way round.
    expect(selectRoot(byReal, path.join(alias, 'trip', 'src'))?.override.token).toBe('trip');
    // The root is named the way the user wrote it, not the way the kernel spells it.
    expect(selectRoot(byAlias, path.join(real, 'src'))?.path).toBe(path.join(alias, 'trip'));
  });
});

describe('effective config for two tenants on one machine', () => {
  let world: TempWorld;

  beforeEach(async () => {
    world = await makeTempEnv();
  });
  afterEach(() => world.cleanup());

  it('resolves each project to its own tenant, and a repo file still cannot move one', async () => {
    const paths = resolvePaths(world.env);
    const trip = path.join(world.home, 'tripPlanner');
    const watch = path.join(world.home, 'agent-watch');

    await fs.mkdir(path.join(trip, 'src'), { recursive: true });
    await fs.mkdir(watch, { recursive: true });
    await writeJson(paths.configFile, {
      ...defaultConfig(),
      endpoint: 'https://backend.example.com',
      token: 'machine-token',
      roots: {
        [trip]: { token: 'trip-token', developerEmail: 'yonatan@tripplanner.example' },
        [watch]: { token: 'watch-token' }
      }
    });
    // A committed repo file inside one project tries to claim the other's token.
    await writeJson(path.join(trip, '.agentwatch.json'), { token: 'watch-token', capture: { prompts: false } });

    const fromTrip = await loadEffectiveConfig(paths, path.join(trip, 'src'));
    const fromWatch = await loadEffectiveConfig(paths, watch);
    const fromElsewhere = await loadEffectiveConfig(paths, world.home);

    expect(fromTrip.config.token).toBe('trip-token');
    expect(fromTrip.config.developerEmail).toBe('yonatan@tripplanner.example');
    expect(fromTrip.rootPath).toBe(trip);
    expect(fromWatch.config.token).toBe('watch-token');
    expect(fromElsewhere.config.token).toBe('machine-token');
    expect(fromElsewhere.rootPath).toBeUndefined();

    // The repo file narrowed capture, which it may, and was refused the token.
    expect(fromTrip.config.capture.prompts).toBe(false);
    expect(fromTrip.warnings.join(' ')).toMatch(/"token" is global-only/);

    // Both tenants share one backend; only the bearer differs.
    expect(fromTrip.config.endpoint).toBe('https://backend.example.com');
    expect(fromWatch.config.endpoint).toBe('https://backend.example.com');
  });
});

// The three URL fields have to move as a set. `eventsUrl()` and `otlpBaseUrl()`
// prefer their own field and only fall back to `endpoint`, so a machine that
// splits its routes across hosts — the deployment the overrides exist for — laid
// two explicit strings under every root, and they won before the root's own
// endpoint was ever consulted. Every prompt, response and branch name under that
// root went to the machine's ingest under the root's own bearer, and the
// `otel-headers` guard (which withholds the bearer when the two OTLP bases
// differ) compared equal, so the credential crossed too.
describe('a root that names a backend does not inherit the machine\'s routes', () => {
  const REPO = '/Users/dev/clientA';

  function rooted(override: Record<string, unknown>) {
    const config = configSchema.parse({
      endpoint: 'https://mycorp.example.com',
      eventsUrl: 'https://ingest.mycorp.example.com/v1/events',
      otlpUrl: 'https://otlp.mycorp.example.com',
      token: 'tok-machine',
      roots: { [REPO]: override }
    });

    return { global: config, config: applyRootOverride(config, REPO).config };
  }

  it('sends nowhere when the root\'s own endpoint was refused', () => {
    const { global, config } = rooted({ endpoint: 'http://collector.clienta.internal', token: 'tok-client-a' });

    expect(config.token).toBe('tok-client-a');
    expect(eventsUrl(config)).toBeUndefined();
    expect(otlpBaseUrl(config)).toBeUndefined();
    expect(otlpBaseUrl(config)).not.toBe(otlpBaseUrl(global));
  });

  // The same leak with no refusal involved: a root with a perfectly good
  // endpoint of its own still shipped to the machine's explicit routes.
  it('derives from the root\'s own endpoint, not the machine\'s routes', () => {
    const { global, config } = rooted({ endpoint: 'https://clienta.example.com', token: 'tok-client-a' });

    expect(eventsUrl(config)).toBe('https://clienta.example.com/v1/events');
    expect(otlpBaseUrl(config)).not.toBe(otlpBaseUrl(global));
  });

  // A root that names no URL is a second seat on the same backend, which is
  // what most `roots[]` entries are. It must still inherit the destination.
  it('leaves the machine\'s routes alone for a root that names no backend', () => {
    const { global, config } = rooted({ token: 'tok-second-seat' });

    expect(eventsUrl(config)).toBe(eventsUrl(global));
    expect(otlpBaseUrl(config)).toBe(otlpBaseUrl(global));
  });
});

// `enforcementUrl` is the one accessor a refusal must not make sticky: no URL
// to ask means `resolveEnforcement` answers ALLOW, so one `http:` line in a
// field nobody uses would switch every `block` cap on the machine off silently.
describe('a refused enforcement URL does not switch enforcement off', () => {
  it('derives the decision route from the validated endpoint', () => {
    const config = configSchema.parse({
      endpoint: 'https://backend.example.com',
      enforcementUrl: 'http://enforcement.corp/v1/decision',
      token: 'tok'
    });

    expect(config.enforcementUrl).toBeNull();
    expect(enforcementUrl(config)).toContain('https://backend.example.com');
  });
});
