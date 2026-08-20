import fs from 'node:fs/promises';
import path from 'node:path';
import { asRecord } from '../core/object.js';
import { sha256Hex } from '../events/event-id.js';
import { writeFileAtomic } from '../storage/atomic-file.js';
import { readJsonFile } from '../storage/json-file.js';
import { SECRET_FILE_MODE } from '../storage/constants/storage.constants.js';
import {
  RE_UNSAFE_NAME_CHARS,
  SESSION_DIR_HASH_LENGTH,
  USAGE_CLAIM_PREFIX
} from './constants/turns.constants.js';
import type { TurnRecord, TurnStateEntry } from './types/turn-state.types.js';

export type { PromptRecord, ResponseRecord, ToolRecord, TurnRecord, TurnStateEntry } from './types/turn-state.types.js';

/**
 * Per-session accumulator for turn summaries.
 *
 * Hooks are separate short-lived processes and subagents can fire them
 * concurrently, so state is one file per record: an append is an atomic create
 * that can never race a read-modify-write, and two hooks writing at once
 * simply produce two files.
 */
export class TurnStateStore {
  /**
   * Bind the store to its state root.
   *
   * @param turnsDir - Root directory the per-session state lives under.
   */
  constructor(readonly turnsDir: string) {}

  /**
   * Record one event of an open turn.
   *
   * @param sessionId - Provider session id.
   * @param recordId - Stable id for this record; the filename.
   * @param record - What happened.
   */
  async append(sessionId: string, recordId: string, record: TurnRecord): Promise<void> {
    const file = path.join(this.sessionDir(sessionId), `${safeName(recordId)}.json`);

    // 0600: records hold raw prompt and response text.
    await writeFileAtomic(file, JSON.stringify(record), SECRET_FILE_MODE);
  }

  /**
   * Every record of a session, oldest first.
   *
   * @param sessionId - Provider session id.
   * @returns The records, without the files they came from.
   */
  async collect(sessionId: string): Promise<TurnRecord[]> {
    const entries = await this.collectEntries(sessionId);

    return entries.map((entry) => entry.record);
  }

  /**
   * Every record of a session with its file, so the caller can consume exactly
   * what it summarized.
   *
   * @param sessionId - Provider session id.
   * @returns The entries, sorted by record timestamp.
   * @throws When the store exists but cannot be read — a broken store must not
   *   masquerade as "no records", or the turn would silently lose its context.
   */
  async collectEntries(sessionId: string): Promise<TurnStateEntry[]> {
    const dir = this.sessionDir(sessionId);
    const names = await readSessionDir(dir);

    if (!names) return [];

    const entries: TurnStateEntry[] = [];

    for (const name of names) {
      if (!name.endsWith('.json') || name.startsWith(USAGE_CLAIM_PREFIX)) continue;

      const file = path.join(dir, name);
      const read = await readJsonFile(file);

      if (read.state !== 'ok' || !isTurnRecord(read.value)) continue;

      entries.push({ file, record: read.value });
    }

    return entries.sort((a, b) => a.record.at.localeCompare(b.record.at));
  }

  /**
   * Delete exactly these record files; concurrent appends are untouched.
   *
   * @param files - Paths returned by {@link collectEntries}.
   */
  async remove(files: readonly string[]): Promise<void> {
    await Promise.all(files.map((file) => fs.rm(file, { force: true })));
  }

  /**
   * Record which transcript messages a closed turn has counted.
   *
   * One atomic file per turn; allocation across turns is serialized by the
   * session usage lock in the tracker. Claims outlive turn-record removal on
   * purpose, so a later-closing overlapping turn can never re-count them.
   *
   * @param sessionId - Provider session id.
   * @param turnId - Turn the claim belongs to.
   * @param messageIds - Transcript message ids counted into that turn.
   */
  async claimUsage(sessionId: string, turnId: string, messageIds: readonly string[]): Promise<void> {
    if (messageIds.length === 0) return;

    const file = path.join(this.sessionDir(sessionId), `${USAGE_CLAIM_PREFIX}${safeName(turnId)}.json`);

    await writeFileAtomic(file, JSON.stringify({ messageIds }), SECRET_FILE_MODE);
  }

  /**
   * Every transcript message id already claimed in this session.
   *
   * @param sessionId - Provider session id.
   * @returns The claimed ids; empty when nothing has closed yet.
   */
  async claimedMessageIds(sessionId: string): Promise<Set<string>> {
    const dir = this.sessionDir(sessionId);
    const claimed = new Set<string>();
    const names = await readSessionDirSafely(dir);

    for (const name of names) {
      if (!name.startsWith(USAGE_CLAIM_PREFIX) || !name.endsWith('.json')) continue;

      const read = await readJsonFile(path.join(dir, name));
      const ids = asRecord(read.state === 'ok' ? read.value : undefined)?.['messageIds'];

      if (!Array.isArray(ids)) continue;

      for (const id of ids) {
        if (typeof id === 'string') claimed.add(id);
      }
    }

    return claimed;
  }

  /**
   * Drop all state for a session, at SessionEnd.
   *
   * @param sessionId - Provider session id.
   */
  async clear(sessionId: string): Promise<void> {
    await fs.rm(this.sessionDir(sessionId), { recursive: true, force: true });
  }

  /**
   * Remove sessions whose newest record is older than `maxAgeMs`.
   *
   * Crashed or abandoned sessions never see a Stop or SessionEnd, and their
   * raw prompt text must not sit on disk indefinitely.
   *
   * @param maxAgeMs - Age past which a session is considered abandoned.
   */
  async sweep(maxAgeMs: number): Promise<void> {
    const sessionDirs = await readSessionDirSafely(this.turnsDir);
    const cutoff = Date.now() - maxAgeMs;

    for (const name of sessionDirs) {
      const dir = path.join(this.turnsDir, name);

      await removeIfStale(dir, cutoff);
    }
  }

  /**
   * Directory holding one session's state.
   *
   * Hashed: session ids come from untrusted payloads and must never be able to
   * traverse out of the state root.
   *
   * @param sessionId - Provider session id.
   * @returns Absolute directory path.
   */
  private sessionDir(sessionId: string): string {
    return path.join(this.turnsDir, sha256Hex(sessionId).slice(0, SESSION_DIR_HASH_LENGTH));
  }
}

/**
 * List a session directory, distinguishing "never written" from "broken".
 *
 * @param dir - Session directory.
 * @returns The file names, or undefined when the directory does not exist.
 * @throws When the directory exists but cannot be listed.
 */
async function readSessionDir(dir: string): Promise<string[] | undefined> {
  try {
    return await fs.readdir(dir);
  } catch (error) {
    // A session that never wrote state has no directory. Anything else
    // (ENOTDIR, EACCES) is a broken store and has to surface.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;

    throw error;
  }
}

/**
 * List a directory, treating any failure as empty.
 *
 * @param dir - Directory to list.
 * @returns The names, or an empty list.
 */
async function readSessionDirSafely(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

/**
 * Delete a session directory when nothing in it is newer than the cutoff.
 *
 * @param dir - Session directory.
 * @param cutoff - Epoch milliseconds; older than this is abandoned.
 */
async function removeIfStale(dir: string, cutoff: number): Promise<void> {
  try {
    let newest = 0;

    for (const file of await fs.readdir(dir)) {
      const stat = await fs.stat(path.join(dir, file));

      newest = Math.max(newest, stat.mtimeMs);
    }

    if (newest < cutoff) await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Concurrent hook activity in this session; leave it for the next sweep.
  }
}

/**
 * Filesystem-safe form of an untrusted record id.
 *
 * @param recordId - Id from a provider payload.
 * @returns The sanitized name.
 */
function safeName(recordId: string): string {
  return recordId.replace(RE_UNSAFE_NAME_CHARS, '_');
}

/**
 * Whether a decoded value is a turn record we still understand.
 *
 * @param value - Decoded file contents.
 * @returns True when it is a usable record.
 */
function isTurnRecord(value: unknown): value is TurnRecord {
  const record = asRecord(value);

  if (!record || typeof record['at'] !== 'string') return false;

  return record['kind'] === 'prompt' || record['kind'] === 'tool' || record['kind'] === 'response';
}
