import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHook } from '../src/cli/hook.js';
import { defaultConfig } from '../src/config/config.js';
import { loadConfig } from '../src/config/config-store.js';
import { resolvePaths } from '../src/storage/paths.js';
import { HttpTransport } from '../src/transport/http-transport.js';
import { MAX_PROMPT_TEXT_LENGTH, MAX_TOOL_INPUT_LENGTH } from '../src/turns/constants/turns.constants.js';
import { ANTIGRAVITY_COMMON, antigravityPreInvocation, antigravityStop } from './fixtures/antigravity.js';
import { CONTENT_CAPTURE_ON, makeTempEnv, readQueueEntries, writeJson, type TempWorld } from './helpers.js';

// Prompt text leaves the machine only under `capture.promptText` with consent;
// response text never does. The first block fails if either can reach disk or
// the outbound payload by any hook path without that flag — so its config turns
// on everything an older release honoured, `prompts: true` included. The second
// turns `promptText` and `toolInput` on and proves the trust boundary: harness
// blocks dropped, secrets scrubbed, text bounded, the home directory unnamed.

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

describe('prompt text is not collected without promptText', () => {
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

describe('prompt text and tool inputs under their opt-in flags', () => {
  let world: TempWorld;

  beforeEach(async () => { world = await makeTempEnv(); });
  afterEach(async () => {
    await world.cleanup();
    vi.restoreAllMocks();
  });

  const SECRET = 'sk-ant-api03-SECRETSECRETSECRET1234';
  const REMINDER = '<system-reminder>HARNESS-CANARY context the person never typed</system-reminder>';
  const TYPED = `update the Q3 budget in https://docs.google.com/spreadsheets/d/1AbC/edit key ${SECRET} `;

  /** One Claude turn with no repository: a prompt, a shell call, a connector call, a file in ~/Documents. */
  async function claudeTurn(config: Record<string, unknown>): Promise<{ summary: Record<string, unknown>; body: string }> {
    const paths = resolvePaths(world.env);
    const cwd = world.home;
    const base = { session_id: 's-1', prompt_id: 'p1', cwd };
    const budget = path.join(world.home, 'Documents', 'Sample Budget.xlsx');
    const payloads = [
      { ...base, hook_event_name: 'UserPromptSubmit', prompt: REMINDER + TYPED + 'x'.repeat(10_000) },
      { ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'u1', tool_input: { command: `curl https://sheets.googleapis.com/v4/spreadsheets/1AbC ${'y'.repeat(5000)}` }, tool_response: {} },
      { ...base, hook_event_name: 'PostToolUse', tool_name: 'mcp__gdrive__sheets_update', tool_use_id: 'u2', tool_input: { spreadsheetId: '1AbC', token: 'hunter2hunter2' }, tool_response: {} },
      { ...base, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_use_id: 'u3', tool_input: { file_path: budget, content: 'cells' }, tool_response: {} },
      { ...base, hook_event_name: 'Stop', last_assistant_message: RESPONSE }
    ];

    await writeJson(paths.configFile, { ...defaultConfig(), developerEmail: 'dev@company.com', ...config });

    for (const payload of payloads) {
      expect(await runHook('claude', { env: world.env, input: JSON.stringify(payload), writeStdout: () => {} })).toBe(0);
    }

    expect(await everythingOnDisk(paths.dataDir)).not.toContain('RESPONSE-CANARY');

    const events = (await readQueueEntries<{ event: Record<string, unknown> }>(paths.queueDir)).map((entry) => entry.event);
    const summary = events.find((event) => (event['event'] as { type?: string }).type === 'turn.summary')!;
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 202, json: async () => ({}) });
    const transport = new HttpTransport({ eventsUrl: 'https://example.com/v1/events', timeoutMs: 1000, fetchFn, capture: (await loadConfig(paths)).config.capture });

    await transport.send(events as never);

    return { summary, body: String(fetchFn.mock.calls[0]![1].body) };
  }

  it('sends the typed prompt, the shell and connector inputs and the home-relative file, scrubbed and bounded', async () => {
    const { summary, body } = await claudeTurn({ contentCaptureConsent: true, capture: { ...defaultConfig().capture, promptText: true, toolInput: true } });
    const text = summary['prompt_text'] as string;
    const inputs = summary['tool_inputs'] as Record<string, string>[];

    expect(text.startsWith('update the Q3 budget in https://docs.google.com/spreadsheets/d/1AbC/edit')).toBe(true);
    expect(text.length).toBe(MAX_PROMPT_TEXT_LENGTH);
    // The evidence still describes what the agent reported, harness block and all.
    expect(summary['prompt_evidence']).toMatchObject({ length: REMINDER.length + TYPED.length + 10_000 });
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toMatchObject({ tool: 'Bash' });
    expect(inputs[0]!['command']!.startsWith('curl https://sheets.googleapis.com/v4/spreadsheets/1AbC')).toBe(true);
    expect(inputs[0]!['command']!.length).toBe(MAX_TOOL_INPUT_LENGTH);
    expect(inputs[1]).toMatchObject({ tool: 'mcp__gdrive__sheets_update', server: 'gdrive', name: 'sheets_update' });
    expect(JSON.parse(inputs[1]!['arguments']!)).toMatchObject({ spreadsheetId: '1AbC', token: '[REDACTED]' });
    expect(summary['external_files_touched']).toEqual(['~/Documents/Sample Budget.xlsx']);
    // The repo-relative lists keep their meaning: nothing outside a checkout lands there.
    expect(summary['files_touched']).toEqual(['Sample Budget.xlsx']);

    for (const leak of ['HARNESS-CANARY', SECRET, 'hunter2', 'RESPONSE-CANARY', world.home]) expect(body).not.toContain(leak);
  });

  it.each([
    ['without consent', { contentCaptureConsent: false, capture: { ...defaultConfig().capture, promptText: true, toolInput: true } }],
    ['with the flags off', { contentCaptureConsent: true, capture: { ...defaultConfig().capture, files: false } }]
  ])('still sends the summary %s, with the content fields absent', async (_name, config) => {
    const { summary, body } = await claudeTurn(config);

    expect(summary['tool_calls']).toBe(3);
    expect(summary['prompt_text']).toBeUndefined();
    expect(summary['tool_inputs']).toBeUndefined();
    expect(body).toContain('turn.summary');

    for (const leak of ['update the Q3 budget', 'sheets.googleapis.com', 'spreadsheetId']) expect(body).not.toContain(leak);

    if (config.capture.files === false) expect(body).not.toContain('Sample Budget');
  });
});
