import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHook } from '../src/cli/hook.js';
import { defaultConfig } from '../src/config/config.js';
import { loadConfig } from '../src/config/config-store.js';
import { resolvePaths } from '../src/storage/paths.js';
import { HttpTransport } from '../src/transport/http-transport.js';
import { ANTIGRAVITY_COMMON, antigravityPreInvocation, antigravityStop } from './fixtures/antigravity.js';
import { CONTENT_CAPTURE_ON, makeTempEnv, readQueueEntries, writeJson, type TempWorld } from './helpers.js';

// Developer prompts are never collected. This is the one test that fails if prompt
// or response text can reach disk or the outbound payload by any hook path,
// whatever the config says — so the config below turns on everything an older
// release honoured.

const PROMPT = 'PROMPT-CANARY-7f3a rotate the prod key';
const RESPONSE = 'RESPONSE-CANARY-9c1e rotated it';

const LEGACY_ALL_ON = {
  ...defaultConfig(),
  developerEmail: 'dev@company.com',
  contentCaptureConsent: true,
  capture: { ...defaultConfig().capture, ...CONTENT_CAPTURE_ON, prompts: true, responses: true }
};

/** One prompt→response turn per agent, in each agent's own hook vocabulary. */
function turns(cwd: string): Record<string, unknown[]> {
  const cursor = { conversation_id: 'c-1', generation_id: 'g-1', cwd };
  const antigravity = { ...ANTIGRAVITY_COMMON, lastUserInput: PROMPT };

  return {
    claude: [
      { hook_event_name: 'UserPromptSubmit', session_id: 's-claude', prompt_id: 'p1', prompt: PROMPT, cwd },
      { hook_event_name: 'Stop', session_id: 's-claude', prompt_id: 'p1', last_assistant_message: RESPONSE, cwd }
    ],
    codex: [
      { hook_event_name: 'UserPromptSubmit', session_id: 's-codex', turn_id: 't1', prompt: PROMPT, cwd },
      { hook_event_name: 'Stop', session_id: 's-codex', turn_id: 't1', last_assistant_message: RESPONSE, cwd }
    ],
    gemini: [
      { hook_event_name: 'BeforeAgent', session_id: 's-gemini', prompt: PROMPT, cwd },
      { hook_event_name: 'AfterAgent', session_id: 's-gemini', prompt_response: RESPONSE, cwd }
    ],
    cursor: [
      { ...cursor, hook_event_name: 'beforeSubmitPrompt', prompt: PROMPT },
      { ...cursor, hook_event_name: 'afterAgentResponse', text: RESPONSE },
      { ...cursor, hook_event_name: 'stop', status: 'completed' }
    ],
    antigravity: [antigravityPreInvocation(1, antigravity), antigravityStop({ finalModelOutput: RESPONSE }, antigravity)]
  };
}

/** Every file under a directory, concatenated: the queue and turn state both live here. */
async function everythingOnDisk(dir: string): Promise<string> {
  // String paths, not Dirents: `Dirent.parentPath` is Node >= 20.12 and engines says >= 20.
  const names = await fs.readdir(dir, { recursive: true }).catch(() => [] as string[]);
  // A directory rejects with EISDIR and contributes nothing.
  const contents = await Promise.all(names.map((name) => fs.readFile(path.join(dir, name), 'utf8').catch(() => '')));

  return contents.join('\n');
}

describe('developer prompts are never collected', () => {
  let world: TempWorld;

  beforeEach(async () => { world = await makeTempEnv(); });
  afterEach(async () => {
    await world.cleanup();
    vi.restoreAllMocks();
  });

  it.each(Object.keys(turns('')))('%s: no prompt or response text on disk or in the outbound payload, under a legacy all-on config', async (agent) => {
    const paths = resolvePaths(world.env);

    await writeJson(paths.configFile, LEGACY_ALL_ON);

    for (const payload of turns(world.home)[agent]!) {
      expect(await runHook(agent, { env: world.env, input: JSON.stringify(payload), writeStdout: () => {} })).toBe(0);

      // After every hook, not only at the end: a Stop consumes turn state, so
      // text written mid-turn would otherwise be gone before anyone looked.
      const onDisk = await everythingOnDisk(paths.dataDir);

      expect(onDisk).not.toContain('PROMPT-CANARY');
      expect(onDisk).not.toContain('RESPONSE-CANARY');
    }

    const events = (await readQueueEntries<{ event: Record<string, unknown> }>(paths.queueDir)).map((entry) => entry.event);
    const summary = events.find((event) => (event['event'] as { type?: string }).type === 'turn.summary');

    // Not vacuous: the turn was recorded, with the prompt's length.
    expect(summary?.['prompt_evidence']).toMatchObject({ length: PROMPT.length });

    // The last gate on its own: a summary an older release queued with text in it.
    const legacy = { ...summary, prompt: PROMPT, response: RESPONSE };
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 202, json: async () => ({}) });
    const transport = new HttpTransport({ eventsUrl: 'https://example.com/v1/events', timeoutMs: 1000, fetchFn, capture: (await loadConfig(paths)).config.capture });

    await transport.send([...events, legacy] as never);
    const body = String(fetchFn.mock.calls[0]![1].body);

    expect(body).toContain('turn.summary');
    expect(body).not.toContain('PROMPT-CANARY');
    expect(body).not.toContain('RESPONSE-CANARY');
  });
});
