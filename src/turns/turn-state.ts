import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256Hex } from '../events/event-id.js';
import { writeFileAtomic } from '../storage/atomic-file.js';
import { readJsonFile } from '../storage/json-file.js';

export interface ContentEvidence {
  length: number;
  sha256: string;
}

export type TurnRecord =
  | { kind: 'prompt'; at: string; turnId?: string; text?: string; evidence?: ContentEvidence }
  | { kind: 'tool'; at: string; turnId?: string; tool?: string; filePath?: string };

export interface TurnStateEntry {
  file: string;
  record: TurnRecord;
}

/**
 * Per-session accumulator for turn summaries. Hooks are separate short-lived
 * processes (and subagents can fire them concurrently), so state is one file
 * per record — appends are atomic creates and never race a read-modify-write.
 */
export class TurnStateStore {
  constructor(readonly turnsDir: string) {}

  async append(sessionId: string, recordId: string, record: TurnRecord): Promise<void> {
    const file = path.join(this.sessionDir(sessionId), `${safeName(recordId)}.json`);
    // 0600: records hold raw prompt/response text.
    await writeFileAtomic(file, JSON.stringify(record), 0o600);
  }

  async collect(sessionId: string): Promise<TurnRecord[]> {
    return (await this.collectEntries(sessionId)).map((entry) => entry.record);
  }

  async collectEntries(sessionId: string): Promise<TurnStateEntry[]> {
    const dir = this.sessionDir(sessionId);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (error) {
      // A session that never wrote state has no directory; anything else
      // (ENOTDIR, EACCES) is a broken store and must not masquerade as
      // "no records" — callers degrade to a fallback summary instead.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const entries: TurnStateEntry[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(dir, name);
      const read = await readJsonFile(file);
      if (read.state === 'ok' && isRecord(read.value)) entries.push({ file, record: read.value });
    }
    return entries.sort((a, b) => a.record.at.localeCompare(b.record.at));
  }

  /** Delete exactly these record files; concurrent appends are untouched. */
  async remove(files: string[]): Promise<void> {
    await Promise.all(files.map((file) => fs.rm(file, { force: true })));
  }

  /**
   * Usage ledger: transcript message ids a closed turn has already counted.
   * One atomic file per turn; allocation across turns is serialized by the
   * session usage lock in turn-tracker. Claims survive turn-record removal so
   * a later-closing overlapping turn never re-counts them. Cleaned with the
   * session (clear) or by the TTL sweep.
   */
  async claimUsage(sessionId: string, turnId: string, messageIds: string[]): Promise<void> {
    if (messageIds.length === 0) return;
    const file = path.join(this.sessionDir(sessionId), `${CLAIM_PREFIX}${safeName(turnId)}.json`);
    await writeFileAtomic(file, JSON.stringify({ messageIds }), 0o600);
  }

  async claimedMessageIds(sessionId: string): Promise<Set<string>> {
    const dir = this.sessionDir(sessionId);
    const claimed = new Set<string>();
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return claimed;
    }
    for (const name of names) {
      if (!name.startsWith(CLAIM_PREFIX) || !name.endsWith('.json')) continue;
      const read = await readJsonFile(path.join(dir, name));
      if (read.state !== 'ok' || typeof read.value !== 'object' || read.value === null) continue;
      const ids = (read.value as Record<string, unknown>)['messageIds'];
      if (!Array.isArray(ids)) continue;
      for (const id of ids) if (typeof id === 'string') claimed.add(id);
    }
    return claimed;
  }

  async clear(sessionId: string): Promise<void> {
    await fs.rm(this.sessionDir(sessionId), { recursive: true, force: true });
  }

  /**
   * Remove sessions whose newest record is older than `maxAgeMs`: crashed or
   * abandoned sessions never see a Stop/SessionEnd, and their prompt text
   * must not sit on disk indefinitely.
   */
  async sweep(maxAgeMs: number): Promise<void> {
    let sessionDirs: string[];
    try {
      sessionDirs = await fs.readdir(this.turnsDir);
    } catch {
      return;
    }
    const cutoff = Date.now() - maxAgeMs;
    for (const name of sessionDirs) {
      const dir = path.join(this.turnsDir, name);
      try {
        let newest = 0;
        for (const file of await fs.readdir(dir)) {
          const stat = await fs.stat(path.join(dir, file));
          newest = Math.max(newest, stat.mtimeMs);
        }
        if (newest < cutoff) await fs.rm(dir, { recursive: true, force: true });
      } catch {
        // Concurrent hook activity; skip this session.
      }
    }
  }

  private sessionDir(sessionId: string): string {
    // Hash: session ids come from untrusted payloads and must not traverse paths.
    return path.join(this.turnsDir, sha256Hex(sessionId).slice(0, 32));
  }
}

const CLAIM_PREFIX = 'usage-claim--';

function safeName(recordId: string): string {
  return recordId.replace(/[^A-Za-z0-9._-]/g, '_');
}

function isRecord(value: unknown): value is TurnRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (record['kind'] === 'prompt' || record['kind'] === 'tool') && typeof record['at'] === 'string';
}
