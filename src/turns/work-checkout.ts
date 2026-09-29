import fs from 'node:fs/promises';
import path from 'node:path';
import { loadEffectiveConfig } from '../config/repo-config.js';
import { canonicalRoot, selectRoot } from '../config/root-config.js';
import { REPOSITORY_PATH_METADATA_KEY } from '../events/constants/enrich.constants.js';
import { sha256Hex } from '../events/event-id.js';
import type { AgentWatchEvent, EventGit, FeatureCandidate } from '../events/types/events.types.js';
import { featureCandidatesFromBranch } from '../feature/ticket-candidates.js';
import { checkoutRootOf } from '../git/checkout-root.js';
import { GIT_REMOTE_ARGS, GIT_TIMEOUT_MS, MAX_WORK_CHANGED_FILES } from '../git/constants/git.constants.js';
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
  /** The checkout's directory is gone; its baseline stands in for the closing state. */
  readonly vanished: boolean;
}

/**
 * Write down the checkouts this tool hook names, for its turn's close.
 *
 * On a tool-start hook: the checkout of the hook's cwd, of a file tool's path,
 * and of every directory the shell command named (`options.nominations`, roots
 * only). On a completion hook: the file's checkout, when the turn has not named
 * it yet. The first time a turn names a checkout, its baseline fingerprint is
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

  const named = start && (options.nominations?.length ?? 0) > 0;
  const candidates = await hookCandidates(event, options, start);

  if (candidates.length === 0) return;

  const admits = admission(options, (await store.readStart(sessionId)) ?? options.cwd);
  const prefix = `${CHECKOUT_RECORD_PREFIX}${shortHash(event.session.turnId ?? '')}-`;
  const seen = new Set<string>();

  for (const name of await store.names(sessionId)) {
    if (name.startsWith(prefix)) seen.add(name.slice(prefix.length, prefix.length + CHECKOUT_KEY_HASH_LENGTH));
  }

  const writes: { root: string; via: CheckoutVia; key: string; seq?: number }[] = [];

  for (const { root, via } of candidates) {
    const key = shortHash(root);
    const first = !seen.has(key);
    const votes = start && (via === 'shell' || (via === 'cwd' && !named));

    if ((!first && !votes) || (first && seen.size >= MAX_TURN_CHECKOUTS) || !admits(root)) continue;

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

      await store.append(sessionId, `${prefix}${key}-${shortHash(event.id)}`, record);
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

  if (!options.config.capture.git) return { tools, git: stopEvent.git };

  const admits = admission(options, (await store.readStart(sessionId)) ?? options.cwd);
  const candidates = candidatesOf(records, admits);
  const memo = await store.readWorkCheckout(sessionId);
  const carried = memo && admits(memo.root) ? canonicalRoot(memo.root) : undefined;
  const carriedCandidate = carried === undefined || candidates.some((candidate) => candidate.root === carried) ? [] : [emptyCandidate(carried, candidates.length)];
  const batch = [...candidates, ...carriedCandidate];
  const probes = new Map(await Promise.all(batch.map(async (candidate) => [candidate.root, await probe(candidate)] as const)));
  const changed = new Map(candidates.map((candidate) => [candidate.root, changedFiles(candidate, probes.get(candidate.root)!)]));
  const reportable = candidates.filter((candidate) => probes.get(candidate.root)?.closing);
  const byChange = best(reportable, (candidate) => changed.get(candidate.root)!.length);

  if (byChange) return reportCheckout(byChange.root, 'changed', probes.get(byChange.root)!, changed.get(byChange.root)!, tools, options);

  if (carried !== undefined && probes.get(carried)?.closing) return reportCheckout(carried, 'carried', probes.get(carried)!, [], tools, options);

  const byVotes = best(reportable, (candidate) => candidate.votes + candidate.read.size);

  if (byVotes) return reportCheckout(byVotes.root, 'referenced', probes.get(byVotes.root)!, [], tools, options);

  const stopRoot = await checkoutRootOf(options.cwd);

  return {
    git: stopEvent.git,
    featureCandidates: stopEvent.feature?.candidates,
    tools: keepingPathsIn(tools, stopRoot),
    evidence: stopEvent.git?.repository ? 'cwd' : undefined,
    root: stopEvent.git?.repository ? stopRoot : undefined
  };
}

/**
 * The checkouts one tool hook names, the named ones first.
 *
 * A shell call that names the checkout it sits in votes for it through the
 * name, so the name comes first and the cwd's duplicate is dropped.
 *
 * @param event - The tool event.
 * @param options - Tracking options.
 * @param start - Whether this is a tool-start hook.
 * @returns Distinct canonical roots with how each was named.
 */
async function hookCandidates(event: AgentWatchEvent, options: TrackTurnOptions, start: boolean): Promise<{ root: string; via: CheckoutVia }[]> {
  const repositoryPath = event.metadata?.[REPOSITORY_PATH_METADATA_KEY];
  const fileRoot = typeof repositoryPath === 'string' && repositoryPath ? canonicalRoot(path.join(options.cwd, repositoryPath)) : undefined;
  const cwdRoot = start ? await checkoutRootOf(options.cwd) : undefined;
  const all: { root: string | undefined; via: CheckoutVia }[] = [
    ...(start ? (options.nominations ?? []) : []).map((root) => ({ root, via: 'shell' as const })),
    { root: cwdRoot, via: 'cwd' },
    { root: fileRoot, via: 'file' }
  ];
  const distinct = new Map<string, CheckoutVia>();

  for (const { root, via } of all) {
    if (root !== undefined && path.isAbsolute(root) && !distinct.has(root)) distinct.set(root, via);
  }

  return [...distinct].map(([root, via]) => ({ root, via }));
}

/**
 * Whether this session may report a checkout.
 *
 * A checkout another project root claims is refused outright: the start folder
 * alone decides which tenant a session sends as. With roots configured and the
 * start folder in one, any checkout of that tenant is admitted — worktrees sit
 * beside the start folder, not beneath it. Otherwise only checkouts beneath the
 * start folder are. Asked of real paths, because a symlink can lead anywhere.
 *
 * @param options - Tracking options; the machine's roots.
 * @param startFolder - The folder the session started in.
 * @returns The admission test, memoised per root.
 */
function admission(options: TrackTurnOptions, startFolder: string): (root: string) => boolean {
  const roots = options.globalConfig.config.roots;
  const tenant = selectRoot(roots, startFolder)?.path;
  const boundary = canonicalRoot(startFolder);
  const verdicts = new Map<string, boolean>();

  return (root) => {
    const known = verdicts.get(root);

    if (known !== undefined) return known;

    const real = path.isAbsolute(root) ? canonicalRoot(root) : undefined;
    const verdict = real !== undefined && selectRoot(roots, real)?.path === tenant && (tenant !== undefined || isBeneath(boundary, real));

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

    if (record.kind !== 'tool' || typeof record.filePath !== 'string') continue;

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
    const moved = from !== undefined && closing.oid !== undefined && from !== closing.oid;

    return { closing, remote, commits: moved ? await commitFiles(candidate.root, from, closing.oid!) : [], vanished: false };
  }

  const common = candidate.baseline?.commonDir;
  const branch = candidate.baseline?.branch;

  if (!common || !from || !branch || (await exists(candidate.root))) return { commits: [], vanished: false };

  const [commits, commonRemote] = await Promise.all([
    commitFiles(common, from, `refs/heads/${branch}`, common),
    runGit(['--git-dir', common, ...GIT_REMOTE_ARGS], common, GIT_TIMEOUT_MS)
  ]);

  return { closing: { oid: from, branch, commonDir: common, dirty: {} }, remote: commonRemote, commits, vanished: true };
}

/**
 * The files a turn changed in one checkout: its dirty entries new or re-stamped
 * since the baseline, the files of any commit it made, and what its file tools
 * edited there.
 *
 * @param candidate - The checkout.
 * @param probed - What the Stop learned about it.
 * @returns Repository-relative paths, capped at {@link MAX_WORK_CHANGED_FILES}.
 */
function changedFiles(candidate: Candidate, probed: Probe): string[] {
  if (!probed.closing) return [];

  const files = new Set<string>(candidate.baseline && !probed.vanished ? dirtyDelta(candidate.baseline, probed.closing) : []);

  for (const file of probed.commits) files.add(file);

  for (const file of candidate.edited) files.add(file);

  return [...files].slice(0, MAX_WORK_CHANGED_FILES);
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
  const capture = (await loadEffectiveConfig(options.paths, root, options.globalConfig)).config.capture;
  // Its own paths and nothing else: another checkout's are a wrong vote in the
  // placement corpus. The calls still count.
  const own = capture.files ? keepingPathsIn(tools, root) : keepingPathsIn(tools, undefined);

  if (!capture.git) return { tools: own };

  const branch = probed.closing?.branch;
  const candidates = featureCandidatesFromBranch(branch);

  return {
    // Field by field, and no root: nothing absolute is sent.
    git: {
      ...repositoryIdentity(root, probed.remote),
      branch,
      commit: probed.closing?.oid,
      changedFiles: capture.files && changed.length > 0 ? changed : undefined
    },
    featureCandidates: candidates.length > 0 ? candidates : undefined,
    tools: own,
    evidence,
    root
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
