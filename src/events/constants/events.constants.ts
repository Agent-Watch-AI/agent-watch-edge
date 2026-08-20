/**
 * The canonical event vocabulary. Provider adapters translate native hook
 * payloads into these types; nothing outside this list is ever emitted.
 */

/**
 * Hook lifecycle events are an internal assembly format. They are consumed
 * locally to build a turn summary and must never be exposed as product
 * records. The public data model is deliberately limited to
 * PRODUCT_EVENT_TYPES below.
 */
export const INTERNAL_HOOK_EVENT_TYPES = [
  'session.started',
  'session.ended',
  'prompt.submitted',
  'tool.started',
  'tool.completed',
  'tool.failed',
  'permission.requested',
  'file.read',
  'file.edited',
  'shell.started',
  'shell.completed',
  'mcp.started',
  'mcp.completed',
  'subagent.started',
  'subagent.completed',
  'generation.completed',
  'compaction.started',
  'compaction.completed',
  'agent.error',
  /** Provider event we don't model yet; preserved as metadata instead of dropped. */
  'agent.other'
] as const;

/** The only two record types accepted by the AgentWatch product backend. */
export const PRODUCT_EVENT_TYPES = ['llm.call', 'turn.summary'] as const;

export const CANONICAL_EVENT_TYPES = [...INTERNAL_HOOK_EVENT_TYPES, ...PRODUCT_EVENT_TYPES] as const;

/** O(1) membership for the hot path: queue drain checks this per entry. */
export const PRODUCT_EVENT_TYPE_SET: ReadonlySet<string> = new Set<string>(PRODUCT_EVENT_TYPES);

/** Canonical event types that close a turn. */
export const TURN_CLOSING_EVENT_TYPE = 'generation.completed';

/** Schema version stamped on every canonical event. */
export const EVENT_SCHEMA_VERSION = '1';

/** Prefix on every derived event id. */
export const EVENT_ID_PREFIX = 'evt_';

/**
 * Hex characters kept from the id digest. 160 bits is collision-free at any
 * volume a single developer machine can produce, and keeps the id short enough
 * to be a queue filename.
 */
export const EVENT_ID_HEX_LENGTH = 40;
