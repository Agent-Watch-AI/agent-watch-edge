import { isRecord, omitKeys } from '../../core/object.js';
import type { UnknownRecord } from '../../core/types/core.types.js';
import { writeFileAtomic } from '../../storage/atomic-file.js';
import { isAgentWatchHookCommand } from '../provider.js';
import type { HookHandler, StripOptions, StripResult } from './types/hook-config.types.js';

export type { HookHandler, HookMatcherGroup, StripOptions, StripResult } from './types/hook-config.types.js';

/**
 * Whether one handler is an AgentWatch command.
 *
 * @param handler - Entry from an agent's hook list.
 * @returns True when we own it.
 */
export function isOurHandler(handler: unknown): boolean {
  const record = handler as HookHandler | null;

  if (!isRecord(record) || typeof record.command !== 'string') return false;

  return isAgentWatchHookCommand(record.command);
}

/**
 * Remove AgentWatch handlers from one event's entry list.
 *
 * Handlers, not whole groups: a user may have added their own handler into the
 * group we created, and uninstalling AgentWatch must not take it with us. A
 * group left with no handlers is dropped; anything we do not recognize is
 * passed through untouched.
 *
 * @param entries - The event's entry list.
 * @param options - Whether bare handlers are accepted alongside groups.
 * @returns The entries to keep.
 */
export function withoutOurHandlers(entries: readonly unknown[], options: StripOptions = {}): unknown[] {
  const kept: unknown[] = [];

  for (const entry of entries) {
    if (options.allowBareHandlers && isOurHandler(entry)) continue;

    const group = isRecord(entry) ? entry : undefined;
    const handlers = group?.['hooks'];

    if (!Array.isArray(handlers)) {
      kept.push(entry);
      continue;
    }

    const remaining = handlers.filter((handler) => !isOurHandler(handler));

    if (remaining.length === handlers.length) {
      kept.push(entry);
      continue;
    }

    // A group that was purely ours disappears with its last handler.
    if (remaining.length > 0) kept.push({ ...group, hooks: remaining });
  }

  return kept;
}

/**
 * Remove AgentWatch handlers from every event of a hook map.
 *
 * @param hooks - Event name to entry list.
 * @param options - Whether bare handlers are accepted alongside groups.
 * @returns The cleaned map and whether anything was removed.
 */
export function stripOurHandlers(hooks: UnknownRecord, options: StripOptions = {}): StripResult {
  const out: UnknownRecord = {};
  let changed = false;

  for (const [eventName, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) {
      out[eventName] = value;
      continue;
    }

    const kept = withoutOurHandlers(value, options);

    if (sameEntries(kept, value)) {
      out[eventName] = value;
      continue;
    }

    changed = true;

    // An event whose only handlers were ours is removed rather than left as an
    // empty list, which is how the agent's own config would express "none".
    if (kept.length > 0) out[eventName] = kept;
  }

  return { hooks: out, changed };
}

/**
 * Register AgentWatch's entry on each event, replacing our previous one.
 *
 * Existing user handlers on those events are preserved; ours are stripped
 * first so a re-run cannot accumulate duplicates — two registrations would
 * make every turn be processed, and counted, twice.
 *
 * @param hooks - Event name to entry list.
 * @param events - Events to register on.
 * @param entryFor - Builds our entry for one event.
 * @param options - Whether bare handlers are accepted alongside groups.
 * @returns The updated map.
 */
export function registerOurHandlers(
  hooks: UnknownRecord,
  events: readonly string[],
  entryFor: (eventName: string) => unknown,
  options: StripOptions = {}
): UnknownRecord {
  const out: UnknownRecord = { ...hooks };

  for (const eventName of events) {
    const existing = Array.isArray(out[eventName]) ? (out[eventName] as unknown[]) : [];

    out[eventName] = [...withoutOurHandlers(existing, options), entryFor(eventName)];
  }

  return out;
}

/**
 * Drop AgentWatch registrations from events we no longer subscribe to.
 *
 * Without this, an event registered by an earlier version keeps firing a hook
 * nothing reads.
 *
 * @param hooks - Event name to entry list.
 * @param registered - Events this version registers.
 * @param options - Whether bare handlers are accepted alongside groups.
 * @returns The updated map.
 */
export function sweepUnregisteredEvents(hooks: UnknownRecord, registered: readonly string[], options: StripOptions = {}): UnknownRecord {
  const keep = new Set(registered);
  const out: UnknownRecord = {};

  for (const [eventName, value] of Object.entries(hooks)) {
    if (keep.has(eventName) || !Array.isArray(value)) {
      out[eventName] = value;
      continue;
    }

    const kept = withoutOurHandlers(value, options);

    if (kept.length > 0) out[eventName] = kept;
  }

  return out;
}

/**
 * A config with its hooks block replaced, dropping the block when it is empty.
 *
 * An empty `hooks: {}` left behind is indistinguishable from a deliberate
 * empty configuration, so the key goes rather than being emptied.
 *
 * @param config - The whole config object.
 * @param hooks - The new hooks block.
 * @param key - Name of the block; agents differ ('hooks' everywhere so far).
 * @returns The next config object.
 */
export function withHooksBlock(config: UnknownRecord, hooks: UnknownRecord, key = 'hooks'): UnknownRecord {
  if (Object.keys(hooks).length === 0) return omitKeys(config, new Set([key]));

  return { ...config, [key]: hooks };
}

/**
 * Serialize and write an agent config, verifying it parses first.
 *
 * Agents reject an invalid config file wholesale — Claude stops honouring
 * every setting in it, not just the hooks — so a serialization bug must fail
 * before the file is touched, not after.
 *
 * @param targetPath - File to write.
 * @param value - The whole config object.
 */
export async function writeJsonValidated(targetPath: string, value: UnknownRecord): Promise<void> {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;

  JSON.parse(serialized);
  await writeFileAtomic(targetPath, serialized);
}

/**
 * Whether two entry lists are equivalent.
 *
 * @param left - One list.
 * @param right - The other.
 * @returns True when they describe the same registrations.
 */
function sameEntries(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && JSON.stringify(left) === JSON.stringify(right);
}
