import type { CaptureConfig } from '../config/types/config.types.js';
import type { ProductEvent } from '../events/product-event.js';
import type { TurnSummaryEvent } from '../turns/types/turn-summary.types.js';
import { sanitizeValue } from './sanitizer.js';

/**
 * Reapply current capture policy to persisted records before queueing or sending.
 * Old turn state and offline events may predate a flag change — or this release —
 * so the gate runs again here rather than only where the record was built.
 * @param event - Product record, possibly from an older installation.
 * @param capture - Effective, consent-gated capture flags. Metadata follows the
 *   schema defaults, so only an explicit `false` drops it.
 * @returns A sanitized copy, or undefined when the whole record is no longer allowed.
 */
export function applyProductCapture<T extends ProductEvent>(event: T, capture?: CaptureConfig): T | undefined {
  // A snapshot is git metadata end to end — commit subjects included — so a
  // revoked git flag drops the record instead of emptying it.
  if (event.event.type === 'repo.snapshot') return capture?.git === false ? undefined : sanitizeValue(event);

  if (event.event.type !== 'turn.summary') return sanitizeValue(event);

  const summary = event as TurnSummaryEvent;

  // Response text goes unconditionally: this release never builds it, but a
  // summary queued by an older one can still carry it. `prompt` is that older
  // release's field and goes the same way; prompt text now rides only as
  // `prompt_text`. Evidence (length + sha256) stays: it is what tells the
  // backend a turn had content at all.
  //
  // The content fields need an explicit `true`: they are opt-in, and a
  // missing policy is not consent. The path and repository fields need an
  // explicit `false`: they are on by default. A queued record can outlive
  // any of these flags, which is why they are asked again here.
  const git = capture?.git === false;
  const files = capture?.files === false;

  return sanitizeValue({
    ...event,
    prompt: undefined,
    response: undefined,
    prompt_text: capture?.promptText === true ? summary.prompt_text : undefined,
    tool_inputs: capture?.toolInput === true ? summary.tool_inputs : undefined,
    repository: git ? undefined : summary.repository,
    branch: git ? undefined : summary.branch,
    commit: git ? undefined : summary.commit,
    jira_ids: git ? undefined : summary.jira_ids,
    work_evidence: git ? undefined : summary.work_evidence,
    files_changed: files ? undefined : summary.files_changed,
    files_touched: files ? undefined : summary.files_touched,
    files_read: files ? undefined : summary.files_read,
    external_files_touched: files ? undefined : summary.external_files_touched,
    external_files_read: files ? undefined : summary.external_files_read
  }) as T;
}
