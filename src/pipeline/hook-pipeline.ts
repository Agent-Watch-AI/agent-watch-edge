import path from 'node:path';
import { asRecord } from '../core/object.js';
import { debugLog } from '../core/logger.js';
import { next, runFlow, step, stop } from '../core/pipe.js';
import type { FlowResult, Step, StepOutcome } from '../core/types/core.types.js';
import { loadEffectiveConfig } from '../config/repo-config.js';
import { enrichEvents } from '../events/enrich.js';
import { BackendCooldown } from '../transport/cooldown.js';
import { DeliveryStats } from '../transport/delivery-stats.js';
import { deliverEvents } from '../transport/delivery.js';
import { HttpTransport } from '../transport/http-transport.js';
import { EventQueue } from '../transport/queue.js';
import { COOLDOWN_FILE_NAME, DELIVERY_STATS_FILE_NAME } from '../transport/constants/transport.constants.js';
import type { EventTransport } from '../transport/types/transport.types.js';
import { eventsUrl } from '../config/config.js';
import { trackTurn } from '../turns/turn-tracker.js';
import { PAYLOAD_CWD_KEY, STAGE_DELIVER, STAGE_ENRICH, STAGE_PARSE_EVENTS, STAGE_RESOLVE_CONTEXT, STAGE_TRACK_TURN, STOP_DRY_RUN, STOP_NO_EVENTS } from './constants/pipeline.constants.js';
import type { HookPipelineInput, HookPipelineState } from './types/pipeline.types.js';

export type { HookPipelineInput, HookPipelineState } from './types/pipeline.types.js';

/**
 * The hook flow, as the list of stages it is.
 *
 * Read top to bottom, this is the whole contract of the hook path: work out
 * where we are and what the effective config says, turn the payload into
 * canonical events, attach development context, assemble the turn, deliver.
 * Every stage takes the whole state and returns the next one, so adding or
 * reordering a step is a change to this array rather than to a call graph.
 */
const HOOK_STAGES: readonly Step<HookPipelineState>[] = [
  step(STAGE_RESOLVE_CONTEXT, resolveContext),
  step(STAGE_PARSE_EVENTS, parseEvents),
  step(STAGE_ENRICH, enrich),
  step(STAGE_TRACK_TURN, trackTurnStage),
  step(STAGE_DELIVER, deliver)
];

/**
 * Run one hook payload through the flow.
 *
 * Never throws: a stage that fails ends the flow with whatever the last
 * successful stage produced, because the caller is a hook that must answer the
 * coding agent either way.
 *
 * @param input - Provider, environment, payload and dry-run flag.
 * @returns The final state and where the flow stopped.
 */
export function runHookPipeline(input: HookPipelineInput): Promise<FlowResult<HookPipelineState>> {
  const initial: HookPipelineState = {
    ...input,
    cwd: resolvePayloadCwd(input),
    config: input.globalConfig,
    events: [],
    outbound: []
  };

  return runFlow(HOOK_STAGES, initial, (trace) => {
    if (trace.outcome === 'next') return;

    debugLog(`hook flow ${trace.outcome} at ${trace.step}${trace.reason ? `: ${trace.reason}` : ''}`);
  });
}

/**
 * Apply the repository's `.agentwatch.json` on top of the global config.
 *
 * Repository overrides govern content capture derived from *this* payload;
 * identity, endpoints, emission toggles and delivery tuning stay global-only.
 *
 * @param state - Current flow state.
 * @returns The state with its effective config resolved.
 */
async function resolveContext(state: HookPipelineState): Promise<StepOutcome<HookPipelineState>> {
  const effective = await loadEffectiveConfig(state.paths, state.cwd);

  return next({ ...state, config: effective.config });
}

/**
 * Turn the payload into canonical events.
 *
 * @param state - Current flow state.
 * @returns The state with its events, or a stop when the payload carried none.
 */
async function parseEvents(state: HookPipelineState): Promise<StepOutcome<HookPipelineState>> {
  const events = await state.provider.parseHookEvent(state.payload, { env: state.env, config: state.config });

  if (events.length === 0) return stop(state, STOP_NO_EVENTS);

  return next({ ...state, events });
}

/**
 * Attach development context and scrub the events.
 *
 * @param state - Current flow state.
 * @returns The state with enriched events.
 */
async function enrich(state: HookPipelineState): Promise<StepOutcome<HookPipelineState>> {
  const events = await enrichEvents(state.events, { config: state.config, cwd: state.cwd, home: state.env.home });

  return next({ ...state, events });
}

/**
 * Assemble the turn and decide what leaves this machine.
 *
 * Turn tracking always runs, even when summaries are not emitted: besides
 * producing the summary it resolves token usage for the turn. Only
 * `turn.summary` leaves the hook path — lifecycle events are internal assembly
 * state, and `llm.call` records arrive through the native OTLP path.
 *
 * @param state - Current flow state.
 * @returns The state with its summary and outbound records.
 */
async function trackTurnStage(state: HookPipelineState): Promise<StepOutcome<HookPipelineState>> {
  // Assembly failing must not cost the *queue* its drain: a hook that produced
  // no summary still has a backlog to move, so this stage degrades to "no
  // summary" instead of ending the flow.
  const summary = await trackTurnSafely(state);
  const outbound = summary && state.config.emit.turnSummaries ? [summary] : [];

  return next({ ...state, summary, outbound });
}

/**
 * Assemble the turn, degrading to no summary on any failure.
 *
 * @param state - Current flow state.
 * @returns The summary, or undefined.
 */
async function trackTurnSafely(state: HookPipelineState): Promise<HookPipelineState['summary']> {
  try {
    return await trackTurn({
      agentId: state.provider.id,
      rawPayload: state.payload,
      events: state.events,
      config: state.config,
      turnsDir: state.paths.turnsDir,
      locksDir: state.paths.locksDir,
      env: state.env,
      cwd: state.cwd,
      readOnly: state.dryRun
    });
  } catch (error) {
    debugLog('turn summary failed:', error);

    return undefined;
  }
}

/**
 * Send what this run produced, or queue it.
 *
 * @param state - Current flow state.
 * @returns The state with the delivery outcome, or a stop on a dry run.
 */
async function deliver(state: HookPipelineState): Promise<StepOutcome<HookPipelineState>> {
  if (state.dryRun) return stop(state, STOP_DRY_RUN);

  const queue = new EventQueue({
    queueDir: state.paths.queueDir,
    locksDir: state.paths.locksDir,
    maxEvents: state.config.delivery.maxQueueEvents,
    maxAttempts: state.config.delivery.maxAttempts,
    maxEventAgeDays: state.config.delivery.maxEventAgeDays,
    now: state.env.now
  });
  const delivery = await deliverEvents(
    state.outbound,
    buildTransport(state),
    queue,
    state.config.delivery.drainBatchSize,
    new BackendCooldown(path.join(state.paths.dataDir, COOLDOWN_FILE_NAME), state.env.now),
    new DeliveryStats(path.join(state.paths.dataDir, DELIVERY_STATS_FILE_NAME), state.env.now, state.paths.locksDir)
  );

  debugLog(`delivery: sent=${delivery.delivered} queued=${delivery.queued} drained=${delivery.drained} rejected=${delivery.rejected}`);

  return next({ ...state, delivery });
}

/**
 * The transport for this run, when a backend is configured.
 *
 * @param state - Current flow state.
 * @returns The transport, or undefined before setup has run.
 */
function buildTransport(state: HookPipelineState): EventTransport | undefined {
  const url = eventsUrl(state.config);

  if (!url) return undefined;

  return new HttpTransport({
    eventsUrl: url,
    token: state.config.token,
    installationId: state.config.installationId,
    timeoutMs: state.config.delivery.timeoutMs
  });
}

/**
 * Where this payload happened.
 *
 * Most agents report a top-level `cwd`; a provider that nests it (Antigravity
 * carries `common.workspacePaths`) supplies `resolveCwd`. Without this the git
 * context, the repository `.agentwatch.json` and every branch-derived ticket key
 * would be resolved against whatever directory the hook process happened to
 * start in.
 *
 * @param input - The flow's input.
 * @returns The working directory to use.
 */
function resolvePayloadCwd(input: HookPipelineInput): string {
  const reported = asRecord(input.payload)?.[PAYLOAD_CWD_KEY];

  if (typeof reported === 'string' && reported !== '') return reported;

  const resolved = input.provider.resolveCwd?.(input.payload);

  return typeof resolved === 'string' && resolved !== '' ? resolved : input.env.cwd;
}
