import fs from 'node:fs/promises';
import path from 'node:path';
import { REPO_CONFIG_NAME } from '../config/constants/config.constants.js';
import { loadEffectiveConfig } from '../config/repo-config.js';
import type { CaptureConfig } from '../config/types/config.types.js';
import { asRecord } from '../core/object.js';
import { canonicalRoot, selectRoot } from '../config/root-config.js';
import { REPOSITORY_PATH_METADATA_KEY } from '../events/constants/enrich.constants.js';
import { sha256Hex } from '../events/event-id.js';
import type { AgentWatchEvent, EventGit, FeatureCandidate } from '../events/types/events.types.js';
import { featureCandidatesFromBranch } from '../feature/ticket-candidates.js';
import { checkoutRootOf } from '../git/checkout-root.js';
import { EMPTY_TREE_OID, EMPTY_TREE_OID_SHA256, GIT_REMOTE_ARGS, GIT_TIMEOUT_MS, MAX_WORK_CHANGED_FILES, gitVerifyRefArgs } from '../git/constants/git.constants.js';
import { asFingerprint, commitFiles, dirtyDelta, fingerprint } from '../git/fingerprint.js';
import { repositoryIdentity, runGit } from '../git/git-context.js';
import { isBeneath } from '../git/repository-root.js';
import type { Fingerprint } from '../git/types/git.types.js';
import {
  CHECKOUT_KEY_HASH_LENGTH,
  CHECKOUT_RECORD_PREFIX,
  MAX_TURN_CHECKOUTS,
  TOOL_COMPLETION_TYPES,
  TOOL_START_TYPES
} from './constants/turns.constants.js';
import type { TurnStateStore } from './turn-state.js';
import type { CheckoutRecord, CheckoutVia, ToolRecord, TurnRecord } from './types/turn-state.types.js';
import type { WorkEvidence } from './types/turn-summary.types.js';
import type { TrackTurnOptions } from './types/turn-tracker.types.js';

/** What a closing turn reports about where it worked. */
export interface WorkCheckout {
  /** The checkout's git fields as the summary sends them; absent when it names none. */
  readonly git?: EventGit;
  readonly featureCandidates?: readonly FeatureCandidate[];
  /** The turn's tools with every path dropped that lies outside the reported checkout. */
  readonly tools: readonly ToolRecord[];
  readonly evidence?: WorkEvidence;
  /** Local root of the reported checkout. Never sent. */
  readonly root?: string;
  /** The reported checkout's own capture policy, which delivery re-applies. */
  readonly capture?: CaptureConfig;
}

/** One checkout a turn named, with everything the close weighs it by. */
interface Candidate {
  readonly root: string;
  /** Order of first sight; Infinity for a root only a tool record names. */
  first: number;
  readonly order: number;
  baseline?: Fingerprint;
  readonly edited: Set<string>;
  readonly read: Set<string>;
  votes: number;
}

/** What the Stop learned about one candidate. */
interface Probe {
  readonly closing?: Fingerprint;
  readonly remote?: string;
  readonly commits: readonly string[];
  /** HEAD moved during the turn: a commit, even one that changed no file. */
  readonly moved: boolean;
  /** The checkout's directory is gone; its baseline stands in for the closing state. */
  readonly vanished: boolean;
}

/**
 * Write down the checkouts this tool hook names, for its turn's close.
 *
 * On a tool-start hook: the checkout of the hook's cwd, of a file tool's path,
 * and of every directory the shell command named (`options.nominations`, roots
 * only). On a completion hook: the file's checkout and the shell command's
 * checkouts, when the turn has not named them yet — a command can create the
 * worktree it then works in. The first time a turn names a checkout, its baseline fingerprint is
 * taken — the one git process a tool hook may add — and later sightings are
 * votes, one small file each.
 *
 * Only checkouts this session may report are written: the same admission the
 * close applies, asked early so no git process runs in another tenant's
 * checkout.
 *
 * @param store - Per-session state store.
 * @param sessionId - Provider session id.
 * @param event - The tool event, already enriched.
 * @param options - Tracking options.
 */
export async function recordCheckouts(store: TurnStateStore, sessionId: string, event: AgentWatchEvent, options: TrackTurnOptions): Promise<void> {
  const type = event.event.type;
  const start = TOOL_START_TYPES.has(type);

  if (!options.config.capture.git || (!start && !TOOL_COMPLETION_TYPES.has(type))) return;

  const { candidates, named } = await hookCandidates(event, options, start);

  if (candidates.length === 0) return;

  const admits = admission(options, (await store.readStart(sessionId)) ?? options.cwd);
  const prefix = `${CHECKOUT_RECORD_PREFIX}${shortHash(event.session.turnId ?? '')}-`;
  const seen = new Set<string>();
  const names = new Set(await store.names(sessionId));
  const callKey = shortHash(event.id);

  for (const name of names) {
    if (name.startsWith(prefix)) seen.add(name.slice(prefix.length, prefix.length + CHECKOUT_KEY_HASH_LENGTH));
  }

  const writes: { root: string; via: CheckoutVia; key: string; seq?: number }[] = [];

  for (const { root, via } of candidates) {
    const key = shortHash(root);
    const first = !seen.has(key);
    // A completion hook adds a vote only for a root a shell call created: a
    // worktree the command itself added did not exist when its start hook ran.
    const votes = (start || first) && (via === 'shell' || (start && via === 'cwd' && !named));

    // A re-fired hook has the same event id: its record is already there, and
    // rewriting it would drop the first sighting's seq and baseline.
    const duplicate = names.has(`${prefix}${key}-${callKey}.json`);

    if (duplicate || (!first && !votes) || (first && seen.size >= MAX_TURN_CHECKOUTS) || !admits(root)) continue;

    writes.push({ root, via, key, seq: first ? seen.size : undefined });

    if (first) seen.add(key);
  }

  await Promise.all(
    writes.map(async ({ root, via, key, seq }) => {
      const record: CheckoutRecord = {
        kind: 'checkout',
        at: event.timestamp,
        turnId: event.session.turnId,
        root,
        via,
        named,
        seq,
        baseline: seq === undefined ? undefined : await fingerprint(root)
      };

      await store.append(sessionId, `${prefix}${key}-${callKey}`, record);
    })
  );
}

/**
 * Which checkout a closing turn worked in, and what it changed there.
 *
 * Every admitted checkout the turn named is fingerprinted again, all at once,
 * and compared with its baseline. The turn reports, in this order: the one it
 * changed most (`changed`); else the session's last changed checkout
 * (`carried`); else the one it named most (`referenced`); else the Stop folder's
 * own repository, as before this existed (`cwd`). Ties go to the checkout named
 * first. Every failure makes a candidate lose, never the summary.
 *
 * @param store - Per-session state store.
 * @param sessionId - Provider session id.
 * @param records - This turn's records.
 * @param stopEvent - The closing event, enriched for the Stop folder.
 * @param options - Tracking options.
 * @returns The checkout to report and the tools with its paths only.
 */
export async function resolveWorkCheckout(
  store: TurnStateStore,
  sessionId: string,
  records: readonly TurnRecord[],
  stopEvent: AgentWatchEvent,
  options: TrackTurnOptions
): Promise<WorkCheckout> {
  const tools = records.filter((record): record is ToolRecord => record.kind === 'tool');

  // Earlier hooks may have placed paths in checkouts this close will not judge;
  // without git capture none of them is reported, only bare basenames.
  if (!options.config.capture.git) return { tools: keepingPathsIn(tools, undefined), git: stopEvent.git };

  const admits = admission(options, (await store.readStart(sessionId)) ?? options.cwd);
  const candidates = candidatesOf(records, admits);
  const memo = await store.readWorkCheckout(sessionId);
  const carried = memo && admits(memo.root) ? canonicalRoot(memo.root) : undefined;
  const carriedCandidate = carried === undefined || candidates.some((candidate) => candidate.root === carried) ? [] : [emptyCandidate(carried, candidates.length)];
  const batch = [...candidates, ...carriedCandidate];
  const probes = new Map(await Promise.all(batch.map(async (candidate) => [candidate.root, await probe(candidate)] as const)));
  const changed = new Map(candidates.map((candidate) => [candidate.root, changedFiles(candidate, probes.get(candidate.root)!)]));
  const reportable = candidates.filter((candidate) => probes.get(candidate.root)?.closing);
  // Ranked on the whole list, capped only when reported. A HEAD that moved with
  // no file to show for it (an empty commit, an amend) is still a change.
  const byChange = best(reportable, (candidate) => changed.get(candidate.root)!.length || (probes.get(candidate.root)!.moved ? 1 : 0));

  if (byChange) return reportCheckout(byChange.root, 'changed', probes.get(byChange.root)!, changed.get(byChange.root)!, tools, options);

  // Carried only while the folder is still the repository that was
  // remembered: a directory re-cloned from another remote is not that work.
  const carriedProbe = carried === undefined ? undefined : probes.get(carried);
  const stillSame = carriedProbe?.closing !== undefined && repositoryIdentity(carried!, carriedProbe.remote).repository === memo?.repository;

  if (stillSame) return reportCheckout(carried!, 'carried', carriedProbe, [], tools, options);

  const byVotes = best(reportable, (candidate) => candidate.votes + candidate.read.size);

  if (byVotes) return reportCheckout(byVotes.root, 'referenced', probes.get(byVotes.root)!, [], tools, options);

  const stopRoot = await checkoutRootOf(options.cwd);

  // The Stop folder's own repository is held to the same admission as every
  // candidate: a lasting cd can end the turn in another tenant's checkout, or
  // outside the start folder.
  // A folder whose checkout cannot be found is not admitted either: git may
  // still have named a repository there, past what the walk reaches.
  if (stopRoot === undefined || !admits(stopRoot)) return { tools: keepingPathsIn(tools, undefined) };

  return {
    git: stopEvent.git,
    featureCandidates: stopEvent.feature?.candidates,
    tools: keepingPathsIn(tools, stopRoot),
    evidence: stopEvent.git?.repository ? 'cwd' : undefined,
    root: stopEvent.git?.repository ? stopRoot : undefined
  };
}

/**
 * The checkouts one tool hook names, the named ones first, and whether the call
 * named one at all.
 *
 * A call that names a checkout — a shell command's directory or a file tool's
 * file — votes through the name, so its cwd does not also vote: where an agent
 * sits is weaker evidence than where it says it is looking. The cwd's duplicate
 * of a named root is dropped.
 *
 * @param event - The tool event.
 * @param options - Tracking options.
 * @param start - Whether this is a tool-start hook.
 * @returns Distinct canonical roots with how each was named.
 */
async function hookCandidates(
  event: AgentWatchEvent,
  options: TrackTurnOptions,
  start: boolean
): Promise<{ candidates: { root: string; via: CheckoutVia }[]; named: boolean }> {
  const repositoryPath = event.metadata?.[REPOSITORY_PATH_METADATA_KEY];
  const fileRoot = typeof repositoryPath === 'string' && repositoryPath ? canonicalRoot(path.join(options.cwd, repositoryPath)) : undefined;
  const cwdRoot = start ? await checkoutRootOf(options.cwd) : undefined;
  const nominations = options.nominations ?? [];
  const all: { root: string | undefined; via: CheckoutVia }[] = [
    ...nominations.map((root) => ({ root, via: 'shell' as const })),
    { root: fileRoot, via: 'file' },
    { root: cwdRoot, via: 'cwd' },
    // The folders the agent has open say where it sits, as its cwd does.
    ...(start ? (options.workspaceRoots ?? []) : []).map((root) => ({ root, via: 'cwd' as const }))
  ];
  const distinct = new Map<string, CheckoutVia>();

  for (const { root, via } of all) {
    if (root !== undefined && path.isAbsolute(root) && !distinct.has(root)) distinct.set(root, via);
  }

  return { candidates: [...distinct].map(([root, via]) => ({ root, via })), named: start && (nominations.length > 0 || fileRoot !== undefined) };
}

/**
 * Whether this session may report a checkout.
 *
 * A checkout another project root claims is refused outright: the start folder
 * alone decides which tenant a session sends as. With roots configured and the
 * start folder in one, any checkout of that tenant is admitted — worktrees sit
 * beside the start folder, not beneath it. Otherwise only checkouts beneath the
 * start folder are, and the one it lies in. Asked of real paths, because a symlink can lead anywhere.
 *
 * @param options - Tracking options; the machine's roots.
 * @param startFolder - The folder the session started in.
 * @returns The admission test, memoised per root.
 */
function admission(options: TrackTurnOptions, startFolder: string): (root: string) => boolean {
  const roots = options.globalConfig.config.roots;
  const tenant = selectRoot(roots, startFolder)?.path;
  // The identity this hook sends as is its own folder's. A session whose start
  // and current folder sit in two tenants reports no checkout, rather than one
  // tenant's under the other's token.
  const sameIdentity = selectRoot(roots, options.cwd)?.path === tenant;
  const boundary = canonicalRoot(startFolder);
  const verdicts = new Map<string, boolean>();

  return (root) => {
    const known = verdicts.get(root);

    if (known !== undefined) return known;

    const real = path.isAbsolute(root) ? canonicalRoot(root) : undefined;
    // Beneath the start folder, or the checkout the start folder itself lies in.
    const verdict
      = real !== undefined && sameIdentity && selectRoot(roots, real)?.path === tenant && (tenant !== undefined || isBeneath(boundary, real) || isBeneath(real, boundary));

    verdicts.set(root, verdict);

    return verdict;
  };
}

/**
 * The turn's admitted candidates out of its records, type-checked.
 *
 * Turn state is a file on disk between hooks, so every field is checked before
 * it is used. At most {@link MAX_TURN_CHECKOUTS}, the first named winning.
 *
 * @param records - This turn's records, oldest first.
 * @param admits - The admission test.
 * @returns The candidates.
 */
function candidatesOf(records: readonly TurnRecord[], admits: (root: string) => boolean): Candidate[] {
  const byRoot = new Map<string, Candidate>();
  const canonical = new Map<string, string>();
  const at = (raw: unknown): Candidate | undefined => {
    if (typeof raw !== 'string' || !admits(raw)) return undefined;

    const root = canonical.get(raw) ?? canonicalRoot(raw);

    canonical.set(raw, root);

    const candidate = byRoot.get(root) ?? emptyCandidate(root, byRoot.size);

    byRoot.set(root, candidate);

    return candidate;
  };

  for (const record of records) {
    if (record.kind === 'checkout') {
      const candidate = at(record.root);

      if (!candidate) continue;

      if (typeof record.seq === 'number' && record.seq < candidate.first) {
        candidate.first = record.seq;
        candidate.baseline = asFingerprint(record.baseline) ?? candidate.baseline;
      }

      if (record.via === 'shell' || (record.via === 'cwd' && record.named === false)) candidate.votes += 1;

      continue;
    }

    // Only a completed read or edit is evidence: a failed call names a file it
    // may never have touched, and carries no access marker.
    if (record.kind !== 'tool' || typeof record.filePath !== 'string' || (record.access !== 'read' && record.access !== 'edit')) continue;

    const candidate = at(record.repositoryRoot);

    candidate?.[record.access === 'read' ? 'read' : 'edited'].add(record.filePath);
  }

  return [...byRoot.values()].sort(byFirstSight).slice(0, MAX_TURN_CHECKOUTS);
}

/**
 * A checkout at the Stop: fingerprint and remote together, then the commit diff
 * when HEAD moved. A checkout whose directory is gone keeps its baseline's
 * branch and oid, and its commits are read from the shared git dir.
 *
 * @param candidate - The checkout.
 * @returns What the Stop learned; no closing fingerprint when git could not say.
 */
async function probe(candidate: Candidate): Promise<Probe> {
  const [closing, remote] = await Promise.all([fingerprint(candidate.root), runGit(GIT_REMOTE_ARGS, candidate.root, GIT_TIMEOUT_MS)]);
  const from = candidate.baseline?.oid;

  if (closing) {
    // Only a baseline git called unborn diffs its first commit against the
    // empty tree; a baseline that merely lacks an oid proves nothing, and
    // diffing it that way would call the whole tree changed.
    const start = candidate.baseline?.unborn && closing.oid !== undefined ? emptyTreeFor(closing.oid) : from;
    const moved = start !== undefined && closing.oid !== undefined && start !== closing.oid;

    return { closing, remote, commits: moved ? await commitFiles(candidate.root, start, closing.oid!) : [], moved, vanished: false };
  }

  const common = candidate.baseline?.commonDir;
  const branch = candidate.baseline?.branch;
  const unborn = candidate.baseline?.unborn === true;

  if (!common || (!from && !unborn) || !branch || (await exists(candidate.root))) return { commits: [], moved: false, vanished: false };

  const [head, commonRemote] = await Promise.all([
    runGit(['--git-dir', common, ...gitVerifyRefArgs(`refs/heads/${branch}`)], common, GIT_TIMEOUT_MS),
    runGit(['--git-dir', common, ...GIT_REMOTE_ARGS], common, GIT_TIMEOUT_MS)
  ]);
  // Moved when the branch no longer points where the turn started — an empty
  // commit moves it too, with no file to show for it. An unborn baseline's
  // first commit is diffed against the empty tree.
  const start = from ?? (head === undefined ? undefined : emptyTreeFor(head));
  const moved = head !== undefined && head !== start;
  const commits = moved && start !== undefined ? await commitFiles(common, start, `refs/heads/${branch}`, common) : [];

  return { closing: { oid: from ?? head, branch, commonDir: common, dirty: {} }, remote: commonRemote, commits, moved, vanished: true };
}

/**
 * The files a turn changed in one checkout: its dirty entries new or re-stamped
 * since the baseline, the files of any commit it made, and what its file tools
 * edited there.
 *
 * @param candidate - The checkout.
 * @param probed - What the Stop learned about it.
 * @returns Repository-relative paths, uncapped: the count ranks candidates.
 */
function changedFiles(candidate: Candidate, probed: Probe): string[] {
  if (!probed.closing) return [];

  const files = new Set<string>(candidate.baseline && !probed.vanished ? dirtyDelta(candidate.baseline, probed.closing) : []);

  for (const file of probed.commits) files.add(file);

  for (const file of candidate.edited) files.add(file);

  return [...files];
}

/**
 * The winning checkout as the summary reports it, under that checkout's own
 * `.agentwatch.json`: a file committed there is what a session started inside
 * it would honour.
 *
 * @param root - The checkout.
 * @param evidence - How it was chosen.
 * @param probed - Its closing state.
 * @param changed - The files the turn changed there.
 * @param tools - The turn's tool records.
 * @param options - Tracking options.
 * @returns The report.
 */
async function reportCheckout(
  root: string,
  evidence: WorkEvidence,
  probed: Probe,
  changed: readonly string[],
  tools: readonly ToolRecord[],
  options: TrackTurnOptions
): Promise<WorkCheckout> {
  // A worktree removed before the Stop has no file left to read; its main
  // checkout, beside the shared git dir, carries the same committed one.
  const configRoot = probed.vanished && probed.closing?.commonDir ? path.dirname(probed.closing.commonDir) : root;
  const loaded = (await loadEffectiveConfig(options.paths, configRoot, options.globalConfig)).config.capture;
  // The main checkout's file may be looser than the one the removed branch
  // committed: the branch's own may only narrow what is reported, never widen it.
  const capture = probed.vanished ? narrowedByBranch(loaded, await branchCapture(probed.closing)) : loaded;
  // Its own paths and nothing else: another checkout's are a wrong vote in the
  // placement corpus. The calls still count.
  // capture.files: false withholds every path, bare basenames included.
  const own = capture.files ? keepingPathsIn(tools, root) : tools.map((record) => (record.filePath === undefined ? record : { ...record, filePath: undefined }));

  if (!capture.git) return { tools: own, capture };

  const branch = probed.closing?.branch;
  const candidates = featureCandidatesFromBranch(branch);

  return {
    // Field by field, and no root: nothing absolute is sent.
    git: {
      ...repositoryIdentity(root, probed.remote),
      branch,
      commit: probed.closing?.oid,
      changedFiles: capture.files && changed.length > 0 ? changed.slice(0, MAX_WORK_CHANGED_FILES) : undefined
    },
    featureCandidates: candidates.length > 0 ? candidates : undefined,
    tools: own,
    evidence,
    root,
    capture
  };
}

/**
 * The tools with every path dropped that is not in `root`. A path in no
 * checkout is a bare basename and stays, as it always has.
 *
 * @param tools - The turn's tool records.
 * @param root - The reported checkout's root, or undefined to keep only basenames.
 * @returns A new list; the records are not mutated.
 */
function keepingPathsIn(tools: readonly ToolRecord[], root: string | undefined): ToolRecord[] {
  return tools.map((record) => {
    if (record.repositoryRoot === undefined) return record;

    const own = root !== undefined && typeof record.repositoryRoot === 'string' && path.isAbsolute(record.repositoryRoot) && canonicalRoot(record.repositoryRoot) === root;

    return own ? record : { ...record, filePath: undefined };
  });
}

/**
 * The candidate with the highest positive score, the first named winning a tie.
 *
 * @param candidates - Candidates in first-sight order.
 * @param score - What to count.
 * @returns The winner, or undefined when nothing scored.
 */
function best(candidates: readonly Candidate[], score: (candidate: Candidate) => number): Candidate | undefined {
  let winner: Candidate | undefined;
  let top = 0;

  // Sorted by first sight and compared strictly, so the earliest tied one stays.
  for (const candidate of candidates) {
    const value = score(candidate);

    if (value <= top) continue;

    winner = candidate;
    top = value;
  }

  return winner;
}

/**
 * The capture flags a vanished worktree's branch committed in its own
 * `.agentwatch.json`, read from the shared git dir.
 *
 * @param closing - The vanished checkout's stand-in fingerprint.
 * @returns The flags it sets, or undefined when it has no such file.
 */
async function branchCapture(closing: Fingerprint | undefined): Promise<{ git?: unknown; files?: unknown } | undefined> {
  if (!closing?.commonDir || !closing.branch) return undefined;

  const text = await runGit(['--git-dir', closing.commonDir, 'show', `refs/heads/${closing.branch}:${REPO_CONFIG_NAME}`], closing.commonDir, GIT_TIMEOUT_MS);

  try {
    return asRecord(asRecord(text === undefined ? undefined : JSON.parse(text))?.['capture']);
  } catch {
    return undefined;
  }
}

/**
 * A capture policy narrowed by another file's explicit `false`s.
 *
 * @param capture - The policy loaded from disk.
 * @param branch - The branch file's capture flags, if any.
 * @returns The policy, with git and files off wherever either says so.
 */
function narrowedByBranch(capture: CaptureConfig, branch: { git?: unknown; files?: unknown } | undefined): CaptureConfig {
  return { ...capture, git: capture.git && branch?.git !== false, files: capture.files && branch?.files !== false };
}

/**
 * The empty tree in the object format this oid is written in.
 *
 * @param oid - An oid of the repository.
 * @returns Its empty tree's oid.
 */
function emptyTreeFor(oid: string): string {
  return oid.length === EMPTY_TREE_OID_SHA256.length ? EMPTY_TREE_OID_SHA256 : EMPTY_TREE_OID;
}

function byFirstSight(a: Candidate, b: Candidate): number {
  return a.first - b.first || a.order - b.order;
}

function emptyCandidate(root: string, order: number): Candidate {
  return { root, first: Number.POSITIVE_INFINITY, order, edited: new Set(), read: new Set(), votes: 0 };
}

async function exists(target: string): Promise<boolean> {
  return fs.stat(target).then(
    () => true,
    () => false
  );
}

function shortHash(value: string): string {
  return sha256Hex(value).slice(0, CHECKOUT_KEY_HASH_LENGTH);
}
