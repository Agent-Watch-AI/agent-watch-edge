import type { FlowObserver, FlowResult, Step, StepOutcome } from './types/core.types.js';

export type { FlowObserver, FlowResult, FlowTrace, Step, StepOutcome } from './types/core.types.js';

/**
 * Wrap a state as "keep going": the next stage receives it verbatim.
 *
 * @param state - State the next stage should run on.
 * @returns A continue outcome carrying that state.
 */
export function next<TState>(state: TState): StepOutcome<TState> {
  return { kind: 'next', state };
}

/**
 * Wrap a state as "flow is done": remaining stages are skipped.
 *
 * @param state - Final state, returned to the caller as-is.
 * @param reason - Why the flow ended here; surfaces in diagnostics.
 * @returns A terminal outcome carrying that state.
 */
export function stop<TState>(state: TState, reason: string): StepOutcome<TState> {
  return { kind: 'stop', state, reason };
}

/**
 * Declare one stage of a flow. A stage is a pure function of the whole state:
 * it reads what it needs, returns the next state, and never mutates its input.
 *
 * @param name - Stage label used in traces and diagnostics.
 * @param run - The transformation; returns `next(...)` or `stop(...)`.
 * @returns The stage, ready to be listed in a flow.
 */
export function step<TState>(name: string, run: Step<TState>['run']): Step<TState> {
  return { name, run };
}

/**
 * Run stages left to right, threading one immutable state through them, and
 * stop at the first stage that says so.
 *
 * This is the shape every entry point in the package is expressed in: the flow
 * is a list of named stages you can read top to bottom, not a call graph you
 * have to trace. A stage that throws ends the flow the same way an explicit
 * stop does — the state stays whatever the last successful stage returned, so
 * a failure degrades the result instead of losing it.
 *
 * @param steps - Stages in execution order.
 * @param initial - State the first stage receives.
 * @param observe - Optional per-stage trace sink; the flow itself does no I/O.
 * @returns The final state, whether every stage ran, and where it stopped.
 */
export async function runFlow<TState>(steps: readonly Step<TState>[], initial: TState, observe?: FlowObserver): Promise<FlowResult<TState>> {
  let state = initial;

  for (const current of steps) {
    let outcome: StepOutcome<TState>;

    try {
      outcome = await current.run(state);
    } catch (error) {
      observe?.({ step: current.name, outcome: 'threw', reason: errorMessage(error) });

      return { state, completed: false, stoppedAt: current.name, reason: errorMessage(error) };
    }

    observe?.({ step: current.name, outcome: outcome.kind, reason: outcome.kind === 'stop' ? outcome.reason : undefined });

    if (outcome.kind === 'stop') {
      return { state: outcome.state, completed: false, stoppedAt: current.name, reason: outcome.reason };
    }

    state = outcome.state;
  }

  return { state, completed: true };
}

/**
 * Human-readable text for anything that reached a catch block.
 *
 * @param error - The thrown value, of any shape.
 * @returns Its message, or its string form when it is not an Error.
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
