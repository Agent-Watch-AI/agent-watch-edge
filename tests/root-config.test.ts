import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { makeTempEnv, writeJson, type TempWorld } from './helpers.js';
import { applyRootOverride, selectRoot } from '../src/config/root-config.js';
import { loadEffectiveConfig } from '../src/config/repo-config.js';
import { defaultConfig } from '../src/config/config.js';
import { resolvePaths } from '../src/storage/paths.js';

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
