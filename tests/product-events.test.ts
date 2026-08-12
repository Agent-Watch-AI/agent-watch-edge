import { describe, expect, it } from 'vitest';
import { PRODUCT_EVENT_TYPES } from '../src/events/canonical-event.js';
import { buildLlmCall } from '../src/events/llm-call.js';
import { normalizeOtlpLogs } from '../src/otlp/normalize.js';
import { buildTurnSummary } from '../src/turns/turn-summary.js';
import { aggregateTurnUsage } from '../src/turns/aggregate-usage.js';

const kv = (key: string, value: string | number) => ({
  key,
  value: typeof value === 'number' ? { intValue: String(value) } : { stringValue: value }
});

describe('two-record product contract', () => {
  it('exposes exactly llm.call and turn.summary', () => {
    expect(PRODUCT_EVENT_TYPES).toEqual(['llm.call', 'turn.summary']);
  });

  it('normalizes each Claude API request into one feature-correlated llm.call', () => {
    const payload = {
      resourceLogs: [{
        resource: { attributes: [] },
        scopeLogs: [{ logRecords: [{
          timeUnixNano: '1786118400000000000',
          attributes: [
            kv('event.name', 'claude_code.api_request'),
            kv('session.id', 'sess-1'),
            kv('prompt.id', 'turn-1'),
            kv('request_id', 'req-1'),
            kv('query_source', 'Explore'),
            kv('model', 'claude-sonnet-4-6'),
            kv('input_tokens', 100),
            kv('cache_read_tokens', 80),
            kv('output_tokens', 12),
            kv('cost_usd', '0.0042')
          ]
        }] }]
      }]
    };
    const calls = normalizeOtlpLogs(payload, {
      correlate: () => ({
        agentId: 'agent-77',
        parentAgentId: 'main',
        git: { repository: 'billing', branch: 'feature/PAY-142', commit: 'abc' },
        featureCandidates: [{ type: 'ticket', value: 'PAY-142', source: 'git.branch' }]
      })
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      event: { type: 'llm.call' },
      call_id: 'req-1',
      session_id: 'sess-1',
      turn_id: 'turn-1',
      agent_id: 'agent-77',
      parent_agent_id: 'main',
      agent_type: 'Explore',
      branch: 'feature/PAY-142',
      jira_ids: ['PAY-142'],
      input_tokens: 100,
      cached_input_tokens: 80,
      output_tokens: 12,
      cost_usd: 0.0042
    });
  });

  it('normalizes Codex response.completed and uses the child thread as agent identity', () => {
    const payload = {
      resourceLogs: [{ scopeLogs: [{ logRecords: [{
        timeUnixNano: '1786118400000000000',
        attributes: [
          kv('event.name', 'codex.sse_event'),
          kv('event.type', 'response.completed'),
          kv('conversation.id', 'root-thread'),
          kv('thread.id', 'child-thread'),
          kv('turn.id', 'turn-2'),
          kv('response.id', 'resp-2'),
          kv('model', 'gpt-5.6-codex'),
          kv('input_tokens', 200),
          kv('cached_input_tokens', 150),
          kv('output_tokens', 20),
          kv('reasoning_output_tokens', 7)
        ]
      }] }] }]
    };
    expect(normalizeOtlpLogs(payload, {
      correlate: ({ threadId }) => threadId === 'child-thread'
        ? { sessionId: 'root-thread', turnId: 'root-turn', parentAgentId: 'root-thread' }
        : undefined
    })[0]).toMatchObject({
      provider: 'codex',
      call_id: 'resp-2',
      session_id: 'root-thread',
      turn_id: 'root-turn',
      provider_turn_id: 'turn-2',
      agent_id: 'child-thread',
      parent_agent_id: 'root-thread',
      correlation: 'exact',
      reasoning_output_tokens: 7
    });
  });

  it('does not classify provider-qualified Codex api_request logs as Claude', () => {
    const payload = {
      resourceLogs: [{ scopeLogs: [{ logRecords: [{
        timeUnixNano: '1786118400000000000',
        attributes: [
          kv('event.name', 'codex.api_request'),
          kv('conversation.id', 'codex-session'),
          kv('session.id', 'compat-session'),
          kv('request_id', 'codex-request'),
          kv('input_tokens', 10)
        ]
      }] }] }]
    };
    expect(normalizeOtlpLogs(payload)[0]).toMatchObject({
      provider: 'codex',
      call_id: 'codex-request',
      session_id: 'codex-session'
    });
  });

  it('uses raw OTLP record identity when deriving ids for concurrent calls', () => {
    const record = (timeUnixNano: string, inputTokens: number) => ({
      timeUnixNano,
      attributes: [
        kv('event.name', 'claude_code.api_request'),
        kv('session.id', 'sess-concurrent'),
        kv('prompt.id', 'turn-concurrent'),
        kv('model', 'claude-sonnet-4-6'),
        kv('input_tokens', inputTokens)
      ]
    });
    const payload = {
      resourceLogs: [{ scopeLogs: [{ logRecords: [
        record('1786118400000000000', 10),
        record('1786118400000000001', 20)
      ] }] }]
    };
    const calls = normalizeOtlpLogs(payload);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.ended_at).toBe(calls[1]?.ended_at);
    expect(calls[0]?.call_id).not.toBe(calls[1]?.call_id);
  });

  it('turn.summary and llm.call agree on the public agent.provider label', () => {
    const summary = buildTurnSummary({
      provider: 'claude', surface: 'cli', sessionId: 'sess-1', turnId: 'turn-1',
      prompts: [], tools: [], endedAt: '2026-08-07T12:00:00.000Z'
    });
    const call = buildLlmCall({
      provider: 'claude-code', surface: 'cli', callId: 'req-1', sessionId: 'sess-1', turnId: 'turn-1',
      correlation: 'turn', endedAt: summary.ended_at
    });
    expect(summary.agent).toEqual({ provider: 'claude-code', name: 'claude-code' });
    expect(summary.agent.provider).toBe(call.agent.provider);
  });

  it('deduplicates calls and finalizes a separate subagent breakdown', () => {
    const summary = buildTurnSummary({
      provider: 'claude',
      surface: 'cli',
      sessionId: 'sess-1',
      turnId: 'turn-1',
      prompts: [],
      tools: [],
      endedAt: '2026-08-07T12:00:00.000Z'
    });
    const main = buildLlmCall({
      provider: 'claude-code', surface: 'cli', callId: 'req-main', sessionId: 'sess-1', turnId: 'turn-1',
      agentId: 'main', agentType: 'repl_main_thread', correlation: 'turn', endedAt: summary.ended_at,
      usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 }, costUsd: 0.01
    });
    const child = buildLlmCall({
      provider: 'claude-code', surface: 'cli', callId: 'req-child', sessionId: 'sess-1', turnId: 'turn-1',
      agentId: 'agent-77', parentAgentId: 'main', agentType: 'Explore', correlation: 'turn', endedAt: summary.ended_at,
      usage: { inputTokens: 50, outputTokens: 5, totalTokens: 55 }, costUsd: 0.005
    });

    const finalized = aggregateTurnUsage(summary, [main, child, child], { complete: true });
    expect(finalized).toMatchObject({
      llm_calls: 2,
      input_tokens: 150,
      output_tokens: 15,
      total_tokens: 165,
      cost_usd: 0.015,
      usage_status: 'complete'
    });
    expect(finalized.agent_usage).toEqual([
      expect.objectContaining({ agent_id: 'main', llm_calls: 1, input_tokens: 100 }),
      expect.objectContaining({ agent_id: 'agent-77', parent_agent_id: 'main', agent_type: 'Explore', llm_calls: 1, input_tokens: 50 })
    ]);
  });

  it('merges duplicate observations without double-counting or losing fields', () => {
    const summary = buildTurnSummary({
      provider: 'codex', surface: 'cli', sessionId: 'sess', turnId: 'turn', prompts: [], tools: [],
      endedAt: '2026-08-07T12:00:00.000Z'
    });
    const request = buildLlmCall({
      provider: 'codex', surface: 'cli', callId: 'req', sessionId: 'sess', turnId: 'turn',
      correlation: 'turn', endedAt: summary.ended_at, durationMs: 200
    });
    const completion = buildLlmCall({
      provider: 'codex', surface: 'cli', callId: 'req', sessionId: 'sess', turnId: 'turn',
      correlation: 'turn', endedAt: summary.ended_at, usage: { inputTokens: 10, outputTokens: 2 }
    });

    expect(aggregateTurnUsage(summary, [request, completion], { complete: true })).toMatchObject({
      llm_calls: 1,
      input_tokens: 10,
      output_tokens: 2,
      usage_status: 'complete'
    });
  });

  it('falls back to observedTimeUnixNano when timeUnixNano is the proto3 "0" sentinel', () => {
    const payload = {
      resourceLogs: [{ scopeLogs: [{ logRecords: [{
        timeUnixNano: '0',
        observedTimeUnixNano: '1786118400000000000',
        attributes: [
          kv('event.name', 'claude_code.api_request'),
          kv('session.id', 'sess-observed'),
          kv('request_id', 'req-observed'),
          kv('input_tokens', 5)
        ]
      }] }] }]
    };
    expect(normalizeOtlpLogs(payload)[0]?.ended_at).toBe(new Date(1786118400000).toISOString());
  });

  it('a record with an unparseable timestamp + duration no longer aborts the batch', () => {
    const malformed = {
      timeUnixNano: '0',
      attributes: [
        kv('event.name', 'claude_code.api_request'),
        kv('session.id', 'sess-bad'),
        kv('request_id', 'req-bad'),
        // Numeric epoch-millis attribute: Date.parse yields NaN, which used to
        // make new Date(NaN - duration).toISOString() throw for the whole batch.
        kv('timestamp', 1723372800000),
        kv('duration_ms', 250),
        kv('input_tokens', 5)
      ]
    };
    const healthy = {
      timeUnixNano: '1786118400000000000',
      attributes: [
        kv('event.name', 'claude_code.api_request'),
        kv('session.id', 'sess-ok'),
        kv('request_id', 'req-ok'),
        kv('input_tokens', 7)
      ]
    };
    const payload = { resourceLogs: [{ scopeLogs: [{ logRecords: [malformed, healthy] }] }] };
    const calls = normalizeOtlpLogs(payload);
    expect(calls.some((call) => call.call_id === 'req-ok')).toBe(true);
  });

  it('joins session-correlated calls into the turn through its time window', () => {
    const summary = buildTurnSummary({
      provider: 'claude', surface: 'cli', sessionId: 'sess', turnId: 'turn-1',
      prompts: [{ kind: 'prompt', at: '2026-08-07T12:00:00.000Z', turnId: 'turn-1' }], tools: [],
      endedAt: '2026-08-07T12:05:00.000Z'
    });
    const inWindow = buildLlmCall({
      provider: 'claude-code', surface: 'cli', callId: 'in-window', sessionId: 'sess',
      correlation: 'session', usage: { inputTokens: 40, outputTokens: 4 }, endedAt: '2026-08-07T12:01:00.000Z'
    });
    const beforeTurn = buildLlmCall({
      provider: 'claude-code', surface: 'cli', callId: 'before', sessionId: 'sess',
      correlation: 'session', usage: { inputTokens: 999 }, endedAt: '2026-08-07T11:59:00.000Z'
    });
    expect(aggregateTurnUsage(summary, [inWindow, beforeTurn], { sessionSummaries: [summary], complete: true })).toMatchObject({
      llm_calls: 1,
      input_tokens: 40,
      output_tokens: 4,
      usage_status: 'complete'
    });
  });

  it('performs no window join at all without the session summary set', () => {
    // A lone summary cannot arbitrate ownership against summaries it cannot
    // see: claiming every contained call would double-count overlapping
    // windows across successive finalizations. Only exact turn ids match.
    const summary = buildTurnSummary({
      provider: 'claude', surface: 'cli', sessionId: 'sess', turnId: 'turn-1',
      prompts: [{ kind: 'prompt', at: '2026-08-07T12:00:00.000Z', turnId: 'turn-1' }], tools: [],
      endedAt: '2026-08-07T12:05:00.000Z'
    });
    const inWindow = buildLlmCall({
      provider: 'claude-code', surface: 'cli', callId: 'in-window', sessionId: 'sess',
      correlation: 'session', usage: { inputTokens: 40 }, endedAt: '2026-08-07T12:01:00.000Z'
    });
    expect(aggregateTurnUsage(summary, [inWindow])).toEqual(summary);
  });

  it('never claims earlier session calls for a summary without a lower time bound', () => {
    // A summary with neither turn id nor started_at cannot bound its window;
    // joining would double-count the same calls across successive summaries.
    const summary = buildTurnSummary({
      provider: 'claude', surface: 'cli', sessionId: 'sess', prompts: [], tools: [],
      endedAt: '2026-08-07T12:05:00.000Z'
    });
    const earlier = buildLlmCall({
      provider: 'claude-code', surface: 'cli', callId: 'earlier', sessionId: 'sess',
      correlation: 'session', usage: { inputTokens: 100 }, endedAt: '2026-08-07T11:00:00.000Z'
    });
    expect(aggregateTurnUsage(summary, [earlier])).toEqual(summary);
  });

  it('attributes an overlapping-window call to exactly one summary when the session set is given', () => {
    const turnA = buildTurnSummary({
      provider: 'claude', surface: 'cli', sessionId: 'sess', turnId: 'a',
      prompts: [{ kind: 'prompt', at: '2026-08-07T12:00:00.000Z', turnId: 'a' }], tools: [],
      endedAt: '2026-08-07T12:10:00.000Z'
    });
    // Prompt B raced in while A was still running: windows overlap.
    const turnB = buildTurnSummary({
      provider: 'claude', surface: 'cli', sessionId: 'sess', turnId: 'b',
      prompts: [{ kind: 'prompt', at: '2026-08-07T12:05:00.000Z', turnId: 'b' }], tools: [],
      endedAt: '2026-08-07T12:15:00.000Z'
    });
    const overlapping = buildLlmCall({
      provider: 'claude-code', surface: 'cli', callId: 'in-overlap', sessionId: 'sess',
      correlation: 'session', usage: { inputTokens: 70 }, endedAt: '2026-08-07T12:07:00.000Z'
    });

    const sessionSummaries = [turnA, turnB];
    // The newer prompt owns the ambiguous overlap, mirroring the transcript path.
    expect(aggregateTurnUsage(turnA, [overlapping], { sessionSummaries })).toEqual(turnA);
    expect(aggregateTurnUsage(turnB, [overlapping], { sessionSummaries })).toMatchObject({ input_tokens: 70, llm_calls: 1 });
  });

  it('lets a degraded summary without started_at claim only calls no bounded summary contains', () => {
    const bounded = buildTurnSummary({
      provider: 'claude', surface: 'cli', sessionId: 'sess', turnId: 'a',
      prompts: [{ kind: 'prompt', at: '2026-08-07T12:00:00.000Z', turnId: 'a' }], tools: [],
      endedAt: '2026-08-07T12:10:00.000Z'
    });
    // Fallback summary emitted when turn state was unreadable: no prompts,
    // no turn id, no started_at.
    const degraded = buildTurnSummary({
      provider: 'claude', surface: 'cli', sessionId: 'sess', prompts: [], tools: [],
      endedAt: '2026-08-07T12:20:00.000Z'
    });
    const insideBounded = buildLlmCall({
      provider: 'claude-code', surface: 'cli', callId: 'inside', sessionId: 'sess',
      correlation: 'session', usage: { inputTokens: 10 }, endedAt: '2026-08-07T12:05:00.000Z'
    });
    const afterBounded = buildLlmCall({
      provider: 'claude-code', surface: 'cli', callId: 'after', sessionId: 'sess',
      correlation: 'session', usage: { inputTokens: 20 }, endedAt: '2026-08-07T12:12:00.000Z'
    });

    const sessionSummaries = [bounded, degraded];
    expect(aggregateTurnUsage(bounded, [insideBounded, afterBounded], { sessionSummaries })).toMatchObject({ input_tokens: 10, llm_calls: 1 });
    expect(aggregateTurnUsage(degraded, [insideBounded, afterBounded], { sessionSummaries, complete: true })).toMatchObject({ input_tokens: 20, llm_calls: 1, usage_status: 'complete' });
  });

  it('rejects window joins for calls with unparseable timestamps', () => {
    const summary = buildTurnSummary({
      provider: 'claude', surface: 'cli', sessionId: 'sess', turnId: 'a',
      prompts: [{ kind: 'prompt', at: '2026-08-07T12:00:00.000Z', turnId: 'a' }], tools: [],
      endedAt: '2026-08-07T12:10:00.000Z'
    });
    const garbage = {
      ...buildLlmCall({
        provider: 'claude-code', surface: 'cli', callId: 'garbage', sessionId: 'sess',
        correlation: 'session', usage: { inputTokens: 999 }, endedAt: '2026-08-07T12:05:00.000Z'
      }),
      ended_at: 'not-a-timestamp'
    };
    expect(aggregateTurnUsage(summary, [garbage], { sessionSummaries: [summary] })).toEqual(summary);
    expect(aggregateTurnUsage(summary, [garbage])).toEqual(summary);
  });

  it('keeps provisional transcript usage when matched calls carry no token data', () => {
    const summary = buildTurnSummary({
      provider: 'claude', surface: 'cli', sessionId: 'sess', turnId: 'turn-1', prompts: [], tools: [],
      usage: { inputTokens: 30, outputTokens: 4 }, endedAt: '2026-08-07T12:00:00.000Z'
    });
    const tokenless = buildLlmCall({
      provider: 'claude-code', surface: 'cli', callId: 'failed-call', sessionId: 'sess', turnId: 'turn-1',
      correlation: 'turn', status: 'failed', endedAt: summary.ended_at
    });
    const finalized = aggregateTurnUsage(summary, [tokenless]);
    expect(finalized).toMatchObject({
      llm_calls: 1,
      input_tokens: 30,
      output_tokens: 4,
      // A ledger with no usage cannot vouch for completeness.
      usage_status: 'provisional'
    });
  });

  it('does not finalize or erase provisional usage when no ledger call matches the turn', () => {
    const summary = buildTurnSummary({
      provider: 'claude', surface: 'cli', sessionId: 'sess', turnId: 'expected', prompts: [], tools: [],
      usage: { inputTokens: 30, outputTokens: 4 }, endedAt: '2026-08-07T12:00:00.000Z'
    });
    const wrongTurn = buildLlmCall({
      provider: 'claude-code', surface: 'cli', callId: 'wrong', sessionId: 'sess', turnId: 'other',
      correlation: 'turn', usage: { inputTokens: 100 }, endedAt: summary.ended_at
    });
    const missingTurn = buildLlmCall({
      provider: 'claude-code', surface: 'cli', callId: 'missing', sessionId: 'sess',
      correlation: 'session', usage: { inputTokens: 200 }, endedAt: summary.ended_at
    });
    expect(aggregateTurnUsage(summary, [wrongTurn, missingTurn])).toEqual(summary);
    expect(summary).toMatchObject({ input_tokens: 30, output_tokens: 4, usage_status: 'provisional' });
    expect(summary.llm_calls).toBeUndefined();
  });
});
