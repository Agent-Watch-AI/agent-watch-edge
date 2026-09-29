import path from 'node:path';
import { pollUntil } from '../core/async.js';
import { debugLog } from '../core/logger.js';
import { asRecord } from '../core/object.js';
import { detectBillingMode } from '../billing/billing-mode.js';
import type { FailOpenReason } from '../enforcement/types/enforcement.types.js';
import type { AgentWatchEvent, ContentEvidence, EventGit, FeatureCandidate, UsageBillingMode } from '../events/types/events.types.js';
import { sha256Hex } from '../events/event-id.js';
import { loadEffectiveConfig } from '../config/repo-config.js';
import { canonicalRoot, selectRoot } from '../config/root-config.js';
import { REPOSITORY_PATH_METADATA_KEY } from '../events/constants/enrich.constants.js';
import { featureCandidatesFromBranch } from '../feature/ticket-candidates.js';
import { collectGitContext, developerDisplayName, developerIdentity } from '../git/git-context.js';
import { isBeneath } from '../git/repository-root.js';
import type { GitContext } from '../git/types/git.types.js';
import { sanitizeValue } from '../privacy/sanitizer.js';
import { acquireLock } from '../storage/lock.js';
import type { ReleaseLock } from '../storage/types/storage.types.js';
import type { Env } from '../core/types/core.types.js';
import { readTurnUsage } from './claude-transcript.js';
import { readCursorTurnUsage } from './cursor-transcript.js';
import {
  CLAUDE_ENTRYPOINT_VAR,
  DEFAULT_SURFACE,
  FILE_PATH_KEY,
  IDE_SURFACE,
  IDE_SURFACE_PROVIDERS,
  LOCK_KEY_HASH_LENGTH,
  PROMPT_EVIDENCE_KEY,
  RESPONSE_EVIDENCE_KEY,
  TOOL_COMPLETION_TYPES,
  TRANSCRIPT_PATH_KEY,
  TURN_STATE_TTL_MS,
  USAGE_LOCK_POLL_MS,
  USAGE_LOCK_WAIT_MS,
  USAGE_RETRY
} from './constants/turns.constants.js';
import { TurnStateStore } from './turn-state.js';
import { buildTurnSummary } from './turn-summary.js';
import type { PromptRecord, ResponseRecord, ToolRecord, TurnRecord, TurnStateEntry } from './types/turn-state.types.js';
import type { TranscriptReader, TurnUsage } from './types/transcript.types.js';
import type { TurnSummaryEvent } from './types/turn-summary.types.js';
import type { TrackTurnOptions, TurnWindow } from './types/turn-tracker.types.js';

export type { TrackTurnOptions } from './types/turn-tracker.types.js';

/**
 * Providers whose transcript can be read for token usage.
 *
 * Claude windows by message timestamps; Cursor rows carry none, so its reader
 * relies solely on the exactly-once message-id ledger (today Cursor rows also
 * carry no usage — the reader returns undefined and the summary stays pending).
 */
const TRANSCRIPT_READERS: Readonly<Record<string, TranscriptReader>> = {
  claude: (transcriptPath, startedAt, untilIso, excludeMessageIds) => readTurnUsage(transcriptPath, startedAt, USAGE_RETRY, untilIso, excludeMessageIds),
  cursor: (transcriptPath, _startedAt, _untilIso, excludeMessageIds) => readCursorTurnUsage(transcriptPath, USAGE_RETRY, excludeMessageIds)
};

/**
 * Accumulate turn state across hook invocations and close the turn on
 * `generation.completed`, producing one flat summary.
 *
 * Best-effort by design: hooks run inside the coding agent, so every failure
 * path here ends in "no summary" or a degraded one, never in a thrown error.
 *
 * @param options - The payload's events, config, paths and clock.
 * @returns The turn summary when this payload closed a turn.
 */
export async function trackTurn(options: TrackTurnOptions): Promise<TurnSummaryEvent | undefined> {
  const store = new TurnStateStore(options.turnsDir);
  let summary: TurnSummaryEvent | undefined;

  for (const event of options.events) {
    const sessionId = event.session.id;

    if (!sessionId) continue;

    try {
      summary = (await processEvent(store, sessionId, event, options)) ?? summary;
    } catch (error) {
      debugLog('turn tracking failed:', error);

      // Closing failed (corrupt turn state, unreadable transcript, IO error):
      // the turn must still reach the backend rather than silently vanish.
      if (event.event.type === 'generation.completed' && !summary) {
        summary = await fallbackSummary(sessionId, event, options);
      }
    }
  }

  return summary;
}

/**
 * Apply one canonical event to the accumulator.
 *
 * @param store - Per-session state store.
 * @param sessionId - Provider session id.
 * @param event - The event to apply.
 * @param options - Tracking options.
 * @returns A summary when this event closed a turn.
 */
async function processEvent(
  store: TurnStateStore,
  sessionId: string,
  event: AgentWatchEvent,
  options: TrackTurnOptions
): Promise<TurnSummaryEvent | undefined> {
  const type = event.event.type;

  // A dry run previews the close and touches nothing: no appends, no consumed
  // records, no usage claims, no sweep.
  if (options.readOnly) {
    if (type !== 'generation.completed') return undefined;

    return closeTurnLocked(store, sessionId, event, options, true);
  }

  // On the session's own hook and no other. Claude names its model only there,
  // which is the whole reason the memo exists; the agents that name it on every
  // hook also name it on that one, so once per session is all it ever takes.
  //
  // Narrow on purpose, twice over. It keeps a per-hook write off the agent's
  // critical path for something no later hook can read — those agents carry the
  // model on the prompt payload the gate already holds. And it keeps the write
  // out of the two invocations that must not be pre-empted: a failure on
  // `generation.completed` would degrade the turn to a fallback summary, and one
  // on `session.ended` would leave a session's raw prompt text undeleted.
  if (type === 'session.started') await rememberModelSafely(store, sessionId, event);

  const record = recordFor(event, options.cwd, options.failOpenReason);

  if (record) await store.append(sessionId, recordKeyFor(event), record);

  if (type === 'generation.completed') {
    const summary = await closeTurn(store, sessionId, event, options);

    await store.sweep(TURN_STATE_TTL_MS);

    return summary;
  }

  if (type === 'session.ended') {
    await store.clear(sessionId);
    await store.sweep(TURN_STATE_TTL_MS);
  }

  return undefined;
}

/**
 * Remember the session's model, or carry on without it.
 *
 * A memo that cannot be written is a gate that states no model, which is the
 * answer it gives for every other reason too. It is never a reason to fail the
 * hook the agent is waiting on.
 *
 * @param store - Per-session state store.
 * @param sessionId - Provider session id.
 * @param event - The session's own event, which may or may not name a model.
 */
async function rememberModelSafely(
  store: TurnStateStore,
  sessionId: string,
  event: AgentWatchEvent
): Promise<void> {
  const model = event.ai?.model;

  try {
    // A start that names no model actively forgets, rather than leaving whatever
    // a previous session under the same id left behind: a SessionEnd cleanup can
    // fail, `--resume` reuses the id, and Claude does not name a model on every
    // start. Inheriting one would make the gate state a model this session is
    // not on.
    await (model ? store.rememberModel(sessionId, model) : store.forgetModel(sessionId));
  } catch (error) {
    debugLog('could not record the session model:', error);
  }
}

/**
 * The turn record one event should be persisted as, if any.
 *
 * @param event - Canonical event.
 * @param cwd - This hook's own working directory.
 * @param failOpenReason - Why this payload's prompt ran unchecked, if it did.
 * @returns The record, or undefined when the event carries no turn state.
 */
function recordFor(event: AgentWatchEvent, cwd: string, failOpenReason: FailOpenReason | undefined): TurnRecord | undefined {
  const type = event.event.type;

  if (type === 'prompt.submitted') return promptRecord(event, failOpenReason);

  if (TOOL_COMPLETION_TYPES.has(type)) return toolRecord(event, cwd);

  // Cursor delivers the response text in its own hook (afterAgentResponse)
  // instead of on Stop; keep it as turn state until the turn closes.
  if (type === 'agent.other' && responseFrom(event) !== undefined) return responseRecord(event);

  return undefined;
}

/**
 * Filename an event's record is stored under.
 *
 * Event ids are payload-derived, so on old Claude versions without a prompt id
 * two identical prompts share one id. Without a turn id the record file must
 * therefore be distinct per submission, or the second append overwrites the
 * first and the second turn closes with no state at all. With a turn id the id
 * already separates turns, and collapsing repeats inside one turn is exactly
 * right: Antigravity has no prompt hook, so the prompt is recorded from the
 * execution's first invocation and a re-fired invocation must not append it
 * twice.
 *
 * @param event - Canonical event.
 * @returns The record key.
 */
function recordKeyFor(event: AgentWatchEvent): string {
  if (event.event.type === 'prompt.submitted' && event.session.turnId) return event.id;

  if (event.event.type === 'prompt.submitted' || event.event.type === 'agent.other') {
    return `${event.id}-${event.timestamp}`;
  }

  return event.id;
}

/**
 * Close a turn under a per-turn lock.
 *
 * Claude can fire duplicate Stops, and two unserialized closers would read the
 * same snapshot and emit the summary twice. Keyed by session+turn so different
 * prompts of one session still close independently.
 *
 * @param store - Per-session state store.
 * @param sessionId - Provider session id.
 * @param stopEvent - The closing event.
 * @param options - Tracking options.
 * @returns The summary, or undefined when another closer holds the lock.
 */
async function closeTurn(
  store: TurnStateStore,
  sessionId: string,
  stopEvent: AgentWatchEvent,
  options: TrackTurnOptions
): Promise<TurnSummaryEvent | undefined> {
  const lockKey = sha256Hex(`${sessionId}::${stopEvent.session.turnId ?? ''}`).slice(0, LOCK_KEY_HASH_LENGTH);
  const release = await acquireLock(options.locksDir, `turn-close-${lockKey}`, options.env.now);

  if (!release) return undefined;

  try {
    return await closeTurnLocked(store, sessionId, stopEvent, options);
  } finally {
    await release();
  }
}

/**
 * Build the summary for a closing turn.
 *
 * Reads as the sequence it is: pick this turn's records, work out the usage
 * window, claim transcript usage, re-collect what landed while we waited, then
 * flatten it all into one summary.
 *
 * @param store - Per-session state store.
 * @param sessionId - Provider session id.
 * @param stopEvent - The closing event.
 * @param options - Tracking options.
 * @param readOnly - Preview only: consume and claim nothing.
 * @returns The summary, or undefined when there is nothing to summarize.
 */
async function closeTurnLocked(
  store: TurnStateStore,
  sessionId: string,
  stopEvent: AgentWatchEvent,
  options: TrackTurnOptions,
  readOnly = false
): Promise<TurnSummaryEvent | undefined> {
  const stopTurnId = stopEvent.session.turnId;
  // Consume only this prompt's records: a racing next prompt keeps its state
  // for its own Stop. Records without a turn id are legacy and belong to any
  // Stop. Nothing to summarize (a repeated Stop after a stop hook continued
  // the turn) means no empty duplicate.
  const all = await store.collectEntries(sessionId);
  const firstPass = filterTurn(all, stopTurnId);

  if (firstPass.length === 0) return undefined;

  const window = resolveWindow(all, firstPass, stopEvent.timestamp);
  const usage = await resolveAndClaimUsage(store, sessionId, stopEvent, options, window, readOnly);
  const billingMode = await detectBillingMode(options.agentId, options.env);

  // Re-collect after the settle wait: a tool completion that landed while we
  // watched the transcript still belongs to this turn.
  const mine = filterTurn(await store.collectEntries(sessionId), stopTurnId);
  const records = mine.map((entry) => entry.record);
  const tools = recordsOfKind<ToolRecord>(records, 'tool');
  // A session started above its repositories arrives with no repository at all.
  // Which one this turn worked in is answerable only here, where every tool
  // call of the turn is in hand — and this is the one hook that may pay for a
  // git process, because it already does.
  const workspace = stopEvent.git?.repository ? inRepository(tools) : await resolveWorkspaceRepository(tools, options);
  // Usage is mirrored onto a *copy* of the Stop event: the summary's model
  // should come from the transcript when the transcript knows better, and
  // rewriting an event another stage may still be reading is not an option.
  const resolvedStop = withResolvedUsage(stopEvent, usage, billingMode);
  // Together, not in turn: each shells out to git and each can cost its own
  // GIT_TIMEOUT_MS, so taken in order a slow machine pays both inside the
  // lock on every close. The pre-turn path resolves the same pair this way.
  const [developerId, developerName] = await Promise.all([
    // The declared repository's git config, when there is one: a
    // per-repository user.email is where git-only machines name the developer.
    developerIdentity(options.config.developerEmail, workspace?.root ?? options.cwd, { home: options.env.home }),
    developerDisplayName(options.config.developerName, workspace?.root ?? options.cwd, { home: options.env.home })
  ]);

  const summary = buildTurnSummary({
    provider: stopEvent.agent.provider,
    surface: resolveSurface(stopEvent.agent.provider, options.env),
    sessionId,
    turnId: stopTurnId,
    developerId,
    developerName,
    installationId: options.config.installationId,
    git: workspace?.git ?? stopEvent.git,
    featureCandidates: workspace?.featureCandidates ?? stopEvent.feature?.candidates,
    prompts: recordsOfKind<PromptRecord>(records, 'prompt'),
    tools: workspace?.tools ?? tools,
    response: resolveResponse(stopEvent, records),
    usage,
    model: resolvedStop.ai?.model,
    billingMode,
    endedAt: stopEvent.timestamp
  });

  // Consume exactly what went into the summary; other prompts' records stay.
  if (!readOnly) await store.remove(mine.map((entry) => entry.file));

  return sanitizeValue(summary);
}

/** What a workspace session's turn resolved to: its paths, and one repository when it may declare one. */
interface WorkspaceRepository {
  readonly git?: EventGit;
  readonly featureCandidates?: readonly FeatureCandidate[];
  /** The declared repository's root, local only: where the developer's git identity is read. */
  readonly root?: string;
  /** The turn's tools with every path dropped that this turn may not report. */
  readonly tools: readonly ToolRecord[];
}

/**
 * The turn's tools when the Stop hook's cwd is itself inside a repository.
 *
 * That repository is the turn's, and its paths are the ones reported. A record
 * resolved against some other folder earlier in the turn — the session started
 * above its repositories, then `cd`-ed into one — is relative to a root this
 * close never checked against the tenant, the start folder or that root's own
 * `.agentwatch.json`, so it keeps its call and loses its path.
 *
 * ponytail: drops the path even when that record's root *is* the Stop's
 * repository, since the Stop event carries no absolute root to compare with.
 * A turn that crosses the `cd` loses those few paths; the upgrade is to compare
 * against the Stop's resolved root.
 *
 * @param tools - The turn's tool records.
 * @returns The workspace answer: no repository of its own, the tools stripped.
 */
function inRepository(tools: readonly ToolRecord[]): WorkspaceRepository {
  return { tools: keepingPaths(tools, (record) => record.repositoryRoot === undefined) };
}

/**
 * The repository a turn worked in, for a session started above its
 * repositories.
 *
 * The turn declares one repository, so the paths it touched in any other are
 * dropped from its file lists: a path relative to a different root is a wrong
 * vote in the placement corpus. `tool_calls` and `tools_used` still count every
 * call — the work happened.
 *
 * What is reported about that repository follows *its* effective config, not
 * the start folder's: a `.agentwatch.json` committed inside it is the one a
 * session started there would honour, and this session found the repository by
 * looking beneath a folder that file never saw.
 *
 * Every failure here answers "no repository", which is exactly what the turn
 * reported before this existed.
 *
 * `options.cwd` is the Stop hook's, which a lasting `cd` can have moved since
 * the tool hooks ran; every check here is asked of it, of the absolute root each
 * record was anchored to, and of nothing joined from the two.
 *
 * @param tools - The turn's tool records.
 * @param options - Tracking options; `cwd` is the folder the session started in.
 * @returns The paths the turn may report, and its repository when one qualifies.
 */
async function resolveWorkspaceRepository(tools: readonly ToolRecord[], options: TrackTurnOptions): Promise<WorkspaceRepository> {
  const admitted = admittedTools(tools, options);
  const winner = winningRepositoryRoot(admitted);

  if (winner === undefined) return { tools: admitted };

  const root = winner;
  const capture = (await loadEffectiveConfig(options.paths, root, options.globalConfig)).config.capture;
  // One repository's paths and nothing else, decided before anything can
  // fail: the losers' paths are a wrong vote whether or not the turn ends up
  // declaring the winner, and the winner's are its own to withhold.
  const own = keepingPaths(admitted, (record) => record.repositoryRoot === winner && capture.files);

  if (!capture.git) return { tools: own };

  const git: GitContext = await collectGitContext({ cwd: root, includeChangedFiles: capture.files }).catch(() => ({}));

  if (!git.repositoryRoot) return { tools: own };

  const candidates = featureCandidatesFromBranch(git.branch);

  return {
    // Field by field, and no repositoryRoot: nothing absolute is sent.
    git: {
      repository: git.repository,
      repositoryHash: git.repositoryHash,
      remote: git.remote,
      branch: git.branch,
      commit: git.commit,
      changedFiles: git.changedFiles
    },
    featureCandidates: candidates.length > 0 ? candidates : undefined,
    root,
    tools: own
  };
}

/**
 * The turn's tools with every record refused whose repository this session
 * may not report on.
 *
 * Two refusals. A repository outside the start folder: turn state is a file on
 * disk between hook invocations, so the path it names is checked rather than
 * trusted, and a value that climbs out would point git at somebody else's
 * directory. And a repository another project root claims: the start folder
 * alone decides which tenant a session sends as, so a checkout beneath it with
 * a root of its own — another token, or only another developer — would have
 * its branch, commit and paths delivered to the wrong tenant under the wrong
 * name. Both are asked of real paths: a symlink inside the start folder can
 * point at a checkout anywhere on the machine, and `.git` is found through it.
 * A refused record stays, as a call that named no path.
 *
 * @param tools - The turn's tool records.
 * @param options - Tracking options; `cwd` is the folder the session started in.
 * @returns The records, with the refused ones stripped of their paths.
 */
function admittedTools(tools: readonly ToolRecord[], options: TrackTurnOptions): readonly ToolRecord[] {
  const roots = options.globalConfig.config.roots;
  const tenant = selectRoot(roots, options.cwd)?.path;
  const boundary = canonicalRoot(options.cwd);
  // One verdict per repository, not per call: each asks the filesystem.
  const verdicts = new Map<string, boolean>();
  const admitted: ToolRecord[] = [];

  for (const record of tools) {
    const root = record.repositoryRoot;

    // Anything but a string names no repository and casts no vote; it is left
    // as it is for the winner rule's own guard.
    if (typeof root !== 'string') {
      admitted.push(record);
      continue;
    }

    // Relative is garbled state: there is nothing it could safely be joined to.
    const verdict = verdicts.get(root) ?? (path.isAbsolute(root) && isBeneath(boundary, canonicalRoot(root)) && selectRoot(roots, root)?.path === tenant);

    verdicts.set(root, verdict);
    admitted.push(verdict ? record : { ...record, filePath: undefined, repositoryRoot: undefined });
  }

  return admitted;
}

/**
 * The tools with `filePath` dropped from every record `keep` refuses.
 *
 * @param tools - The turn's tool records.
 * @param keep - Whether a record may keep its path.
 * @returns A new list; the records are not mutated.
 */
function keepingPaths(tools: readonly ToolRecord[], keep: (record: ToolRecord) => boolean): readonly ToolRecord[] {
  return tools.map((record) => (keep(record) ? record : { ...record, filePath: undefined }));
}

/**
 * Which repository this turn worked in: the one it edited most, or — having
 * edited nowhere — the one it read most. A tie goes to the one touched first,
 * since nothing else about two tied repositories distinguishes them.
 *
 * @param tools - The turn's tool records.
 * @returns The winning repository root, or undefined when no tool named one.
 */
function winningRepositoryRoot(tools: readonly ToolRecord[]): string | undefined {
  const edited = new Map<string, Set<string>>();
  const read = new Map<string, Set<string>>();

  for (const tool of tools) {
    // Typed: these records are read back off disk, where the only shape check
    // is `kind` and `at`. A non-string that reached `loadEffectiveConfig` or
    // git would throw, and a throw here costs the whole summary.
    if (typeof tool.repositoryRoot !== 'string' || typeof tool.filePath !== 'string') continue;

    // Distinct files, not tool calls: five edits of one file is one file's
    // worth of evidence, and a legacy record without an access marker counts
    // as an edit exactly as files_touched treats it.
    const counts = tool.access === 'read' ? read : edited;
    const files = counts.get(tool.repositoryRoot) ?? new Set<string>();

    files.add(tool.filePath);
    counts.set(tool.repositoryRoot, files);
  }

  return mostFiles(edited) ?? mostFiles(read);
}

/**
 * The repository with the most distinct files, first-seen winning a tie.
 *
 * @param counts - Repository root → its distinct files, in first-seen order.
 * @returns The winner, or undefined when nothing was counted.
 */
function mostFiles(counts: ReadonlyMap<string, ReadonlySet<string>>): string | undefined {
  let winner: string | undefined;
  let best = 0;

  // Insertion order is first-seen order, and the comparison is strict, so the
  // earliest of the tied repositories keeps the win.
  //
  // ponytail: "first" is only as fine-grained as the records are ordered, and
  // they are sorted by their ISO-millisecond `at`. Two tool calls in different
  // repositories inside one millisecond fall back to filename order, so a tie
  // between them is not guaranteed stable. The upgrade path is a monotonic
  // sequence number on the record, which every other ordering here would want
  // too.
  for (const [repositoryRoot, files] of counts) {
    if (files.size <= best) continue;

    winner = repositoryRoot;
    best = files.size;
  }

  return winner;
}

/**
 * Degraded close: a summary built from the Stop event alone.
 *
 * No prompts, tools, or transcript usage, and it stays `pending` so the backend
 * finalizes usage from the llm.call ledger — via the turn id when present, else
 * the session-wide ownership join. A thin record beats a missing turn.
 *
 * @param sessionId - Provider session id.
 * @param stopEvent - The closing event.
 * @param options - Tracking options.
 * @returns The degraded summary, or undefined when even that failed.
 */
async function fallbackSummary(sessionId: string, stopEvent: AgentWatchEvent, options: TrackTurnOptions): Promise<TurnSummaryEvent | undefined> {
  try {
    // The same resolvers the healthy close uses, and resolved together for the
    // same reason: on a machine that names its developer through git alone,
    // reading the config verbatim here would ship a turn attributed to nobody.
    const [developerId, developerName] = await Promise.all([
      developerIdentity(options.config.developerEmail, options.cwd, { home: options.env.home }),
      developerDisplayName(options.config.developerName, options.cwd, { home: options.env.home })
    ]);
    const summary = buildTurnSummary({
      provider: stopEvent.agent.provider,
      surface: resolveSurface(stopEvent.agent.provider, options.env),
      sessionId,
      turnId: stopEvent.session.turnId,
      developerId,
      developerName,
      installationId: options.config.installationId,
      git: stopEvent.git,
      featureCandidates: stopEvent.feature?.candidates,
      // No prompt records, so no fail-open reason either: a degraded summary
      // reports what it can read, and the state it could not read is the point.
      prompts: [],
      tools: [],
      response: responseFrom(stopEvent),
      model: stopEvent.ai?.model,
      endedAt: stopEvent.timestamp
    });

    return sanitizeValue(summary);
  } catch (error) {
    debugLog('fallback turn summary failed:', error);

    return undefined;
  }
}

/**
 * The window this turn may claim transcript usage from.
 *
 * Transcript entries carry no prompt id, so if another prompt started inside
 * our window every entry after its start is ambiguous. The window is cut
 * there: those tokens belong to — and are counted by — the other turn, which is
 * what keeps attribution exactly-once instead of doubled.
 *
 * @param all - Every record of the session.
 * @param mine - This turn's records.
 * @param stopAt - Timestamp of the closing event.
 * @returns The window bounds.
 */
function resolveWindow(all: readonly TurnStateEntry[], mine: readonly TurnStateEntry[], stopAt: string): TurnWindow {
  const startedAt = mine.find(({ record }) => record.kind === 'prompt')?.record.at;

  if (startedAt === undefined) return { startedAt, untilIso: stopAt };

  const mineSet = new Set(mine);
  let nextPromptAt: string | undefined;

  for (const entry of all) {
    if (mineSet.has(entry) || entry.record.kind !== 'prompt' || entry.record.at <= startedAt) continue;

    if (nextPromptAt === undefined || entry.record.at < nextPromptAt) nextPromptAt = entry.record.at;
  }

  const untilIso = nextPromptAt !== undefined && nextPromptAt < stopAt ? nextPromptAt : stopAt;

  return { startedAt, untilIso };
}

/**
 * Read transcript usage for this turn and persist the claim.
 *
 * Per-turn close locks prevent duplicate Stops for one prompt, but *different*
 * prompts close concurrently. The session usage lock therefore covers the whole
 * read-claims → read-transcript → persist-claim transaction. When the bounded
 * wait expires the transcript usage is omitted rather than risking double
 * attribution; native OTel remains authoritative either way.
 *
 * @param store - Per-session state store.
 * @param sessionId - Provider session id.
 * @param stopEvent - The closing event.
 * @param options - Tracking options.
 * @param window - Bounds this turn may claim from.
 * @param readOnly - Preview only: read claims but never write one.
 * @returns The usage, or undefined when none could be claimed.
 */
async function resolveAndClaimUsage(
  store: TurnStateStore,
  sessionId: string,
  stopEvent: AgentWatchEvent,
  options: TrackTurnOptions,
  window: TurnWindow,
  readOnly: boolean
): Promise<TurnUsage | undefined> {
  if (!TRANSCRIPT_READERS[options.agentId] || window.startedAt === undefined) return undefined;

  if (readOnly) {
    return readTranscriptUsage(options, window, await store.claimedMessageIds(sessionId));
  }

  const lockName = `turn-usage-${sha256Hex(sessionId).slice(0, LOCK_KEY_HASH_LENGTH)}`;
  const release = await waitForUsageLock(options, lockName);

  if (!release) {
    debugLog('turn usage lock timed out; omitting transcript usage');

    return undefined;
  }

  try {
    const claimed = await store.claimedMessageIds(sessionId);
    const usage = await readTranscriptUsage(options, window, claimed);

    if (usage?.messageIds && usage.messageIds.length > 0) {
      // Old Claude versions have no prompt id; the Stop event id still gives
      // every completed turn a distinct ledger file.
      await store.claimUsage(sessionId, stopEvent.session.turnId ?? stopEvent.id, usage.messageIds);
    }

    return usage;
  } finally {
    await release();
  }
}

/**
 * Acquire the session usage lock, waiting a bounded time.
 *
 * @param options - Tracking options supplying the locks directory and clock.
 * @param lockName - Session-scoped lock name.
 * @returns The release function, or undefined on timeout.
 */
function waitForUsageLock(options: TrackTurnOptions, lockName: string): Promise<ReleaseLock | undefined> {
  return pollUntil(() => acquireLock(options.locksDir, lockName, options.env.now), USAGE_LOCK_WAIT_MS, USAGE_LOCK_POLL_MS);
}

/**
 * Run this provider's transcript reader over the turn's window.
 *
 * @param options - Tracking options carrying the raw payload.
 * @param window - Bounds this turn may claim from.
 * @param excludeMessageIds - Messages other turns already claimed.
 * @returns The usage, or undefined when the provider reports none.
 */
async function readTranscriptUsage(
  options: TrackTurnOptions,
  window: TurnWindow,
  excludeMessageIds: ReadonlySet<string>
): Promise<TurnUsage | undefined> {
  const reader = TRANSCRIPT_READERS[options.agentId];
  const transcriptPath = asRecord(options.rawPayload)?.[TRANSCRIPT_PATH_KEY];

  if (!reader || window.startedAt === undefined || typeof transcriptPath !== 'string') return undefined;

  return reader(transcriptPath, window.startedAt, window.untilIso, excludeMessageIds);
}

/**
 * The records of one kind, narrowed.
 *
 * @param records - Every record of the turn.
 * @param kind - Kind to keep.
 * @returns The matching records, in order.
 */
function recordsOfKind<T extends TurnRecord>(records: readonly TurnRecord[], kind: T['kind']): T[] {
  return records.filter((record): record is T => record.kind === kind);
}

/**
 * This turn's records out of the session's.
 *
 * @param entries - Every entry of the session.
 * @param stopTurnId - Turn id of the closing event, when it has one.
 * @returns The entries this Stop owns.
 */
function filterTurn(entries: readonly TurnStateEntry[], stopTurnId: string | undefined): TurnStateEntry[] {
  return entries.filter(({ record }) => stopTurnId === undefined || record.turnId === undefined || record.turnId === stopTurnId);
}

/**
 * The response the user saw.
 *
 * A Stop-supplied response (Claude) wins; otherwise the turn's last recorded
 * response event (Cursor's afterAgentResponse) is the answer that was shown.
 *
 * @param stopEvent - The closing event.
 * @param records - The turn's records.
 * @returns The response's evidence, or undefined when none was recorded.
 */
function resolveResponse(stopEvent: AgentWatchEvent, records: readonly TurnRecord[]): ContentEvidence | undefined {
  return responseFrom(stopEvent) ?? recordsOfKind<ResponseRecord>(records, 'response').at(-1)?.evidence;
}

/**
 * A copy of the closing event carrying the usage we resolved for it.
 *
 * @param stopEvent - The closing event; left untouched.
 * @param usage - Transcript usage, when any was claimed.
 * @param billingMode - Detected billing mode.
 * @returns The event with `ai` filled in.
 */
function withResolvedUsage(stopEvent: AgentWatchEvent, usage: TurnUsage | undefined, billingMode: UsageBillingMode): AgentWatchEvent {
  if (!usage && billingMode === 'unknown') return stopEvent;

  return {
    ...stopEvent,
    ai: {
      ...stopEvent.ai,
      model: usage?.model ?? stopEvent.ai?.model,
      billingMode: billingMode === 'unknown' ? stopEvent.ai?.billingMode : billingMode,
      usage: usage
        ? {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cachedInputTokens: usage.cachedInputTokens,
            cacheCreationInputTokens: usage.cacheCreationInputTokens,
            source: 'transcript'
          }
        : stopEvent.ai?.usage
    }
  };
}

/**
 * A prompt record from a prompt event.
 *
 * @param event - The prompt event.
 * @param failOpenReason - Why it ran without an enforcement decision, if it did.
 * @returns The record.
 */
function promptRecord(event: AgentWatchEvent, failOpenReason: FailOpenReason | undefined): PromptRecord {
  return {
    kind: 'prompt',
    at: event.timestamp,
    turnId: event.session.turnId,
    evidence: asEvidence(event.metadata?.[PROMPT_EVIDENCE_KEY]),
    failOpenReason
  };
}

/**
 * A tool record from a tool-completion event.
 *
 * @param event - The tool event.
 * @param cwd - This hook's own working directory, which the event's repository path is relative to.
 * @returns The record.
 */
function toolRecord(event: AgentWatchEvent, cwd: string): ToolRecord {
  const filePath = event.metadata?.[FILE_PATH_KEY];
  const repositoryPath = event.metadata?.[REPOSITORY_PATH_METADATA_KEY];

  return {
    kind: 'tool',
    at: event.timestamp,
    turnId: event.session.turnId,
    tool: event.tool?.name,
    filePath: typeof filePath === 'string' ? filePath : undefined,
    // Anchored here, to the cwd it was resolved against: a lasting `cd` moves
    // the cwd the next hook reports, so the Stop hook's is not this one's.
    repositoryRoot: typeof repositoryPath === 'string' && repositoryPath ? path.join(cwd, repositoryPath) : undefined,
    access: accessFor(event.event.type)
  };
}

/**
 * Whether a tool event read or modified its file.
 *
 * Reads and edits are different product signals: files the agent merely read
 * must not appear in the summary's files_touched (modified) list.
 *
 * @param type - Canonical event type.
 * @returns The access kind, or undefined when the event implies neither.
 */
function accessFor(type: AgentWatchEvent['event']['type']): ToolRecord['access'] {
  if (type === 'file.read') return 'read';

  if (type === 'file.edited') return 'edit';

  return undefined;
}

/**
 * A response record from an out-of-band response event.
 *
 * @param event - The response-bearing event.
 * @returns The record.
 */
function responseRecord(event: AgentWatchEvent): ResponseRecord {
  return {
    kind: 'response',
    at: event.timestamp,
    turnId: event.session.turnId,
    evidence: responseFrom(event)
  };
}

/**
 * Response evidence carried on an event's metadata.
 *
 * @param event - Any canonical event.
 * @returns The evidence, or undefined when the event carries none.
 */
function responseFrom(event: AgentWatchEvent): ContentEvidence | undefined {
  return asEvidence(event.metadata?.[RESPONSE_EVIDENCE_KEY]);
}

/**
 * Content evidence out of an untrusted metadata value.
 *
 * @param value - Metadata value of unknown shape.
 * @returns The evidence, or undefined when the shape does not match.
 */
function asEvidence(value: unknown): ContentEvidence | undefined {
  const record = asRecord(value);

  if (typeof record?.['length'] !== 'number' || typeof record['sha256'] !== 'string') return undefined;

  return { length: record['length'], sha256: record['sha256'] };
}

/**
 * Which surface the turn happened on.
 *
 * @param provider - Internal provider id.
 * @param env - Environment; Claude Code reports its own entrypoint there.
 * @returns The surface label.
 */
function resolveSurface(provider: string, env: Env): string {
  if (provider === 'claude') {
    const entrypoint = env.vars[CLAUDE_ENTRYPOINT_VAR];

    if (entrypoint) return entrypoint;
  }

  // Cursor and Antigravity hooks fire from an editor agent. Cursor's
  // is_background_agent is only available on sessionStart, not on Stop, so v1
  // reports a single surface for them.
  if (IDE_SURFACE_PROVIDERS.has(provider)) return IDE_SURFACE;

  return DEFAULT_SURFACE;
}
