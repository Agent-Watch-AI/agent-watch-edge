import path from 'node:path';
import { asRecord } from '../core/object.js';
import { applyProductCapture } from '../privacy/product-capture.js';
import { debugLog } from '../core/logger.js';
import { next, runFlow, step, stop } from '../core/pipe.js';
import type { FlowResult, Step, StepOutcome } from '../core/types/core.types.js';
import { loadEffectiveConfig } from '../config/repo-config.js';
import { selectRoot, servesMultipleIdentities } from '../config/root-config.js';
import { DECISION_BLOCK } from '../enforcement/constants/enforcement.constants.js';
import { enforcementWouldAsk, resolveEnforcement } from '../enforcement/enforcement.js';
import { enrichEvents } from '../events/enrich.js';
import type { AgentWatchEvent } from '../events/types/events.types.js';
import { readGateCheckout, type GateCheckout } from '../git/gate-checkout.js';
import { checkoutRootOf } from '../git/checkout-root.js';
import { normalizeRemote } from '../git/remote-sanitize.js';
import { developerIdentity, runGit } from '../git/git-context.js';
import { shellDirectories } from '../providers/shared/shell-directories.js';
import { runSnapshotPipeline } from '../snapshot/snapshot-pipeline.js';
import { SnapshotStateStore } from '../snapshot/snapshot-state.js';
import { SNAPSHOT_BUDGET_MS } from '../snapshot/constants/snapshot.constants.js';
import { BackendAuthBlock } from '../transport/auth-block.js';
import { BackendCooldown } from '../transport/cooldown.js';
import { DeliveryStats } from '../transport/delivery-stats.js';
import { deliverEvents } from '../transport/delivery.js';
import { HttpTransport } from '../transport/http-transport.js';
import { EventQueue } from '../transport/queue.js';
import { identityPaths, settleLegacyQueue } from '../transport/queue-partition.js';
import type { EventTransport } from '../transport/types/transport.types.js';
import { eventsUrl } from '../config/config.js';
import { TurnStateStore } from '../turns/turn-state.js';
import { SHELL_REREAD_TYPES, TOOL_START_TYPES } from '../turns/constants/turns.constants.js';
import type { WorkCheckoutMemo } from '../turns/types/turn-state.types.js';
import { trackTurnOutcome, type TurnOutcome } from '../turns/turn-tracker.js';
import {
  PAYLOAD_CWD_KEY,
  PROMPT_SUBMITTED_TYPE,
  STAGE_DELIVER,
  STAGE_ENFORCE,
  STAGE_ENRICH,
  MAX_WORKSPACE_ROOTS,
  STAGE_NOMINATE,
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
  step(STAGE_NOMINATE, nominate),
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
    config: input.globalConfig.config,
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
  const effective = await loadEffectiveConfig(state.paths, state.cwd, state.globalConfig);

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
 * Name the checkouts a shell call is about to work in.
 *
 * The only place the edge reads a shell command. It is read in memory for
 * directory names, each name becomes the real root of the checkout it lies in,
 * and only those roots go on: the command and every directory in it go out of
 * scope here, and nothing — not the state, an event, a record or a log line —
 * holds either. A failure logs a fixed sentence, never its error, which could
 * quote a path.
 *
 * A working directory the agent names for the call (Codex `workdir`, Cursor's
 * shell `cwd`) is nominated as it stands, and the command's relative paths are
 * read against it. The folders an agent has open (Cursor's workspace roots) are
 * candidates too, but weak ones: they say where the agent sits, not what the
 * call named.
 *
 * Only on a tool-start hook, or a tool call's completion, failed or not (a shell
 * command may have created the worktree it named; `shellCall` answers only for
 * a shell), and only while git capture is on: which checkout a
 * turn worked in is git metadata, and a developer who turned that off said no.
 * Open folders are read on a tool start only.
 *
 * @param state - Current flow state.
 * @returns The state, with the named checkouts' roots.
 */
async function nominate(state: HookPipelineState): Promise<StepOutcome<HookPipelineState>> {
  const start = state.events.some((event) => TOOL_START_TYPES.has(event.event.type));

  if (!state.config.capture.git || (!start && !state.events.some((event) => SHELL_REREAD_TYPES.has(event.event.type)))) return next(state);

  try {
    const call = state.provider.shellCall?.(state.payload);
    // Untrusted: only an absolute directory is taken, never one resolved against a guess.
    const workdir = typeof call?.workdir === 'string' && path.isAbsolute(call.workdir) ? call.workdir : undefined;
    const named = [
      ...(workdir ? [workdir] : []),
      ...(typeof call?.command === 'string' && call.command ? shellDirectories(call.command, workdir ?? state.cwd, state.env.home) : [])
    ];
    // ponytail: the first few open folders only, so weak candidates never fill a
    // turn's checkout slots before a call names one; a wider window loses the rest.
    const open = [...new Set((start ? (state.provider.workspaceRoots?.(state.payload) ?? []) : []).filter((root) => typeof root === 'string' && path.isAbsolute(root)))].slice(
      0,
      MAX_WORKSPACE_ROOTS
    );
    const [nominations, workspaceRoots] = await Promise.all([checkoutRoots(named), checkoutRoots(open)]);

    return next({ ...state, nominations, workspaceRoots });
  } catch {
    debugLog('shell nomination failed; this call names no checkout');

    return next(state);
  }
}

/**
 * The distinct checkout roots a list of paths lies in, `stat`s only.
 *
 * @param paths - Absolute paths.
 * @returns Canonical roots, in first-seen order.
 */
async function checkoutRoots(paths: readonly string[]): Promise<string[]> {
  const roots = await Promise.all(paths.map(checkoutRootOf));

  return [...new Set(roots.filter((root): root is string => root !== undefined))];
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
  if (state.dryRun || !state.provider.getBlockResponse) return next(state);

  const prompt = turnGateEvent(state);

  if (!prompt) return next(state);

  // Nothing below is paid for on a machine that would not ask. Working out which
  // checkout this is costs a walk of the working copy and, once per checkout, a
  // git process — small, and still the wrong thing to spend on a developer whose
  // organization set no cap.
  if (!enforcementWouldAsk(state.config)) return next(state);

  // Together, not in turn. Each can cost its own git timeout, and taken in order
  // a slow machine pays both before the agent's first token. Resolving the
  // identity first would save a checkout lookup only on a machine that has no
  // identity at all — a rare and stable condition — at the price of doubling the
  // worst case for everyone else. The session's model joins them for the same
  // reason: it is one small file, and it is still a file.
  const [developerId, checkout, model] = await Promise.all([
    developerIdentity(state.config.developerEmail, state.cwd, { home: state.env.home }),
    gateCheckout(state, prompt),
    statedModel(state, prompt)
  ]);

  const decision = await resolveEnforcement({
    config: state.config,
    paths: state.paths,
    developerId,
    checkout,
    model,
    now: state.env.now
  });

  if (decision.decision !== DECISION_BLOCK) return next({ ...state, failOpenReason: decision.failOpenReason });

  return next({ ...state, blockMessage: decision.message });
}

/**
 * The event that makes this payload the moment before the turn's first LLM
 * call, if it is one.
 *
 * @param state - Current flow state.
 * @returns The submitted prompt, or undefined when this hook is not a gate.
 */
function turnGateEvent(state: HookPipelineState): AgentWatchEvent | undefined {
  for (const event of state.events) {
    if (event.event.type === PROMPT_SUBMITTED_TYPE) return event;
  }

  return undefined;
}

/**
 * The checkout to state on the gate request.
 *
 * From a session's second turn on, the checkout its last turn changed, wherever
 * the agent sits now: a spinoff parked in the docs repository that edits a
 * feature worktree is working on that feature. The turn tracker wrote down the
 * checkout's root and repository, so this costs one small file and the same
 * `.git` walk as today, and the branch is still read from `HEAD` on disk, so a
 * switch since that turn is seen. No git process: the repository is the one
 * remembered.
 *
 * Only a checkout the asking tenant's root governs: the config (and so the token)
 * asking here comes from the folder the agent sits in, and another tenant's
 * repository must never travel on it. With no roots there is one tenant, and the
 * tracker only remembered a checkout beneath the session's start folder.
 *
 * Anything missing, unreadable, gone or on a detached HEAD answers exactly what
 * today's lookup of the agent's own folder answers.
 *
 * @param state - Current flow state.
 * @param prompt - The prompt event being gated.
 * @returns The checkout, or undefined when none is known.
 */
async function gateCheckout(state: HookPipelineState, prompt: AgentWatchEvent): Promise<GateCheckout | undefined> {
  const base = { checkoutsDir: state.paths.checkoutsDir, now: state.env.now };
  const work = await lastWorkCheckout(state, prompt.session.id);
  const carried = work && await readGateCheckout({ ...base, cwd: work.root, repository: work.repository });

  return carried ?? readGateCheckout({ ...base, cwd: state.cwd });
}

/**
 * The session's last changed checkout, when the asking tenant may name it.
 *
 * @param state - Current flow state.
 * @param sessionId - Provider session id, if the prompt has one.
 * @returns The remembered checkout, or undefined.
 */
async function lastWorkCheckout(state: HookPipelineState, sessionId: string | undefined): Promise<WorkCheckoutMemo | undefined> {
  if (!sessionId) return undefined;

  try {
    const work = await new TurnStateStore(state.paths.turnsDir).readWorkCheckout(sessionId);
    const roots = state.globalConfig.config.roots;

    // Only a value already in the canonical, credential-free form git capture
    // produces: a checkout with no remote is remembered by its folder name, which
    // names no repository (today's gate states nothing for it either), and a
    // damaged or hand-edited file must never put anything else on the request.
    if (!work || normalizeRemote(`https://${work.repository}`) !== work.repository) return undefined;

    return selectRoot(roots, work.root)?.path === selectRoot(roots, state.cwd)?.path ? work : undefined;
  } catch {
    // A fixed sentence: the error could quote a path.
    debugLog('enforcement: last work checkout unreadable; asking about the current folder');

    return undefined;
  }
}

/**
 * The model to state on the gate request.
 *
 * Codex, Cursor, Gemini and Antigravity name their model on the prompt hook
 * itself. Claude Code names it only when the session starts, so the tracker
 * wrote it down and this reads it back — one small file, inside the same
 * `Promise.all` as identity and checkout, so it adds no serial wait to the gate.
 *
 * Anything that goes wrong states nothing: the model narrows the question, and a
 * question asked without it is still answered.
 *
 * @param state - Current flow state.
 * @param prompt - The prompt event being gated.
 * @returns The model, or undefined when none is known.
 */
async function statedModel(state: HookPipelineState, prompt: AgentWatchEvent): Promise<string | undefined> {
  if (prompt.ai?.model) return prompt.ai.model;

  const sessionId = prompt.session.id;

  if (!sessionId) return undefined;

  try {
    return await new TurnStateStore(state.paths.turnsDir).readModel(sessionId);
  } catch (error) {
    debugLog('enforcement: session model unreadable; stating none:', error);

    return undefined;
  }
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
  const { summary, workRoot, capture } = await trackTurnSafely(state);
  // Re-applied under the reported checkout's own policy when it has one: that
  // checkout's file decides what is said about it, not the folder the Stop ran in.
  const workCapture = capture ?? state.config.capture;
  const gated = summary && state.config.emit.turnSummaries ? applyProductCapture(summary, workCapture) : undefined;
  const outbound = gated ? [gated] : [];

  return next({ ...state, summary, workRoot, workCapture, outbound });
}

/**
 * Assemble the turn, degrading to no summary on any failure.
 *
 * @param state - Current flow state.
 * @returns The summary and the local root it reported, or neither.
 */
async function trackTurnSafely(state: HookPipelineState): Promise<TurnOutcome> {
  try {
    return await trackTurnOutcome({
      agentId: state.provider.id,
      rawPayload: state.payload,
      events: state.events,
      config: state.config,
      globalConfig: state.globalConfig,
      paths: state.paths,
      turnsDir: state.paths.turnsDir,
      locksDir: state.paths.locksDir,
      env: state.env,
      cwd: state.cwd,
      readOnly: state.dryRun,
      failOpenReason: state.failOpenReason,
      nominations: state.nominations,
      workspaceRoots: state.workspaceRoots
    });
  } catch (error) {
    debugLog('turn summary failed:', error);

    return {};
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

  // `globalConfig`, not `config`: roots are stripped from the effective config
  // once applied, and the question is what the *machine* sends as.
  await settleLegacyQueue(state.paths.queueDir, state.config.token, servesMultipleIdentities(state.globalConfig.config));

  const identity = identityPaths(state.paths, state.config.token);
  const delivery = await deliverEvents(
    state.outbound,
    buildTransport(state),
    buildQueue(state),
    state.config.delivery.drainBatchSize,
    new BackendCooldown(identity.cooldownFile, state.env.now),
    new DeliveryStats(identity.statsFile, state.env.now, state.paths.locksDir),
    new BackendAuthBlock(identity.authBlockFile, state.env.now)
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

  if (!repository || !(state.workCapture ?? state.config.capture).git) return stop(state, STOP_NO_SNAPSHOT);

  await runSnapshotPipeline({
    input: {
      // The checkout the summary named, which need not be the folder the agent sits in.
      cwd: state.workRoot ?? state.cwd,
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
 * The offline queue for this run, partitioned by the identity it sends as.
 * `deliver` settles a pre-partition backlog before the first build.
 *
 * @param state - Current flow state.
 * @returns A queue bound to this run's paths and delivery limits.
 */
function buildQueue(state: HookPipelineState): EventQueue {
  const identity = identityPaths(state.paths, state.config.token);

  return new EventQueue({
    queueDir: identity.queueDir,
    locksDir: state.paths.locksDir,
    maxEvents: state.config.delivery.maxQueueEvents,
    maxAttempts: state.config.delivery.maxAttempts,
    maxEventAgeDays: state.config.delivery.maxEventAgeDays,
    now: state.env.now,
    // So the entries the bound sacrifices are counted wherever an enqueue
    // happens, the snapshot pipeline's included.
    stats: new DeliveryStats(identity.statsFile, state.env.now, state.paths.locksDir)
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
    capture: state.config.capture,
    token: state.config.token,
    installationId: state.config.installationId,
    timeoutMs: state.config.delivery.timeoutMs,
    budgetMs: state.config.delivery.timeoutMs
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
