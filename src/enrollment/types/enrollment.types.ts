/**
 * Endpoint and credential acquisition.
 *
 * The MVP ships a manual provider — the user types a backend URL — and a future
 * RemoteEnrollmentProvider will implement `agentwatch setup <enrollment-url>`
 * (fetch org config, register the device, receive installation credentials)
 * without setup having to change.
 */
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

export interface EnrollmentProvider {
  enroll(input: EnrollmentInput): Promise<EnrollmentResult>;
}
