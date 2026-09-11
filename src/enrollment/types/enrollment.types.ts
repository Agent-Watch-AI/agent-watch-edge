/** What `setup` has to work out before it can write a configuration. */
export interface EnrollmentInput {
  /** URL passed to `agentwatch setup`, when any. */
  readonly setupUrl?: string;
  /** --endpoint flag, or the already-configured endpoint. */
  readonly endpoint?: string;
  /** --token flag, or the already-configured token. */
  readonly token?: string;
  /** Interactive prompt; undefined in non-interactive runs. */
  readonly ask?: (question: string) => Promise<string>;
}

export interface EnrollmentResult {
  readonly endpoint: string;
  readonly token?: string;
}
