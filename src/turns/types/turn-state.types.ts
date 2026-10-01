import type { FailOpenReason } from '../../enforcement/types/enforcement.types.js';
import type { ContentEvidence } from '../../events/types/events.types.js';
import type { Fingerprint } from '../../git/types/git.types.js';

/** A prompt the developer submitted: when, its length and SHA-256, and its text when `promptText` is on. */
export interface PromptRecord {
  readonly kind: 'prompt';
  readonly at: string;
  readonly turnId?: string;
  readonly evidence?: ContentEvidence;
  /** Scrubbed and bounded; present only when `capture.promptText` was on at the prompt hook. */
  readonly text?: string;
  /**
   * Why this prompt ran without an enforcement decision, when it did.
   *
   * On the prompt record because the check and the summary happen in different
   * hook processes, and this record is the file the prompt hook writes anyway —
   * so reporting a fail-open costs no write of its own, and it belongs to exactly
   * the turn it happened on.
   */
  readonly failOpenReason?: FailOpenReason;
}

/** One tool call the agent completed. */
export interface ToolRecord {
  readonly kind: 'tool';
  readonly at: string;
  readonly turnId?: string;
  readonly tool?: string;
  readonly filePath?: string;
  /**
   * The absolute root of the checkout `filePath` is relative to, wherever it
   * lies; absent for a file in no checkout, whose path is a bare basename.
   *
   * Local turn state only, never on the wire: it exists so the closing turn can
   * decide which checkout the turn worked in. Absolute because the cwd each
   * hook reports moves with a lasting `cd`, so a path relative to the tool
   * hook's cwd means nothing to the Stop hook's.
   */
  readonly repositoryRoot?: string;
  /**
   * Reads and edits are different product signals: a file the agent merely
   * read must not appear in the summary's files_touched (modified) list.
   */
  readonly access?: 'read' | 'edit';
  /** A file outside every checkout, home-relative; under `capture.files`. */
  readonly externalPath?: string;
  /** The shell command or connector call, bounded; under `capture.toolInput`. */
  readonly input?: ToolInputSummary;
}

/** What went into one shell or connector (MCP) call, as the turn summary sends it. */
export interface ToolInputSummary {
  readonly tool: string;
  /** Shell command text. */
  readonly command?: string;
  /** Connector server: its name, or for Cursor its url or launch command. */
  readonly server?: string;
  /** Connector tool name. */
  readonly name?: string;
  /** Connector arguments as JSON text, cut at the bound. */
  readonly arguments?: string;
}

/** How a turn came to name a checkout. */
export type CheckoutVia = 'cwd' | 'file' | 'shell';

/**
 * A checkout a turn named, from one tool hook. Local turn state only, never sent.
 *
 * The first record of a root in a turn carries its `seq` (order of first
 * sight) and its `baseline`; later ones are votes. A root's record from a shell
 * call is a vote for it; the call's own cwd votes only when the call named no
 * checkout (`named: false`), because where an agent sits is weaker evidence
 * than where it says it is looking.
 */
export interface CheckoutRecord {
  readonly kind: 'checkout';
  readonly at: string;
  readonly turnId?: string;
  /** Canonical absolute root. */
  readonly root: string;
  readonly via: CheckoutVia;
  /** The call named a checkout in its shell command. */
  readonly named: boolean;
  /** Order of first sight in the turn; only on a root's first record. */
  readonly seq?: number;
  /** The checkout when the turn first named it; absent when git could not say. */
  readonly baseline?: Fingerprint;
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
export type TurnRecord = PromptRecord | ToolRecord | ResponseRecord | CheckoutRecord;

/** The session's last changed checkout, as `work-checkout.json` holds it. Local only. */
export interface WorkCheckoutMemo {
  readonly root: string;
  readonly repository: string;
  readonly at: string;
}

/** A record together with the file it was read from, so it can be consumed. */
export interface TurnStateEntry {
  readonly file: string;
  readonly record: TurnRecord;
}
