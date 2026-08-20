/**
 * Ambient runtime contracts shared by every module.
 */

/**
 * Ambient environment for every command. All filesystem locations, environment
 * variables and PATH lookups flow through this object so tests can run against
 * a temporary HOME without ever touching the developer's real agent configs.
 */
export interface Env {
  readonly home: string;
  readonly platform: NodeJS.Platform;
  readonly cwd: string;
  /** Mirrors `process.env`, which is mutable ambient state by nature. */
  readonly vars: Record<string, string | undefined>;
  now(): Date;
}

/** Any JSON object decoded from an untrusted source. */
export type UnknownRecord = Record<string, unknown>;

/**
 * One named stage of a flow. Receives the whole state and returns the next
 * state, or stops the flow. Never mutates its input.
 */
export interface Step<TState> {
  readonly name: string;
  run(state: TState): Promise<StepOutcome<TState>> | StepOutcome<TState>;
}

/**
 * What a stage hands back: the state to feed the next stage, or a terminal
 * state with the reason the flow ended early. Making "stop" an explicit value
 * — instead of a thrown error or a nullable return — is what keeps the flow
 * linear and every stage independently testable.
 */
export type StepOutcome<TState> =
  | { readonly kind: 'next'; readonly state: TState }
  | { readonly kind: 'stop'; readonly state: TState; readonly reason: string };

/** Where a flow ended and why; `stoppedAt` is empty when every stage ran. */
export interface FlowResult<TState> {
  readonly state: TState;
  readonly completed: boolean;
  readonly stoppedAt?: string;
  readonly reason?: string;
}

/** Per-stage trace hook. The flow itself stays pure; I/O lives in the observer. */
export type FlowObserver = (trace: FlowTrace) => void;

export interface FlowTrace {
  readonly step: string;
  readonly outcome: 'next' | 'stop' | 'threw';
  readonly reason?: string;
}
