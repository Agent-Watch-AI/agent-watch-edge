/**
 * Endpoint/credential acquisition abstraction. The MVP ships a manual
 * provider (user types a backend URL); a future RemoteEnrollmentProvider will
 * implement `agentwatch setup <enrollment-url>` (fetch org config, register
 * the device, receive installation credentials) without changing setup.
 */
export interface EnrollmentInput {
  /** URL passed to `agentwatch setup`, when any. */
  setupUrl?: string;
  /** --endpoint flag or existing configured endpoint. */
  endpoint?: string;
  /** --token flag or existing configured token. */
  token?: string;
  /** Interactive prompt; undefined in non-interactive runs. */
  ask?: (question: string) => Promise<string>;
}

export interface EnrollmentResult {
  endpoint: string;
  token?: string;
}

export interface EnrollmentProvider {
  enroll(input: EnrollmentInput): Promise<EnrollmentResult>;
}
