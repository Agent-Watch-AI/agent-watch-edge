import type { ContentEvidence } from '../../events/types/events.types.js';

/** A prompt the developer submitted: when, and its length and SHA-256 — never its text. */
export interface PromptRecord {
  readonly kind: 'prompt';
  readonly at: string;
  readonly turnId?: string;
  readonly evidence?: ContentEvidence;
}

/** One tool call the agent completed. */
export interface ToolRecord {
  readonly kind: 'tool';
  readonly at: string;
  readonly turnId?: string;
  readonly tool?: string;
  readonly filePath?: string;
  /**
   * Reads and edits are different product signals: a file the agent merely
   * read must not appear in the summary's files_touched (modified) list.
   */
  readonly access?: 'read' | 'edit';
}

/** A response delivered outside the Stop event (Cursor's afterAgentResponse); evidence only. */
export interface ResponseRecord {
  readonly kind: 'response';
  readonly at: string;
  readonly turnId?: string;
  readonly evidence?: ContentEvidence;
}

/**
 * What model a session is on, as the agent named it.
 *
 * Not a `TurnRecord`: it belongs to the session rather than to a turn, is never
 * collected into a summary, and outlives every record until the session ends.
 */
export interface SessionModelRecord {
  readonly model: string;
}

/** Anything the accumulator persists between hook invocations. */
export type TurnRecord = PromptRecord | ToolRecord | ResponseRecord;

/** A record together with the file it was read from, so it can be consumed. */
export interface TurnStateEntry {
  readonly file: string;
  readonly record: TurnRecord;
}
