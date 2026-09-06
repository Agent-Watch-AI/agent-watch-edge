import type { CaptureConfig } from '../config/types/config.types.js';
import type { ProductEvent } from '../events/product-event.js';
import type { TurnSummaryEvent } from '../turns/types/turn-summary.types.js';
import { sanitizeValue } from './sanitizer.js';

/**
 * Reapply current capture policy to persisted records before queueing or sending.
 * Old turn state and offline events may predate consent or flag changes, so the
 * gate runs again here rather than only where the record was built.
 * @param event - Product record, possibly from an older installation.
 * @param capture - Effective, consent-gated capture flags. Absent means no content;
 *   metadata follows the schema defaults, so only an explicit `false` drops it.
 * @returns A sanitized copy, or undefined when the whole record is no longer allowed.
 */
export function applyProductCapture<T extends ProductEvent>(event: T, capture?: CaptureConfig): T | undefined {
  // A snapshot is git metadata end to end — commit subjects included — so a
  // revoked git flag drops the record instead of emptying it.
  if (event.event.type === 'repo.snapshot') return capture?.git === false ? undefined : sanitizeValue(event);

  if (event.event.type !== 'turn.summary') return sanitizeValue(event);

  const summary = event as TurnSummaryEvent;

  // Evidence (length + sha256) deliberately survives a disabled text flag: it
  // is what tells the backend a turn had content at all. The rest do not — they
  // are the per-file and per-repository signals capture.files and capture.git
  // gate when the record is built, and a queued record can outlive either flag.
  const git = capture?.git === false;
  const files = capture?.files === false;

  return sanitizeValue({
    ...event,
    prompt: capture?.prompts ? summary.prompt : undefined,
    response: capture?.responses ? summary.response : undefined,
    repository: git ? undefined : summary.repository,
    branch: git ? undefined : summary.branch,
    commit: git ? undefined : summary.commit,
    jira_ids: git ? undefined : summary.jira_ids,
    files_changed: files ? undefined : summary.files_changed,
    files_touched: files ? undefined : summary.files_touched,
    files_read: files ? undefined : summary.files_read
  }) as T;
}
