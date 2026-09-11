import { execFileSync } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readTurnUsage } from '../src/turns/claude-transcript.js';
import { SESSION_MODEL_FILE } from '../src/turns/constants/turns.constants.js';
import { SWEEP_MARKER_FILE } from '../src/storage/constants/storage.constants.js';
import { parseCodexHookEvent } from '../src/providers/codex/codex.adapter.js';
import { configSchema } from '../src/config/schemas/config.schema.js';
import { trackTurn } from '../src/turns/turn-tracker.js';
import { TurnStateStore } from '../src/turns/turn-state.js';
import { buildTurnSummary } from '../src/turns/turn-summary.js';
import { runHook } from '../src/cli/hook.js';
import { resolvePaths } from '../src/storage/paths.js';
import { defaultConfig } from '../src/config/config.js';
import { codexSessionStart, codexStop, codexUserPromptSubmit } from './fixtures/codex.js';
import { CONTENT_CAPTURE_ON, makeTempEnv, queueEntryFiles, writeJson, type TempWorld } from './helpers.js';

describe('claude transcript usage', () => {
  let world: TempWorld;

  beforeEach(async () => {
    world = await makeTempEnv();
  });
  afterEach(() => world.cleanup());

  async function writeTranscript(lines: unknown[]): Promise<string> {
    const file = path.join(world.home, 'transcript.jsonl');

    await fs.writeFile(file, lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n'));

    return file;
  }

  it('sums assistant usage after the turn start, dedupes by message id and reports the model', async () => {
    const since = '2026-08-06T18:00:00.000Z';
    const file = await writeTranscript([
      { type: 'assistant', timestamp: '2026-08-06T17:00:00.000Z', message: { id: 'msg_old', model: 'claude-old', usage: { input_tokens: 999, output_tokens: 999 } } },
      { type: 'user', timestamp: '2026-08-06T18:00:00.000Z', message: {} },
      { type: 'assistant', timestamp: '2026-08-06T18:01:00.000Z', message: { id: 'msg_1', model: 'claude-sonnet-4', usage: { input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 10, output_tokens: 20 } } },
      // Duplicate line for the same message (multi-block): must not double-count.
      { type: 'assistant', timestamp: '2026-08-06T18:01:01.000Z', message: { id: 'msg_1', model: 'claude-sonnet-4', usage: { input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 10, output_tokens: 20 } } },
      { type: 'assistant', timestamp: '2026-08-06T18:02:00.000Z', message: { id: 'msg_2', model: 'claude-sonnet-4', usage: { input_tokens: 200, cache_read_input_tokens: 100, output_tokens: 30 } } },
      'not json at all'
    ]);

    const usage = await readTurnUsage(file, since);

    expect(usage).toBeDefined();
    expect(usage!.model).toBe('claude-sonnet-4');
    expect(usage!.inputTokens).toBe(300);
    expect(usage!.cachedInputTokens).toBe(150);
    expect(usage!.cacheCreationInputTokens).toBe(10);
    expect(usage!.outputTokens).toBe(50);
  });

  it('reports the model that produced the most tokens, not the last one written', async () => {
    const since = '2026-08-06T18:00:00.000Z';
    const file = await writeTranscript([
      { type: 'assistant', timestamp: '2026-08-06T18:01:00.000Z', message: { id: 'main', model: 'claude-sonnet-4', usage: { input_tokens: 5000, output_tokens: 800 } } },
      // A tiny side-call (title generation, subagent) lands last in the window;
      // it must not relabel — and downstream misprice — the whole turn.
      { type: 'assistant', timestamp: '2026-08-06T18:02:00.000Z', message: { id: 'side', model: 'claude-haiku', usage: { input_tokens: 20, output_tokens: 5 } } }
    ]);

    const usage = await readTurnUsage(file, since);

    expect(usage!.model).toBe('claude-sonnet-4');
    expect(usage!.inputTokens).toBe(5020);
  });

  it('reads only the tail of an oversized transcript and still finds recent usage', async () => {
    const since = '2026-08-06T18:00:00.000Z';
    const padding = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(1024) } });
    const lines = Array.from({ length: 5 * 1024 }, () => padding); // ~5 MB of old noise

    lines.push(JSON.stringify({ type: 'assistant', timestamp: '2026-08-06T18:01:00.000Z', message: { id: 'recent', model: 'claude-sonnet-4', usage: { input_tokens: 10, output_tokens: 5 } } }));
    const file = path.join(world.home, 'huge.jsonl');

    await fs.writeFile(file, lines.join('\n'));

    const usage = await readTurnUsage(file, since);

    expect(usage).toBeDefined();
    expect(usage!.inputTokens).toBe(10);
  });

  it('returns undefined when the transcript is missing or has no usage in range', async () => {
    expect(await readTurnUsage(path.join(world.home, 'nope.jsonl'), '2026-08-06T18:00:00.000Z')).toBeUndefined();
    const file = await writeTranscript([{ type: 'assistant', timestamp: '2026-08-06T17:00:00.000Z', message: { id: 'm', usage: { input_tokens: 1 } } }]);

    expect(await readTurnUsage(file, '2026-08-06T18:00:00.000Z')).toBeUndefined();
  });

  it('keeps reading until the transcript stabilizes: a late entry after an early one is still counted', async () => {
    // A turn with tool calls already has early usage entries at Stop time;
    // stopping at the first hit would systematically undercount the turn.
    const since = '2026-08-06T18:00:00.000Z';
    const file = await writeTranscript([
      { type: 'assistant', timestamp: '2026-08-06T18:01:00.000Z', message: { id: 'early', model: 'claude-sonnet-4', usage: { input_tokens: 10, output_tokens: 5 } } }
    ]);
    const lateEntry = { type: 'assistant', timestamp: '2026-08-06T18:02:00.000Z', message: { id: 'late', model: 'claude-sonnet-4', usage: { input_tokens: 20, output_tokens: 7 } } };

    // The flush is triggered by the *second* read rather than by a timer. Two
    // passes that agree end the loop, and with `minSettleMs` unset they agree
    // as early as the second pass — so a timed append that a loaded machine
    // delays past the first delay window makes this assert 10, which is what it
    // did on the Node 24 runner. Appended synchronously, and with `node:fs`
    // rather than the patched promises API, so nothing re-enters this hook.
    let reads = 0;
    const realReadFile = fs.readFile;

    (fs as { readFile: typeof fs.readFile }).readFile = ((target: Parameters<typeof fs.readFile>[0], ...rest: unknown[]) => {
      reads += 1;

      if (reads === 2 && target === file) fsSync.appendFileSync(file, '\n' + JSON.stringify(lateEntry));

      return (realReadFile as (...args: unknown[]) => unknown)(target, ...rest);
    }) as typeof fs.readFile;

    try {
      const usage = await readTurnUsage(file, since, { attempts: 6, delayMs: 10 });

      expect(usage!.inputTokens).toBe(30);
      expect(usage!.outputTokens).toBe(12);
    } finally {
      (fs as { readFile: typeof fs.readFile }).readFile = realReadFile;
    }
  });

  it('waits out the settle window before trusting an early stable snapshot', async () => {
    // Early usage stabilizes immediately; the final entry lands only 250 ms
    // in. A stable pair inside the settle window must not end the read.
    const since = '2026-08-06T18:00:00.000Z';
    const file = await writeTranscript([
      { type: 'assistant', timestamp: '2026-08-06T18:01:00.000Z', message: { id: 'early', model: 'claude-sonnet-4', usage: { input_tokens: 10, output_tokens: 5 } } }
    ]);
    const lateEntry = { type: 'assistant', timestamp: '2026-08-06T18:02:00.000Z', message: { id: 'late', model: 'claude-sonnet-4', usage: { input_tokens: 20, output_tokens: 7 } } };
    const appended = new Promise<void>((resolve) => {
      setTimeout(() => fs.appendFile(file, '\n' + JSON.stringify(lateEntry)).then(resolve, resolve), 250);
    });

    const usage = await readTurnUsage(file, since, { attempts: 8, delayMs: 100, minSettleMs: 500 });

    await appended;
    expect(usage!.inputTokens).toBe(30);
    expect(usage!.outputTokens).toBe(12);
  });

  it('ignores transcript entries after the until bound (the next prompt racing in)', async () => {
    const since = '2026-08-06T18:00:00.000Z';
    const file = await writeTranscript([
      { type: 'assistant', timestamp: '2026-08-06T18:01:00.000Z', message: { id: 'p1', model: 'claude-sonnet-4', usage: { input_tokens: 10, output_tokens: 5 } } },
      // The next prompt's usage lands in the same file after this turn's Stop.
      { type: 'assistant', timestamp: '2026-08-06T18:05:00.000Z', message: { id: 'p2', model: 'claude-sonnet-4', usage: { input_tokens: 999, output_tokens: 999 } } }
    ]);
    const usage = await readTurnUsage(file, since, undefined, '2026-08-06T18:02:00.000Z');

    expect(usage!.inputTokens).toBe(10);
    expect(usage!.outputTokens).toBe(5);
  });

  it('retries until a late-flushed assistant entry appears', async () => {
    // Claude Code writes the transcript asynchronously: the final assistant
    // entry can land on disk after the Stop hook already fired.
    const since = '2026-08-06T18:00:00.000Z';
    const file = await writeTranscript([
      { type: 'assistant', timestamp: '2026-08-06T17:00:00.000Z', message: { id: 'old', model: 'claude-old', usage: { input_tokens: 999 } } }
    ]);
    const lateEntry = { type: 'assistant', timestamp: '2026-08-06T18:01:00.000Z', message: { id: 'late', model: 'claude-sonnet-4', usage: { input_tokens: 10, output_tokens: 5 } } };
    const appended = new Promise<void>((resolve) => {
      setTimeout(() => fs.appendFile(file, '\n' + JSON.stringify(lateEntry)).then(resolve, resolve), 150);
    });

    const usage = await readTurnUsage(file, since, { attempts: 6, delayMs: 100 });

    await appended;
    expect(usage).toBeDefined();
    expect(usage!.inputTokens).toBe(10);
    expect(usage!.outputTokens).toBe(5);
  });
});

describe('turn state store', () => {
  let world: TempWorld;

  beforeEach(async () => {
    world = await makeTempEnv();
  });
  afterEach(() => world.cleanup());

  it('writes state files with 0600: they hold raw prompt text', async () => {
    const store = new TurnStateStore(path.join(world.home, 'turns'));

    await store.append('sess-priv', 'r1', { kind: 'prompt', at: '2026-08-06T18:00:00.000Z', text: 'secret prompt' });
    const dirs = await fs.readdir(path.join(world.home, 'turns'));
    const files = await fs.readdir(path.join(world.home, 'turns', dirs[0]!));
    const stat = await fs.stat(path.join(world.home, 'turns', dirs[0]!, files[0]!));

    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('sweeps sessions whose records are older than the TTL', async () => {
    const store = new TurnStateStore(path.join(world.home, 'turns'));

    await store.append('sess-stale', 'r1', { kind: 'prompt', at: '2026-08-05T18:00:00.000Z', text: 'old' });
    await store.append('sess-fresh', 'r1', { kind: 'prompt', at: '2026-08-06T18:00:00.000Z', text: 'new' });

    // Age the stale session's files on disk.
    const staleDirs = await fs.readdir(path.join(world.home, 'turns'));

    for (const dir of staleDirs) {
      const full = path.join(world.home, 'turns', dir);
      const [record] = await fs.readdir(full);
      const content = JSON.parse(await fs.readFile(path.join(full, record!), 'utf8'));

      if (content.text === 'old') {
        const past = new Date(Date.now() - 48 * 3600 * 1000);

        await fs.utimes(path.join(full, record!), past, past);
      }
    }

    await store.sweep(24 * 3600 * 1000);
    expect(await store.collect('sess-stale')).toEqual([]);
    expect(await store.collect('sess-fresh')).toHaveLength(1);
  });

  it('remembers the session model, overwrites it and keeps it out of the records', async () => {
    // Claude Code names its model on SessionStart alone, so the gate of a later
    // hook can only state it if this file survives between hook processes.
    const store = new TurnStateStore(path.join(world.home, 'turns'));

    await store.rememberModel('sess-model', 'claude-sonnet-5');
    expect(await store.readModel('sess-model')).toBe('claude-sonnet-5');

    await store.append('sess-model', 'r1', { kind: 'prompt', at: '2026-08-06T18:00:00.000Z', text: 'hello' });
    // The memo is not a turn record: it must never reach a summary.
    expect(await store.collect('sess-model')).toHaveLength(1);

    await store.rememberModel('sess-model', 'claude-opus-5');
    expect(await store.readModel('sess-model')).toBe('claude-opus-5');

    // 0600: what a tenant runs is theirs to know.
    const dirs = await fs.readdir(path.join(world.home, 'turns'));
    const stats = await Promise.all(dirs.map((dir) => fs.stat(path.join(world.home, 'turns', dir, SESSION_MODEL_FILE))));

    expect(stats.map((stat) => stat.mode & 0o777)).toEqual([0o600]);

    await store.clear('sess-model');
    expect(await store.readModel('sess-model')).toBeUndefined();
  });

  it('states no model when the memo is missing, garbage or the wrong shape', async () => {
    const store = new TurnStateStore(path.join(world.home, 'turns'));

    expect(await store.readModel('sess-never')).toBeUndefined();

    await store.rememberModel('sess-broken', 'claude-sonnet-5');

    const [dir] = await fs.readdir(path.join(world.home, 'turns'));
    const memo = path.join(world.home, 'turns', dir!, SESSION_MODEL_FILE);

    for (const contents of ['not json at all', '{}', '{"model":42}', '{"model":""}', '[]']) {
      await fs.writeFile(memo, contents);
      expect(await store.readModel('sess-broken')).toBeUndefined();
    }
  });

  it('appends, collects in order and clears per session', async () => {
    const store = new TurnStateStore(path.join(world.home, 'turns'));

    await store.append('sess-1', 'b-tool', { kind: 'tool', at: '2026-08-06T18:01:00.000Z', tool: 'Bash' });
    await store.append('sess-1', 'a-prompt', { kind: 'prompt', at: '2026-08-06T18:00:00.000Z', text: 'hello' });
    await store.append('sess-other', 'x', { kind: 'tool', at: '2026-08-06T18:00:30.000Z', tool: 'Edit' });

    const records = await store.collect('sess-1');

    expect(records.map((r) => r.kind)).toEqual(['prompt', 'tool']);

    await store.clear('sess-1');
    expect(await store.collect('sess-1')).toEqual([]);
    expect(await store.collect('sess-other')).toHaveLength(1);
  });
});

describe('buildTurnSummary', () => {
  it('produces the full flat summary object', () => {
    const summary = buildTurnSummary({
      provider: 'claude',
      surface: 'cli',
      sessionId: 'sess-1',
      turnId: 'turn-9',
      developerId: 'dev@company.com',
      installationId: 'inst-1',
      git: {
        repository: 'billing-service',
        branch: 'feature/PAY-142',
        commit: 'abc123',
        changedFiles: ['src/payments/refund.ts']
      },
      featureCandidates: [{ type: 'ticket', value: 'PAY-142', source: 'git.branch' }],
      prompts: [{ kind: 'prompt', at: '2026-08-06T18:00:00.000Z', text: 'fix refunds', evidence: { length: 11, sha256: 'x' } }],
      tools: [
        { kind: 'tool', at: '2026-08-06T18:01:00.000Z', tool: 'Bash' },
        { kind: 'tool', at: '2026-08-06T18:02:00.000Z', tool: 'Edit', filePath: 'src/payments/refund.ts' },
        { kind: 'tool', at: '2026-08-06T18:03:00.000Z', tool: 'Edit', filePath: 'src/payments/refund.ts' }
      ],
      response: { text: 'done', evidence: { length: 4, sha256: 'y' } },
      usage: { model: 'claude-sonnet-4', inputTokens: 300, cachedInputTokens: 150, cacheCreationInputTokens: 10, outputTokens: 50 },
      endedAt: '2026-08-06T18:24:00.000Z'
    });

    expect(summary.event.type).toBe('turn.summary');
    expect(summary.provider).toBe('claude-code');
    expect(summary.surface).toBe('cli');
    expect(summary.session_id).toBe('sess-1');
    expect(summary.turn_id).toBe('turn-9');
    expect(summary.developer_id).toBe('dev@company.com');
    expect(summary.repository).toBe('billing-service');
    expect(summary.branch).toBe('feature/PAY-142');
    expect(summary.commit).toBe('abc123');
    expect(summary.jira_ids).toEqual(['PAY-142']);
    expect(summary.files_changed).toEqual(['src/payments/refund.ts']);
    expect(summary.files_touched).toEqual(['src/payments/refund.ts']);
    expect(summary.prompt).toBe('fix refunds');
    expect(summary.response).toBe('done');
    expect(summary.tool_calls).toBe(3);
    expect(summary.tools_used).toEqual({ Bash: 1, Edit: 2 });
    expect(summary.model).toBe('claude-sonnet-4');
    expect(summary.input_tokens).toBe(300);
    expect(summary.cached_input_tokens).toBe(150);
    expect(summary.output_tokens).toBe(50);
    expect(summary.started_at).toBe('2026-08-06T18:00:00.000Z');
    expect(summary.ended_at).toBe('2026-08-06T18:24:00.000Z');
    expect(summary.id).toMatch(/^evt_/);
    expect(summary.schemaVersion).toBe('1');
  });

  it('separates files the agent read from files it modified', () => {
    const summary = buildTurnSummary({
      provider: 'claude',
      surface: 'cli',
      sessionId: 'sess-1',
      prompts: [],
      tools: [
        { kind: 'tool', at: '2026-08-06T18:01:00.000Z', tool: 'Read', filePath: 'src/auth.ts', access: 'read' },
        { kind: 'tool', at: '2026-08-06T18:02:00.000Z', tool: 'Edit', filePath: 'src/refund.ts', access: 'edit' },
        // Legacy record without an access marker keeps the historical meaning.
        { kind: 'tool', at: '2026-08-06T18:03:00.000Z', tool: 'Write', filePath: 'src/new.ts' }
      ],
      endedAt: '2026-08-06T18:24:00.000Z'
    });

    expect(summary.files_touched).toEqual(['src/refund.ts', 'src/new.ts']);
    expect(summary.files_read).toEqual(['src/auth.ts']);
  });

  it('omits prompt/response text when not captured but keeps evidence', () => {
    const summary = buildTurnSummary({
      provider: 'claude',
      surface: 'cli',
      sessionId: 'sess-1',
      prompts: [{ kind: 'prompt', at: '2026-08-06T18:00:00.000Z', evidence: { length: 11, sha256: 'x' } }],
      tools: [],
      response: { evidence: { length: 4, sha256: 'y' } },
      endedAt: '2026-08-06T18:24:00.000Z'
    });

    expect(summary.prompt).toBeUndefined();
    expect(summary.response).toBeUndefined();
    expect(summary.prompt_evidence).toEqual({ length: 11, sha256: 'x' });
    expect(summary.response_evidence).toEqual({ length: 4, sha256: 'y' });
    expect(summary.tool_calls).toBe(0);
  });
});

describe('turn tracking through the hook pipeline', () => {
  let world: TempWorld;

  beforeEach(async () => {
    world = await makeTempEnv();
  });
  afterEach(() => world.cleanup());

  async function configure(overrides: Record<string, unknown> = {}): Promise<void> {
    const paths = resolvePaths(world.env);

    await writeJson(paths.configFile, {
      ...defaultConfig(),
      developerEmail: 'dev@company.com',
      contentCaptureConsent: true,
      capture: { ...defaultConfig().capture, ...CONTENT_CAPTURE_ON },
      ...overrides
    });
  }

  async function hookDryRun(payload: Record<string, unknown>): Promise<{ events: any[] }> {
    // Exercise the real stateful hook path and capture only newly queued
    // product records. --dry-run has separate read-only semantics and is
    // tested explicitly below.
    const paths = resolvePaths(world.env);
    const before = new Set(await queueEntryFiles(paths.queueDir));
    const code = await runHook('claude', {
      env: world.env,
      input: JSON.stringify(payload)
    });

    expect(code).toBe(0);
    const added = (await queueEntryFiles(paths.queueDir)).filter((file) => !before.has(file));
    const events = await Promise.all(added.map(async (file) => JSON.parse(await fs.readFile(file, 'utf8')).event));

    return { events };
  }

  it('writes the session model on SessionStart and drops it with the session', async () => {
    // Claude Code names its model on this hook and on no other, so this write is
    // the only reason a later prompt's gate can state which model it is about.
    await configure();
    await hookDryRun({ hook_event_name: 'SessionStart', session_id: 'sess-model', source: 'startup', model: 'claude-sonnet-5', cwd: world.home });

    const turnsDir = resolvePaths(world.env).turnsDir;
    const store = new TurnStateStore(turnsDir);

    expect(await store.readModel('sess-model')).toBe('claude-sonnet-5');

    await hookDryRun({ hook_event_name: 'SessionEnd', session_id: 'sess-model', reason: 'clear', cwd: world.home });
    expect(await store.readModel('sess-model')).toBeUndefined();
    // No session state left behind. The sweep marker is not session state: it
    // holds no session id and no content, only the time of the last sweep.
    expect((await fs.readdir(turnsDir).catch(() => [])).filter((name) => name !== SWEEP_MARKER_FILE)).toEqual([]);
  });

  it('emits only a turn.summary on Stop with provisional transcript usage', async () => {
    await configure();
    await writeJson(path.join(world.home, '.claude.json'), {
      oauthAccount: { emailAddress: 'dev@company.com', billingType: 'stripe_subscription' }
    });
    const transcript = path.join(world.home, 'transcript.jsonl');

    await fs.writeFile(
      transcript,
      JSON.stringify({ type: 'assistant', timestamp: new Date(Date.now() - 120_000).toISOString(), message: { id: 'old', model: 'claude-sonnet-4', usage: { input_tokens: 999, output_tokens: 999 } } })
    );

    await hookDryRun({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-t', prompt_id: 'p1', prompt: 'fix the refund bug', cwd: world.home });
    // Inside the turn: after the prompt hook, before Stop.
    await fs.appendFile(
      transcript,
      '\n' + JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { id: 'm1', model: 'claude-sonnet-4', usage: { input_tokens: 100, cache_read_input_tokens: 40, output_tokens: 25 } } })
    );
    await hookDryRun({ hook_event_name: 'PostToolUse', session_id: 'sess-t', prompt_id: 'p1', tool_name: 'Edit', tool_use_id: 't1', tool_input: { file_path: path.join(world.home, 'src/refund.ts') }, cwd: world.home });
    const result = await hookDryRun({
      hook_event_name: 'Stop',
      session_id: 'sess-t',
      prompt_id: 'p1',
      transcript_path: transcript,
      last_assistant_message: 'Fixed the refund bug.',
      cwd: world.home
    });

    const summary = result.events.find((event: any) => event.event.type === 'turn.summary');

    expect(summary).toBeDefined();
    expect(summary.provider).toBe('claude-code');
    expect(summary.session_id).toBe('sess-t');
    // prompt_id is the turn id: it links the summary to raw events and to
    // OTel prompt.id for cost correlation.
    expect(summary.turn_id).toBe('p1');
    expect(summary.developer_id).toBe('dev@company.com');
    expect(summary.prompt).toBe('fix the refund bug');
    expect(summary.response).toBe('Fixed the refund bug.');
    expect(summary.tool_calls).toBe(1);
    expect(summary.tools_used).toEqual({ Edit: 1 });
    // Not a git repo: privacy enrichment degrades the path to its basename.
    expect(summary.files_touched).toEqual(['refund.ts']);
    expect(summary.model).toBe('claude-sonnet-4');
    expect(summary.billing_mode).toBe('subscription');
    expect(summary.input_tokens).toBe(100);
    expect(summary.cached_input_tokens).toBe(40);
    expect(summary.output_tokens).toBe(25);
    expect(summary.usage_status).toBe('provisional');
    expect(summary.started_at).toBeDefined();
    expect(summary.ended_at).toBeDefined();

    // The turn is consumed: a repeated Stop with nothing new produces no
    // summary at all (previously an empty duplicate).
    const again = await hookDryRun({ hook_event_name: 'Stop', session_id: 'sess-t', prompt_id: 'p1', transcript_path: transcript, cwd: world.home });

    expect(again.events.some((event: any) => event.event.type === 'turn.summary')).toBe(false);
  });

  it('still emits a degraded summary when turn state is unusable', async () => {
    await configure();
    const paths = resolvePaths(world.env);

    // Sabotage turn state: the turns dir is a plain file, so every state
    // operation fails. The turn must still reach the backend.
    await fs.mkdir(path.dirname(paths.turnsDir), { recursive: true });
    await fs.rm(paths.turnsDir, { recursive: true, force: true });
    await fs.writeFile(paths.turnsDir, 'not a directory');

    const result = await hookDryRun({
      hook_event_name: 'Stop',
      session_id: 'sess-broken',
      prompt_id: 'p9',
      last_assistant_message: 'done anyway',
      cwd: world.home
    });
    const summary = result.events.find((event: any) => event.event.type === 'turn.summary');

    expect(summary).toBeDefined();
    expect(summary.session_id).toBe('sess-broken');
    expect(summary.turn_id).toBe('p9');
    expect(summary.response).toBe('done anyway');
    // No prompts/tools/usage: the backend finalizes from the llm.call ledger.
    expect(summary.usage_status).toBe('pending');
  });

  it('Stop consumes only records belonging to its own prompt', async () => {
    await configure();
    await hookDryRun({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-s', prompt_id: 'p1', prompt: 'first prompt', cwd: world.home });
    await hookDryRun({ hook_event_name: 'PostToolUse', session_id: 'sess-s', prompt_id: 'p1', tool_name: 'Edit', tool_use_id: 't1', tool_input: { file_path: 'a.ts' }, cwd: world.home });
    // The next prompt races ahead before p1's Stop is processed.
    await hookDryRun({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-s', prompt_id: 'p2', prompt: 'second prompt', cwd: world.home });
    await hookDryRun({ hook_event_name: 'PostToolUse', session_id: 'sess-s', prompt_id: 'p2', tool_name: 'Bash', tool_use_id: 't2', tool_input: { command: 'ls' }, cwd: world.home });

    const first = await hookDryRun({ hook_event_name: 'Stop', session_id: 'sess-s', prompt_id: 'p1', last_assistant_message: 'first done', cwd: world.home });
    const firstSummary = first.events.find((event: any) => event.event.type === 'turn.summary');

    expect(firstSummary.turn_id).toBe('p1');
    expect(firstSummary.prompt).toBe('first prompt');
    expect(firstSummary.tools_used).toEqual({ Edit: 1 });

    // p2's records survived p1's close and produce their own summary.
    const second = await hookDryRun({ hook_event_name: 'Stop', session_id: 'sess-s', prompt_id: 'p2', last_assistant_message: 'second done', cwd: world.home });
    const secondSummary = second.events.find((event: any) => event.event.type === 'turn.summary');

    expect(secondSummary.turn_id).toBe('p2');
    expect(secondSummary.prompt).toBe('second prompt');
    expect(secondSummary.tools_used).toEqual({ Bash: 1 });
  });

  it('picks up usage flushed to the transcript after Stop fires', async () => {
    await configure();
    const transcript = path.join(world.home, 'late-transcript.jsonl');

    await fs.writeFile(
      transcript,
      JSON.stringify({ type: 'assistant', timestamp: new Date(Date.now() - 120_000).toISOString(), message: { id: 'old', model: 'claude-old', usage: { input_tokens: 999 } } })
    );
    await hookDryRun({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-late', prompt: 'hi', cwd: world.home });
    // Message finished inside the turn; only its WRITE to the file is late.
    const lateEntry = { type: 'assistant', timestamp: new Date().toISOString(), message: { id: 'm-late', model: 'claude-sonnet-4', usage: { input_tokens: 7, output_tokens: 3 } } };
    const appended = new Promise<void>((resolve) => {
      setTimeout(() => fs.appendFile(transcript, '\n' + JSON.stringify(lateEntry)).then(resolve, resolve), 200);
    });

    const result = await hookDryRun({ hook_event_name: 'Stop', session_id: 'sess-late', transcript_path: transcript, cwd: world.home });

    await appended;
    const summary = result.events.find((event: any) => event.event.type === 'turn.summary');

    expect(summary.model).toBe('claude-sonnet-4');
    expect(summary.input_tokens).toBe(7);
    expect(summary.output_tokens).toBe(3);
  });

  it('keeps prompt text out of the summary when capture is explicitly off', async () => {
    await configure({ capture: { ...defaultConfig().capture, prompts: false, responses: false } });
    await hookDryRun({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-p', prompt: 'secret prompt', cwd: world.home });
    const result = await hookDryRun({ hook_event_name: 'Stop', session_id: 'sess-p', last_assistant_message: 'reply', cwd: world.home });
    const summary = result.events.find((event: any) => event.event.type === 'turn.summary');

    expect(summary).toBeDefined();
    expect(JSON.stringify(summary)).not.toContain('secret prompt');
    expect(summary.prompt_evidence).toBeDefined();
  });

  it('sends only the summary', async () => {
    await configure();
    await hookDryRun({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-e', prompt: 'hi', cwd: world.home });
    const result = await hookDryRun({ hook_event_name: 'Stop', session_id: 'sess-e', cwd: world.home });

    expect(result.events).toHaveLength(1);
    expect(result.events[0].event.type).toBe('turn.summary');
  });

  it('ignores the removed emit.events legacy key and never exposes lifecycle events', async () => {
    await configure({ emit: { events: true, turnSummaries: true } });
    await hookDryRun({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-e2', prompt: 'hi', cwd: world.home });
    const result = await hookDryRun({ hook_event_name: 'Stop', session_id: 'sess-e2', cwd: world.home });

    expect(result.events.map((event: any) => event.event.type)).toEqual(['turn.summary']);
  });

  it('emit.turnSummaries=false emits no hook-path product record', async () => {
    await configure({ emit: { events: true, turnSummaries: false } });
    const transcript = path.join(world.home, 'transcript-nosummary.jsonl');

    await hookDryRun({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-d', prompt: 'hi', cwd: world.home });
    await fs.writeFile(
      transcript,
      JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { id: 'm1', model: 'claude-sonnet-4', usage: { input_tokens: 11, output_tokens: 4 } } })
    );
    const result = await hookDryRun({ hook_event_name: 'Stop', session_id: 'sess-d', transcript_path: transcript, cwd: world.home });

    expect(result.events).toEqual([]);
  });

  it('includes a tool that completes while Stop waits out the settle window', async () => {
    await configure();
    const transcript = path.join(world.home, 'settle-transcript.jsonl');

    await hookDryRun({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-w', prompt_id: 'p1', prompt: 'go', cwd: world.home });
    await fs.writeFile(
      transcript,
      JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { id: 'm1', model: 'claude-sonnet-4', usage: { input_tokens: 5, output_tokens: 2 } } })
    );

    // Stop takes >= 500 ms (settle window); the tool completion lands mid-close.
    const stopPromise = hookDryRun({ hook_event_name: 'Stop', session_id: 'sess-w', prompt_id: 'p1', transcript_path: transcript, last_assistant_message: 'ok', cwd: world.home });

    await new Promise((resolve) => setTimeout(resolve, 150));
    await hookDryRun({ hook_event_name: 'PostToolUse', session_id: 'sess-w', prompt_id: 'p1', tool_name: 'Edit', tool_use_id: 't-late', tool_input: { file_path: 'late.ts' }, cwd: world.home });

    const result = await stopPromise;
    const summary = result.events.find((event: any) => event.event.type === 'turn.summary');

    expect(summary.tools_used).toEqual({ Edit: 1 });
  });

  it('closes two different prompts concurrently without losing either summary', async () => {
    await configure();
    const transcript = path.join(world.home, 'parallel-transcript.jsonl');

    await hookDryRun({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-par', prompt_id: 'p1', prompt: 'first', cwd: world.home });
    await hookDryRun({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-par', prompt_id: 'p2', prompt: 'second', cwd: world.home });
    // Force both prompts and the transcript entry onto the same inclusive
    // timestamp boundary. The overlap-window guard cannot partition this;
    // the session usage lock + persisted claim must do it atomically.
    const boundary = new Date(Date.now() - 1_000).toISOString();
    const paths = resolvePaths(world.env);
    const [sessionDir] = await fs.readdir(paths.turnsDir);

    for (const name of await fs.readdir(path.join(paths.turnsDir, sessionDir!))) {
      const file = path.join(paths.turnsDir, sessionDir!, name);
      const record = JSON.parse(await fs.readFile(file, 'utf8'));

      if (record.kind === 'prompt') {
        record.at = boundary;
        await fs.writeFile(file, JSON.stringify(record));
      }
    }

    await fs.writeFile(transcript, JSON.stringify({ type: 'assistant', timestamp: boundary, message: { id: 'm1', model: 'claude-sonnet-4', usage: { input_tokens: 5, output_tokens: 2 } } }));

    const stop = (promptId: string) =>
      hookDryRun({ hook_event_name: 'Stop', session_id: 'sess-par', prompt_id: promptId, transcript_path: transcript, last_assistant_message: 'ok', cwd: world.home });
    const [first, second] = await Promise.all([stop('p1'), stop('p2')]);
    const summaries = [...new Map(
      [...first.events, ...second.events]
        .filter((event: any) => event.event.type === 'turn.summary')
        .map((event: any) => [event.id, event])
    ).values()] as any[];

    expect(summaries.map((s: any) => s.turn_id).sort()).toEqual(['p1', 'p2']);
    // The single transcript usage entry must be claimed exactly once even
    // though both time windows include it.
    const claimed = summaries.filter((s: any) => s.input_tokens !== undefined);

    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ input_tokens: 5, output_tokens: 2 });
  });

  it('attributes usage exactly once when the newer turn closes before the older one', async () => {
    await configure();
    const transcript = path.join(world.home, 'nested-transcript.jsonl');

    await hookDryRun({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-nest', prompt_id: 'p1', prompt: 'outer', cwd: world.home });
    // p1's own usage lands before p2 starts.
    await fs.writeFile(
      transcript,
      JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { id: 'e1', model: 'claude-sonnet-4', usage: { input_tokens: 10, output_tokens: 5 } } })
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    await hookDryRun({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-nest', prompt_id: 'p2', prompt: 'inner', cwd: world.home });
    await fs.appendFile(
      transcript,
      // Deliberately omit message.id: anonymous entries receive a stable
      // content hash and must participate in the persisted ledger too.
      '\n' + JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { model: 'claude-sonnet-4', usage: { input_tokens: 20, output_tokens: 7 } } })
    );

    // The inner turn closes FIRST and fully consumes its state.
    const inner = await hookDryRun({ hook_event_name: 'Stop', session_id: 'sess-nest', prompt_id: 'p2', transcript_path: transcript, last_assistant_message: 'inner done', cwd: world.home });
    const innerSummary = inner.events.find((event: any) => event.event.type === 'turn.summary');

    expect(innerSummary.input_tokens).toBe(20);
    expect(innerSummary.output_tokens).toBe(7);

    // The outer turn closes later; its window spans e1 AND e2, but e2 is
    // already claimed — it must count e1 only, never e2 again.
    const outer = await hookDryRun({ hook_event_name: 'Stop', session_id: 'sess-nest', prompt_id: 'p1', transcript_path: transcript, last_assistant_message: 'outer done', cwd: world.home });
    const outerSummary = outer.events.find((event: any) => event.event.type === 'turn.summary');

    expect(outerSummary.input_tokens).toBe(10);
    expect(outerSummary.output_tokens).toBe(5);
  });

  it('keeps tool lifecycle data internal while retaining safe files_touched in the summary', async () => {
    await configure();
    // A path whose prefix merely STARTS with the home dir must stay intact.
    const sibling = `${world.home}-backup/file.ts`;
    const toolResult = await hookDryRun({
      hook_event_name: 'PostToolUse',
      session_id: 'sess-bound',
      prompt_id: 'p1',
      tool_name: 'Edit',
      tool_use_id: 't1',
      tool_input: { file_path: sibling },
      cwd: world.home
    });

    expect(toolResult.events).toEqual([]);
    const result = await hookDryRun({ hook_event_name: 'Stop', session_id: 'sess-bound', prompt_id: 'p1', cwd: world.home });

    expect(result.events[0].files_touched).toEqual(['file.ts']);
  });

  it('never exposes captured tool input as a third product record', async () => {
    await configure();
    const absolute = path.join(world.home, 'projects', 'x', 'secret-dir', 'file.ts');
    const result = await hookDryRun({
      hook_event_name: 'PostToolUse',
      session_id: 'sess-paths',
      prompt_id: 'p1',
      tool_name: 'Edit',
      tool_use_id: 't1',
      tool_input: { file_path: absolute, old_string: 'a', new_string: 'b' },
      cwd: world.home
    });

    expect(result.events).toEqual([]);
  });

  it('emits exactly one summary when two Stops race for the same turn', async () => {
    await configure();
    const transcript = path.join(world.home, 'race-transcript.jsonl');

    await hookDryRun({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-race', prompt_id: 'p1', prompt: 'go', cwd: world.home });
    await fs.writeFile(
      transcript,
      JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { id: 'm1', model: 'claude-sonnet-4', usage: { input_tokens: 5, output_tokens: 2 } } })
    );

    const stop = { hook_event_name: 'Stop', session_id: 'sess-race', prompt_id: 'p1', transcript_path: transcript, last_assistant_message: 'ok', cwd: world.home };
    const [first, second] = await Promise.all([hookDryRun(stop), hookDryRun({ ...stop, stop_hook_active: true })]);
    const summaries = [...new Map(
      [...first.events, ...second.events]
        .filter((event: any) => event.event.type === 'turn.summary')
        .map((event: any) => [event.id, event])
    ).values()];

    expect(summaries).toHaveLength(1);
  });

  it('--dry-run previews a Stop without consuming records or claiming transcript usage', async () => {
    await configure();
    const paths = resolvePaths(world.env);
    const transcript = path.join(world.home, 'dry-run-transcript.jsonl');

    await hookDryRun({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-preview', prompt_id: 'p1', prompt: 'preview me', cwd: world.home });
    await fs.writeFile(
      transcript,
      JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { id: 'm-preview', model: 'claude-sonnet-4', usage: { input_tokens: 8, output_tokens: 3 } } })
    );
    const [sessionDir] = await fs.readdir(paths.turnsDir);
    const stateDir = path.join(paths.turnsDir, sessionDir!);
    const before = (await fs.readdir(stateDir)).sort();
    let stdout = '';
    const code = await runHook('claude', {
      env: world.env,
      input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'sess-preview', prompt_id: 'p1', transcript_path: transcript, cwd: world.home }),
      dryRun: true,
      writeStdout: (text) => { stdout += text; }
    });

    expect(code).toBe(0);
    expect(JSON.parse(stdout).events[0]).toMatchObject({ event: { type: 'turn.summary' }, input_tokens: 8 });
    const after = (await fs.readdir(stateDir)).sort();

    expect(after).toEqual(before);
    expect(after.some((name) => name.startsWith('usage-claim--'))).toBe(false);
  });

  it('caps prompt text stored on disk but keeps true length in evidence', async () => {
    await configure();
    const big = 'x'.repeat(200_000);

    await hookDryRun({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-big', prompt: big, cwd: world.home });

    const paths = resolvePaths(world.env);
    const turnsDir = path.join(paths.dataDir, 'turns');
    const [sessionDir] = await fs.readdir(turnsDir);
    const [recordFile] = await fs.readdir(path.join(turnsDir, sessionDir!));
    const record = JSON.parse(await fs.readFile(path.join(turnsDir, sessionDir!, recordFile!), 'utf8'));

    expect(record.text.length).toBeLessThanOrEqual(65536);
    expect(record.evidence.length).toBe(200_000);
  });

  it('SessionEnd clears leftover turn state', async () => {
    await configure();
    await hookDryRun({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-c', prompt: 'hi', cwd: world.home });
    await hookDryRun({ hook_event_name: 'SessionEnd', session_id: 'sess-c', cwd: world.home });
    const paths = resolvePaths(world.env);
    const store = new TurnStateStore(path.join(paths.dataDir, 'turns'));

    expect(await store.collect('sess-c')).toEqual([]);
  });
});

describe('the session model memo is written on the session hook alone', () => {
  let world: TempWorld;

  beforeEach(async () => {
    world = await makeTempEnv();
  });
  afterEach(() => world.cleanup());

  /** Codex puts its model on the base event of every hook, Stop included. */
  function track(payload: unknown) {
    const events = parseCodexHookEvent(payload, {
      env: world.env,
      config: configSchema.parse(defaultConfig())
    });
    const paths = resolvePaths(world.env);

    return trackTurn({
      agentId: 'codex',
      rawPayload: payload,
      events,
      config: configSchema.parse(defaultConfig()),
      turnsDir: paths.turnsDir,
      locksDir: paths.locksDir,
      env: world.env,
      cwd: world.home
    });
  }

  it('a start naming no model forgets one left under that id', async () => {
    // `clear()` at SessionEnd swallows only ENOENT, so a cleanup that failed on
    // anything else leaves the memo behind — and `--resume` reuses the session
    // id. Inherited, the gate would state the previous session's model: not "no
    // model", but a confident wrong answer on a path whose contract is that
    // anything short of certainty allows the turn.
    const store = new TurnStateStore(resolvePaths(world.env).turnsDir);

    await store.rememberModel(codexSessionStart.session_id, 'gpt-5.2-codex');
    expect(await store.readModel(codexSessionStart.session_id)).toBe('gpt-5.2-codex');

    const { model, ...startWithoutModel } = codexSessionStart;

    expect(model).toBeDefined();
    await track(startWithoutModel);

    expect(await store.readModel(codexSessionStart.session_id)).toBeUndefined();
  });

  it('skips the hooks that must not be pre-empted', async () => {
    // Codex, Cursor, Gemini and Antigravity name the model on every hook, so
    // without narrowing this the memo would be rewritten on the turn-closing
    // hook and at SessionEnd. A failed write there is not a lost memo: the catch
    // in `trackTurn` turns the close into a fallback summary, and at SessionEnd
    // it leaves the session's raw prompt text undeleted.
    const store = new TurnStateStore(resolvePaths(world.env).turnsDir);

    await track(codexStop);
    expect(await store.readModel(codexStop.session_id)).toBeUndefined();

    await track(codexUserPromptSubmit);
    expect(await store.readModel(codexStop.session_id)).toBeUndefined();

    // The session's own hook is the one that writes it, for every agent.
    await track(codexSessionStart);
    expect(await store.readModel(codexStop.session_id)).toBe('gpt-5.2-codex');
  });
});

describe('a degraded turn summary names the same developer as a healthy one', () => {
  let world: TempWorld;
  let repoDir: string;

  beforeEach(async () => {
    world = await makeTempEnv();
    repoDir = path.join(world.home, 'repo');
    await fs.mkdir(repoDir, { recursive: true });
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repoDir, stdio: 'pipe', env: { ...process.env, HOME: world.home } });

    git('init');
    git('config', 'user.email', 'git-only@company.com');
    git('config', 'user.name', 'Git Only');
  });
  afterEach(() => world.cleanup());

  /** No `developerEmail`: this machine can only be named by git. */
  function track(payload: unknown) {
    const config = configSchema.parse({ ...defaultConfig(), developerEmail: undefined });
    const paths = resolvePaths(world.env);

    return trackTurn({
      agentId: 'codex',
      rawPayload: payload,
      events: parseCodexHookEvent(payload, { env: world.env, config }),
      config,
      turnsDir: paths.turnsDir,
      locksDir: paths.locksDir,
      env: world.env,
      cwd: repoDir
    });
  }

  it('resolves the git identity on the degraded close, not only on the healthy one', async () => {
    await track({ ...codexUserPromptSubmit, cwd: repoDir });

    const healthy = await track({ ...codexStop, cwd: repoDir });

    expect(healthy).toBeDefined();
    expect(healthy!.developer_id).toBe('git-only@company.com');

    // Sabotage turn state so the close throws and the degraded path runs.
    const paths = resolvePaths(world.env);

    await fs.mkdir(path.dirname(paths.turnsDir), { recursive: true });
    await fs.rm(paths.turnsDir, { recursive: true, force: true });
    await fs.writeFile(paths.turnsDir, 'not a directory');

    const degraded = await track({ ...codexStop, session_id: 'sess-degraded', cwd: repoDir });

    expect(degraded).toBeDefined();
    expect(degraded!.developer_id).toBe('git-only@company.com');
  });
});
