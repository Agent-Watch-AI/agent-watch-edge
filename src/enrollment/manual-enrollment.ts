import type { EnrollmentInput, EnrollmentProvider, EnrollmentResult } from './enrollment-provider.js';

export class ManualEnrollmentProvider implements EnrollmentProvider {
  async enroll(input: EnrollmentInput): Promise<EnrollmentResult> {
    if (input.setupUrl) {
      throw new Error('enrollment URLs are not supported yet; pass the backend base URL via --endpoint or the prompt');
    }
    let endpoint = input.endpoint;
    if (!endpoint && input.ask) {
      endpoint = (await input.ask('AgentWatch backend URL: ')).trim();
    }
    if (!endpoint) {
      throw new Error('no backend endpoint provided (use --endpoint or run interactively)');
    }
    validateHttpUrl(endpoint);

    let token = input.token;
    if (token === undefined && input.ask) {
      token = (await input.ask('API token (optional, press Enter to skip): ')).trim() || undefined;
    }
    return { endpoint: endpoint.replace(/\/+$/, ''), token };
  }
}

function validateHttpUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`invalid URL: ${value}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`backend URL must be http(s), got ${url.protocol}`);
  }
}
