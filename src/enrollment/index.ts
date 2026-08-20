/**
 * Acquiring an endpoint and credentials. The MVP ships the manual provider; the
 * abstraction is what lets a future remote enrollment slot in without touching
 * setup.
 */
export type { EnrollmentInput, EnrollmentProvider, EnrollmentResult } from './types/enrollment.types.js';

export { ManualEnrollmentProvider } from './manual-enrollment.js';
