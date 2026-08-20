import type { UnknownRecord } from '../../../core/types/core.types.js';

/**
 * A matcher group as Claude, Codex, Gemini and Antigravity write it: an
 * optional tool-name matcher plus a list of command handlers.
 */
export interface HookMatcherGroup {
  readonly matcher?: string;
  readonly hooks: readonly UnknownRecord[];
  readonly [key: string]: unknown;
}

/** One command handler inside a group (or, for Cursor, on its own). */
export interface HookHandler {
  readonly type?: string;
  readonly command?: string;
  readonly timeout?: number;
  readonly [key: string]: unknown;
}

export interface StripOptions {
  /**
   * Also treat a bare handler as strippable.
   *
   * Antigravity accepts both a matcher group and a bare handler in the same
   * list, so both shapes have to be recognized or an uninstall would leave one
   * behind.
   */
  readonly allowBareHandlers?: boolean;
}

/** An event map with AgentWatch's entries removed, and whether that changed it. */
export interface StripResult {
  readonly hooks: UnknownRecord;
  readonly changed: boolean;
}
