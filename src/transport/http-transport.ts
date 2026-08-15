import type { ProductEvent } from '../events/product-event.js';
import type { DeliveryResult, EventTransport } from './transport.js';

export interface HttpTransportOptions {
  eventsUrl: string;
  token?: string;
  installationId?: string;
  timeoutMs: number;
  fetchFn?: typeof fetch;
}

/**
 * POST {events: [...]} to the configured backend. Bounded by a short timeout:
 * this runs on the coding agent's critical path.
 */
export class HttpTransport implements EventTransport {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: HttpTransportOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
  }

  get destination(): string {
    return this.options.eventsUrl;
  }

  async send(events: ProductEvent[]): Promise<DeliveryResult> {
    if (events.length === 0) return { ok: true, retryable: false };
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': 'agentwatch-bridge'
    };
    if (this.options.token) headers['authorization'] = `Bearer ${this.options.token}`;
    if (this.options.installationId) headers['x-agentwatch-installation'] = this.options.installationId;

    try {
      const response = await this.fetchFn(this.options.eventsUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ events }),
        signal: AbortSignal.timeout(this.options.timeoutMs)
      });
      if (response.ok) {
        return { ok: true, status: response.status, retryable: false, counters: await readCounters(response) };
      }
      return {
        ok: false,
        status: response.status,
        retryable: isRetryableStatus(response.status),
        error: `HTTP ${response.status}`
      };
    } catch (error) {
      // Never include response/request bodies in errors: they may carry event content.
      return { ok: false, retryable: true, error: (error as Error).name || 'network error' };
    }
  }
}

/**
 * A 202 can still carry per-event rejections; the batch "succeeding" while
 * events inside it were dropped is exactly the case the caller must see.
 * A backend that returns no JSON body is treated as counter-less, not failed.
 */
async function readCounters(response: Response): Promise<DeliveryResult['counters']> {
  try {
    const body = (await response.json()) as Record<string, unknown>;
    const numeric = (key: string): number => (typeof body[key] === 'number' ? (body[key] as number) : 0);
    return {
      accepted: numeric('accepted'),
      duplicate: numeric('duplicate'),
      rejected: numeric('rejected'),
      failed: numeric('failed')
    };
  } catch {
    return undefined;
  }
}

function isRetryableStatus(status: number): boolean {
  if (status >= 500) return true;
  // Auth/ratelimit problems are usually transient misconfiguration; retries
  // are capped by delivery.maxAttempts so they can't accumulate forever.
  return status === 401 || status === 403 || status === 408 || status === 429;
}
