import path from 'node:path';
import { asRecord } from '../core/object.js';
import { debugLog } from '../core/logger.js';
import { next, runFlow, step, stop } from '../core/pipe.js';
import type { FlowResult, Step, StepOutcome } from '../core/types/core.types.js';
import { loadEffectiveConfig } from '../config/repo-config.js';
import { DECISION_BLOCK } from '../enforcement/constants/enforcement.constants.js';
import { enforcementWouldAsk, resolveEnforcement } from '../enforcement/enforcement.js';
import { enrichEvents } from '../events/enrich.js';
import { readGateCheckout } from '../git/gate-checkout.js';
import { developerIdentity, runGit } from '../git/git-context.js';
import { runSnapshotPipeline } from '../snapshot/snapshot-pipeline.js';
import { SnapshotStateStore } from '../snapshot/snapshot-state.js';
import { SNAPSHOT_BUDGET_MS } from '../snapshot/constants/snapshot.constants.js';
import { BackendCooldown } from '../transport/cooldown.js';
import { DeliveryStats } from '../transport/delivery-stats.js';
import { deliverEvents } from '../transport/delivery.js';
import { HttpTransport } from '../transport/http-transport.js';
import { EventQueue } from '../transport/queue.js';
import { COOLDOWN_FILE_NAME, DELIVERY_STATS_FILE_NAME } from '../transport/constants/transport.constants.js';
import type { EventTransport } from '../transport/types/transport.types.js';
import { eventsUrl } from '../config/config.js';
import { trackTurn } from '../turns/turn-tracker.js';
import {
  PAYLOAD_CWD_KEY,
  PROMPT_SUBMITTED_TYPE,
  STAGE_DELIVER,
  STAGE_ENFORCE,
  STAGE_ENRICH,
  STAGE_PARSE_EVENTS,
  STAGE_RESOLVE_CONTEXT,
  STAGE_SNAPSHOT,
  STAGE_TRACK_TURN,
  STOP_DRY_RUN,
  STOP_NO_EVENTS,
  STOP_NO_SNAPSHOT
} from './constants/pipeline.constants.js';
import type { HookPipelineInput, HookPipelineState } from './types/pipeline.types.js';

export type { HookPipelineInput, HookPipelineState } from './types/pipeline.types.js';

/**
 * The hook flow, as the list of stages it is.
 *
 * Read top to bottom, this is the whole contract of the hook path: work out
 * where we are and what the effective config says, turn the payload into
 * canonical events, ask whether this turn may start at all, attach development
 * context, assemble the turn, deliver, and — when a turn has just closed — tell
 * the platform what this repository's recent branches look like.
 * Every stage takes the whole state and returns the next one, so adding or
 * reordering a step is a change to this array rather than to a call graph.
 */
const HOOK_STAGES: readonly Step<HookPipelineState>[] = [
  step(STAGE_RESOLVE_CONTEXT, resolveContext),
  step(STAGE_PARSE_EVENTS, parseEvents),
  step(STAGE_ENFORCE, enforce),
  step(STAGE_ENRICH, enrich),
  step(STAGE_TRACK_TURN, trackTurnStage),
  step(STAGE_DELIVER, deliver),
  step(STAGE_SNAPSHOT, snapshot)
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
 * Ask the platform whether this turn may start.
 *
 * Only the prompt hook is a gate, and only a provider that knows how to refuse
 * one is asked about: everything else skips the check entirely, so no tool hook
 * pays for it. A refusal lands in the state as a sentence to show; every failure
 * of the check leaves the state untouched, which is what makes an unreachable
 * platform a no-op rather than an outage.
 *
 * A dry run never asks. It previews what would be sent, and rehearsing a refusal
 * would block a developer for a command that promised to change nothing.
 *
 * @param state - Current flow state.
 * @returns The state, carrying the refusal when there is one.
 */
async function enforce(state: HookPipelineState): Promise<StepOutcome<HookPipelineState>> {
  if (state.dryRun || !state.provider.getBlockResponse || !isTurnGate(state)) return next(state);

  // Nothing below is paid for on a machine that would not ask. Working out which
  // checkout this is costs a walk of the working copy and, once per checkout, a
  // git process — small, and still the wrong thing to spend on a developer whose
  // organization set no cap.
  if (!enforcementWouldAsk(state.config)) return next(state);

  // Identity first, and the checkout only if there is someone to ask about. A
  // machine with no identity is allowed without a question being asked, so
  // walking its working copy — and, on a cold checkout, spawning git — would buy
  // an answer nothing reads. Two waits that can each cost a timeout are also two
  // timeouts if they are taken in order for no reason.
  const developerId = await developerIdentity(state.config.developerEmail, state.cwd, {
    home: state.env.home
  });

  if (!developerId) return next(state);

  const decision = await resolveEnforcement({
    config: state.config,
    paths: state.paths,
    developerId,
    checkout: await readGateCheckout({ cwd: state.cwd, checkoutsDir: state.paths.checkoutsDir }),
    now: state.env.now
  });

  if (decision.decision !== DECISION_BLOCK) return next(state);

  return next({ ...state, blockMessage: decision.message });
}

/**
 * Whether this payload is the moment before the turn's first LLM call.
 *
 * @param state - Current flow state.
 * @returns True when the provider reported a submitted prompt.
 */
function isTurnGate(state: HookPipelineState): boolean {
  for (const event of state.events) {
    if (event.event.type === PROMPT_SUBMITTED_TYPE) return true;
  }

  return false;
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
  // A refused prompt never reached a model. Recording it would leave a prompt
  // with no turn behind it, to be folded into whichever turn came next and
  // inflate its prompt; the flow continues so the offline queue still drains.
  if (state.blockMessage) return next(state);

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

  const queue = buildQueue(state);
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
 * Describe the repository's recent branches, after the turn has been delivered.
 *
 * Last, and awaited. Last because it must never delay the spend records, which
 * are the reason the hook exists; awaited because the process exits the moment
 * this returns, and a dangling promise would be killed somewhere between
 * building the event and writing it to the queue.
 *
 * It runs only on a closed turn — the one hook per turn that already pays for
 * full git context — and only when git capture is on: branch names and commit
 * subjects are git metadata, and a developer who turned that off has said no to
 * exactly this.
 *
 * @param state - Current flow state.
 * @returns The state, unchanged. A snapshot never affects the hook's answer.
 */
async function snapshot(state: HookPipelineState): Promise<StepOutcome<HookPipelineState>> {
  const repository = state.summary?.repository;

  if (!repository || !state.config.capture.git) return stop(state, STOP_NO_SNAPSHOT);

  await runSnapshotPipeline({
    input: {
      cwd: state.cwd,
      repository,
      provider: state.summary?.provider ?? state.provider.id,
      surface: state.summary?.surface ?? state.provider.id,
      agentName: state.summary?.agent.name ?? state.provider.id,
      developerId: state.summary?.developer_id,
      installationId: state.config.installationId,
      sessionId: state.summary?.session_id,
      capturedAt: state.env.now().toISOString(),
      // Real time, deliberately, where the line above uses the injected clock:
      // this bounds subprocess timeouts, which are measured against the wall.
      deadline: Date.now() + SNAPSHOT_BUDGET_MS,
      run: runGit
    },
    store: new SnapshotStateStore(state.paths.snapshotsDir),
    queue: buildQueue(state)
  });

  return next(state);
}

/**
 * The offline queue for this run.
 *
 * @param state - Current flow state.
 * @returns A queue bound to this run's paths and delivery limits.
 */
function buildQueue(state: HookPipelineState): EventQueue {
  return new EventQueue({
    queueDir: state.paths.queueDir,
    locksDir: state.paths.locksDir,
    maxEvents: state.config.delivery.maxQueueEvents,
    maxAttempts: state.config.delivery.maxAttempts,
    maxEventAgeDays: state.config.delivery.maxEventAgeDays,
    now: state.env.now
  });
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
