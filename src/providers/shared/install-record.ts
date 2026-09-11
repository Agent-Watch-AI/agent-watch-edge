import { omitKeys } from '../../core/object.js';
import type { AgentInstallState, InstallState } from '../../storage/types/storage.types.js';

/** What one hook installation recorded about itself. */
interface HookInstallRecord {
  readonly hookConfigPath: string;
  readonly hookEvents: readonly string[];
  readonly hookCommand: string;
  readonly installedAt: Date;
  /** Manual follow-up steps the user has to take, e.g. Codex's trust prompt. */
  readonly notes?: readonly string[];
}

/**
 * Install state with one agent's hook registration recorded.
 *
 * Returns a new state rather than editing the one it was given: setup runs
 * several operations per agent and persists once at the end, and an operation
 * that edited shared state would make the order of those calls part of the
 * result.
 *
 * @param state - Current install state.
 * @param agentId - Agent that was just installed.
 * @param record - What was written, and where.
 * @returns The next install state.
 */
export function withHookInstall(state: InstallState, agentId: string, record: HookInstallRecord): InstallState {
  const previous = state.agents[agentId];

  return {
    ...state,
    agents: {
      ...state.agents,
      [agentId]: {
        ...previous,
        hooksInstalledAt: record.installedAt.toISOString(),
        hookConfigPath: record.hookConfigPath,
        hookEvents: [...record.hookEvents],
        hookCommand: record.hookCommand,
        otelOwnedKeys: previous?.otelOwnedKeys ?? [],
        notes: record.notes ? [...record.notes] : (previous?.notes ?? [])
      }
    }
  };
}

/**
 * Install state with one agent's hook registration forgotten.
 *
 * The agent's entry survives so any native-telemetry record on it stays
 * intact; only the hook fields are cleared.
 *
 * @param state - Current install state.
 * @param agentId - Agent whose hooks were removed.
 * @returns The next install state.
 */
export function withoutHookInstall(state: InstallState, agentId: string): InstallState {
  const previous = state.agents[agentId];

  if (!previous) return state;

  const cleared: AgentInstallState = { ...omitKeys(previous, new Set(['hooksInstalledAt'])), hookEvents: [] };

  return { ...state, agents: { ...state.agents, [agentId]: cleared } };
}

/**
 * Install state with one agent dropped entirely.
 *
 * For an agent whose config file is gone: there is nothing left to describe,
 * and a stale entry would make `status` claim an installation that no longer
 * exists.
 *
 * @param state - Current install state.
 * @param agentId - Agent to forget.
 * @returns The next install state.
 */
export function withoutAgent(state: InstallState, agentId: string): InstallState {
  if (!(agentId in state.agents)) return state;

  return { ...state, agents: omitKeys(state.agents, new Set([agentId])) };
}

/** What one native-telemetry configuration recorded about itself. */
interface OtelInstallRecord {
  readonly configPath: string;
  /** Config keys AgentWatch now owns, and may therefore remove later. */
  readonly ownedKeys: readonly string[];
  readonly configuredAt: Date;
  /**
   * Permission bits the file had before this write tightened it.
   *
   * The agent's config file is not ours, and `writeFileAtomic` preserves the
   * target's current mode by design — so tightening it once would otherwise
   * keep it tightened forever, including after the token is gone. Recording
   * the old bits is what makes the change reversible.
   */
  readonly priorMode?: number;
}

/**
 * Install state with one agent's native-telemetry configuration recorded.
 *
 * The owned-key list is the whole point of persisting this: without it,
 * uninstall cannot tell the variables we wrote from the ones the developer set
 * for their own collector.
 *
 * @param state - Current install state.
 * @param agentId - Agent that was just configured.
 * @param record - What was written, and where.
 * @returns The next install state.
 */
export function withOtelInstall(state: InstallState, agentId: string, record: OtelInstallRecord): InstallState {
  const previous = state.agents[agentId];

  return {
    ...state,
    agents: {
      ...state.agents,
      [agentId]: {
        ...previous,
        hookEvents: previous?.hookEvents ?? [],
        notes: previous?.notes ?? [],
        otelConfiguredAt: record.configuredAt.toISOString(),
        otelConfigPath: record.configPath,
        otelOwnedKeys: [...new Set(record.ownedKeys)],
        // First tightening wins: a second configure must not record the 0600 we
        // ourselves left behind as the file's original mode.
        ...(record.priorMode !== undefined && previous?.otelPriorMode === undefined ? { otelPriorMode: record.priorMode } : {})
      }
    }
  };
}

/**
 * Install state with one agent's native-telemetry record cleared.
 *
 * @param state - Current install state.
 * @param agentId - Agent whose configuration was removed.
 * @returns The next install state.
 */
export function withoutOtelInstall(state: InstallState, agentId: string): InstallState {
  const previous = state.agents[agentId];

  if (!previous) return state;

  return {
    ...state,
    agents: {
      ...state.agents,
      [agentId]: { ...omitKeys(previous, new Set(['otelConfiguredAt', 'otelPriorMode'])), otelOwnedKeys: [] }
    }
  };
}
