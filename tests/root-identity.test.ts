import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAuthBlock, buildCliContext, buildDeliveryStats, buildQueue } from '../src/cli/context.js';
import { defaultConfig } from '../src/config/config.js';
import { resolvePaths } from '../src/storage/paths.js';
import { BackendAuthBlock } from '../src/transport/auth-block.js';
import { identityPaths } from '../src/transport/queue-partition.js';
import { makeTempEnv, writeJson, type TempWorld } from './helpers.js';

const GLOBAL_TOKEN = 'aw_edge_global';
const ROOT_TOKEN = 'aw_edge_root';
const GLOBAL_BACKEND = 'https://global.example.com';
const ROOT_BACKEND = 'https://root.example.com';

// A command reading the machine-global token looked at the wrong identity's
// files. The hook path resolves its identity through `applyRootOverride`, so a
// 401 inside a root wrote `identity/<sha(rootToken)>/auth-block.json` and then
// took the early return on every hook in that repo — permanently, since a block
// has no timer. `status` read `<sha(globalToken)>` and printed nothing about it,
// and `doctor` probed with the global token, got a 2xx and cleared a block that
// was never the one standing. That root's telemetry stayed suspended with no
// diagnostic and no remedy short of deleting the file by hand.
describe('a command run inside a project root acts as that root', () => {
  let world: TempWorld;
  let repo: string;

  beforeEach(async () => {
    world = await makeTempEnv();
    repo = path.join(world.home, 'work', 'repo');
    await fs.mkdir(repo, { recursive: true });
    await writeJson(resolvePaths(world.env).configFile, {
      ...defaultConfig(),
      endpoint: GLOBAL_BACKEND,
      token: GLOBAL_TOKEN,
      roots: { [repo]: { endpoint: ROOT_BACKEND, token: ROOT_TOKEN } }
    });
  });

  afterEach(() => world.cleanup());

  /** The context a command gets when it is run from `cwd`. */
  async function contextIn(cwd: string) {
    return buildCliContext({ ...world.env, cwd });
  }

  it('reads the block the hooks in that root raised, and not the global one', async () => {
    const paths = resolvePaths(world.env);

    // Exactly what `hook-pipeline.deliver` writes on a 401 under the root token.
    await new BackendAuthBlock(identityPaths(paths, ROOT_TOKEN).authBlockFile).raise(ROOT_BACKEND, 401);

    const inRoot = await contextIn(repo);

    expect(inRoot.identityRoot).toBe(repo);
    expect((await buildAuthBlock(inRoot).active(ROOT_BACKEND))?.status).toBe(401);

    // And the machine-global identity is untouched by it: this is a per-root
    // suspension, not a machine-wide one.
    const elsewhere = await contextIn(world.home);

    expect(elsewhere.identityRoot).toBeUndefined();
    expect(await buildAuthBlock(elsewhere).active(GLOBAL_BACKEND)).toBeUndefined();
  });

  it('clears that same block when the credential proves itself good', async () => {
    const paths = resolvePaths(world.env);
    const raised = new BackendAuthBlock(identityPaths(paths, ROOT_TOKEN).authBlockFile);

    await raised.raise(ROOT_BACKEND, 401);

    // What `doctor` does after its authenticated probe answers 2xx.
    await buildAuthBlock(await contextIn(repo)).clear();

    expect(await raised.active(ROOT_BACKEND)).toBeUndefined();
  });

  it('owns the root identity\'s backlog and loss tally, not the machine\'s', async () => {
    const paths = resolvePaths(world.env);
    const inRoot = await contextIn(repo);
    const queue = await buildQueue(inRoot);

    // maxEvents is 1000 by default, so nothing is dropped for the bound here;
    // this is about which partition the entry lands in and which tally would
    // hear about it.
    await queue.enqueue([{ id: 'evt_root', event: { type: 'turn.summary' } } as never], ROOT_BACKEND);

    const rootFiles = await fs.readdir(identityPaths(paths, ROOT_TOKEN).queueDir);

    expect(rootFiles.filter((name) => name.endsWith('.json'))).toHaveLength(1);
    await expect(fs.readdir(identityPaths(paths, GLOBAL_TOKEN).queueDir)).rejects.toThrow();

    // The tally the queue reports its bound losses to is the root's, so a
    // `status` run here is reading the same file the hooks here write.
    await buildDeliveryStats(inRoot).recordDropped(3);

    expect(await buildDeliveryStats(inRoot).read()).toMatchObject({ totalDropped: 3 });
    expect(await buildDeliveryStats(await contextIn(world.home)).read()).toBeUndefined();
  });
});
