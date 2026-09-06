import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../src/config/config.js';
import { loadConfig, saveConfig } from '../src/config/config-store.js';
import { loadEffectiveConfig, mergeRepoConfig } from '../src/config/repo-config.js';
import { HttpTransport } from '../src/transport/http-transport.js';
import { resolvePaths } from '../src/storage/paths.js';
import { runHook } from '../src/cli/hook.js';
import { CONTENT_CAPTURE_ON, makeTempEnv, writeJson, type TempWorld } from './helpers.js';

const allCapture = { ...CONTENT_CAPTURE_ON, git: true, files: true };

describe('enterprise privacy migration', () => {
  let world: TempWorld;

  beforeEach(async () => { world = await makeTempEnv(); });
  afterEach(async () => { await world.cleanup(); vi.restoreAllMocks(); });

  it('starts with metadata only and no consent', () => {
    expect(defaultConfig().capture).toEqual({ ...allCapture, prompts: false, responses: false, toolInput: false, toolOutput: false });
    expect(defaultConfig().contentCaptureConsent).toBe(false);
  });

  it.each([undefined, false, true])('requires new global consent (%s), even with every legacy flag true', async (consent) => {
    const paths = resolvePaths(world.env);
    const legacy = { schemaVersion: 1, capture: allCapture, contentCaptureConsent: consent };

    await writeJson(paths.configFile, legacy);
    const loaded = await loadConfig(paths);

    expect(loaded.state).toBe('ok');
    expect(loaded.config.capture).toEqual({ ...allCapture, prompts: consent === true, responses: consent === true, toolInput: consent === true, toolOutput: consent === true });
    // Runtime migration does not destructively rewrite the user's file.
    expect(JSON.parse(await fs.readFile(paths.configFile, 'utf8'))).toEqual(JSON.parse(JSON.stringify(legacy)));
  });

  it('refuses repository consent and every capture escalation, including metadata', () => {
    const global = { ...defaultConfig(), capture: { ...defaultConfig().capture, git: false, files: false } };
    const merged = mergeRepoConfig(global, { contentCaptureConsent: true, capture: allCapture });

    expect(merged.config.capture).toEqual(global.capture);
    expect(merged.config.contentCaptureConsent).toBe(false);
    expect(merged.warnings.join(' ')).toContain('contentCaptureConsent');
  });

  it('lets a repository narrow explicit opt-in', () => {
    const global = { ...defaultConfig(), contentCaptureConsent: true, capture: allCapture };
    const merged = mergeRepoConfig(global, { capture: { prompts: false, toolOutput: false, files: false } });

    expect(merged.config.capture).toEqual({ ...allCapture, prompts: false, toolOutput: false, files: false });
    expect(global.capture).toEqual(allCapture);
  });

  it.each(['missing', 'corrupt'])('keeps metadata-only behavior with %s global config and malicious repo', async (state) => {
    const paths = resolvePaths(world.env);

    await writeJson(path.join(world.home, '.agentwatch.json'), { contentCaptureConsent: true, capture: allCapture });

    if (state === 'corrupt') await writeJson(paths.configFile, { capture: 'broken' });

    expect((await loadEffectiveConfig(paths, world.home)).config.capture).toEqual(defaultConfig().capture);
  });

  it('strips old queued content at the HTTP boundary while retaining metadata', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 202, json: async () => ({}) });
    const transport = new HttpTransport({ eventsUrl: 'https://example.com/v1/events', timeoutMs: 100, fetchFn });

    await transport.send([{ event: { type: 'turn.summary' }, prompt: 'legacy private prompt', response: 'legacy response', prompt_evidence: { length: 21, sha256: 'hash' }, files_touched: ['src/main.ts'] } as never]);
    const body = JSON.parse(fetchFn.mock.calls[0]![1].body);

    expect(body.events[0].prompt).toBeUndefined();
    expect(body.events[0].response).toBeUndefined();
    expect(body.events[0].files_touched).toEqual(['src/main.ts']);
  });

  it('drops queued snapshots and file lists once their metadata flag is revoked', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 202, json: async () => ({}) });
    const capture = { ...allCapture, git: false, files: false };
    const transport = new HttpTransport({ eventsUrl: 'https://example.com/v1/events', timeoutMs: 100, fetchFn, capture });

    const result = await transport.send([
      { event: { type: 'repo.snapshot' }, repository: 'acme/edge', branches: [{ name: 'feat', head_sha: 'abc', commits: [{ sha: 'abc', subject: 'secret acquisition prep' }] }] },
      { event: { type: 'turn.summary' }, prompt: 'p', files_touched: ['src/main.ts'], tool_calls: 1 }
    ] as never);
    const body = JSON.parse(fetchFn.mock.calls[0]![1].body);

    expect(result.ok).toBe(true);
    expect(body.events).toHaveLength(1);
    expect(body.events[0].event.type).toBe('turn.summary');
    expect(body.events[0].files_touched).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('secret acquisition prep');
  });

  it('sends nothing at all when every queued record is gated out', async () => {
    const fetchFn = vi.fn();
    const transport = new HttpTransport({ eventsUrl: 'https://example.com/v1/events', timeoutMs: 100, fetchFn, capture: { ...allCapture, git: false } });
    const result = await transport.send([{ event: { type: 'repo.snapshot' }, repository: 'acme/edge', branches: [] }] as never);

    expect(result.ok).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('drops the summary git metadata a revoked capture.git no longer allows', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 202, json: async () => ({}) });
    const transport = new HttpTransport({ eventsUrl: 'https://example.com/v1/events', timeoutMs: 100, fetchFn, capture: { ...allCapture, git: false } });

    await transport.send([{
      event: { type: 'turn.summary' }, repository: 'acme/edge', branch: 'feat/x', commit: 'deadbeef',
      jira_ids: ['AWT-1'], tool_calls: 2, model: 'claude-opus-5'
    }] as never);
    const summary = JSON.parse(fetchFn.mock.calls[0]![1].body).events[0];

    expect(summary.repository).toBeUndefined();
    expect(summary.branch).toBeUndefined();
    expect(summary.commit).toBeUndefined();
    expect(summary.jira_ids).toBeUndefined();
    // Spend metadata is not what capture.git gates.
    expect(summary.tool_calls).toBe(2);
    expect(summary.model).toBe('claude-opus-5');
  });

  it('keeps the content flags the user wrote, so consent stays reversible', async () => {
    const paths = resolvePaths(world.env);

    await writeJson(paths.configFile, { schemaVersion: 1, capture: allCapture });
    // Saving the gated shape would erase the choice: adding consent later would
    // find every flag already false and no record they were ever set.
    await saveConfig(paths, (await loadConfig(paths)).config);
    expect(JSON.parse(await fs.readFile(paths.configFile, 'utf8')).capture).toEqual(allCapture);

    await writeJson(paths.configFile, { ...JSON.parse(await fs.readFile(paths.configFile, 'utf8')), contentCaptureConsent: true });
    expect((await loadConfig(paths)).config.capture).toEqual(allCapture);
  });

  it('old stored turn text cannot bypass the gate on close', async () => {
    const paths = resolvePaths(world.env);

    await writeJson(paths.configFile, { ...defaultConfig(), contentCaptureConsent: true, capture: allCapture });
    await runHook('claude', { env: world.env, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'migration', prompt: 'old private text' }) });
    await writeJson(paths.configFile, { capture: allCapture });
    await runHook('claude', { env: world.env, input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'migration', last_assistant_message: 'private answer' }) });
    const entries = await fs.readdir(paths.queueDir);
    const raw = await Promise.all(entries.map((name) => fs.readFile(path.join(paths.queueDir, name), 'utf8')));

    expect(raw.join(' ')).not.toContain('old private text');
    expect(raw.join(' ')).not.toContain('private answer');
  });
});
