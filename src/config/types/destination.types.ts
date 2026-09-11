import type { AgentWatchConfig } from './config.types.js';

/** Backend identity and explicit routes, independent of machine/root storage. */
export type Destination = Readonly<Pick<AgentWatchConfig, 'endpoint' | 'eventsUrl' | 'otlpUrl' | 'enforcementUrl'>>;

/** A write plan also records route removals so setup cannot erase them silently. */
export type DestinationTransition = {
  readonly routes: Readonly<Omit<Destination, 'endpoint'>>;
  readonly cleared: readonly ('eventsUrl' | 'otlpUrl' | 'enforcementUrl')[];
};
