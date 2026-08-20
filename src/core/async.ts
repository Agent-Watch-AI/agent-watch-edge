/**
 * Resolve after a delay.
 *
 * @param ms - Milliseconds to wait.
 * @returns A promise that resolves once the timer fires.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll an acquire function until it hands something back or the deadline
 * passes.
 *
 * The deadline is real time on purpose: callers inject a frozen clock in
 * tests, and a frozen clock would make a wait loop spin forever.
 *
 * @param acquire - Attempt; returns the resource, or undefined to retry.
 * @param maxWaitMs - Total budget for the whole wait.
 * @param pollMs - Pause between attempts.
 * @returns The resource, or undefined when the budget ran out.
 */
export async function pollUntil<T>(acquire: () => Promise<T | undefined>, maxWaitMs: number, pollMs: number): Promise<T | undefined> {
  const deadline = Date.now() + maxWaitMs;

  for (;;) {
    const acquired = await acquire();

    if (acquired !== undefined) return acquired;

    if (Date.now() >= deadline) return undefined;

    await sleep(pollMs);
  }
}
