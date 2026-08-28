import { GIT_TIMEOUT_MS } from '../git/constants/git.constants.js';
import type { GitRunner } from '../git/types/git.types.js';

/**
 * How long a deadline still allows, never below zero.
 *
 * @param deadline - Epoch milliseconds the flow must be finished by.
 * @param now - Current time, injectable for tests.
 * @returns Milliseconds left.
 */
export function remainingMs(deadline: number, now: () => number = Date.now): number {
  return Math.max(0, deadline - now());
}

/**
 * A git runner that cannot outlive the flow's budget.
 *
 * Without this the budget bounds nothing that matters: the listing may wait a
 * second, resolving the default branch may wait three more across its
 * fallbacks, and a `git log` that started inside the budget runs to its own
 * timeout regardless. Four sequential seconds is not "at most one", and this
 * runs on the hook's answer path.
 *
 * A call with no time left is not made at all — its caller reads the absent
 * output the same way it reads a repository that could not be listed.
 *
 * @param run - The real runner.
 * @param deadline - Epoch milliseconds the flow must be finished by.
 * @param now - Current time, injectable for tests.
 * @returns A runner whose timeout is whatever is left, capped at the git default.
 */
export function budgetedRunner(
  run: GitRunner,
  deadline: number,
  now: () => number = Date.now
): GitRunner {
  return async (args, cwd, timeoutMs, home) => {
    const left = remainingMs(deadline, now);

    if (left === 0) return undefined;

    return run(args, cwd, Math.min(timeoutMs || GIT_TIMEOUT_MS, left), home);
  };
}

/**
 * Give up on work that outlives the budget.
 *
 * Used for the two local writes at the end of the flow. Abandoning either is
 * safe by construction: an enqueue that did not finish means nothing was
 * recorded as sent, and a cache write that did not finish means the branches
 * are simply offered again next turn.
 *
 * @param work - The promise to bound.
 * @param deadline - Epoch milliseconds the flow must be finished by.
 * @param now - Current time, injectable for tests.
 * @returns True when the work finished inside the budget.
 */
export async function withinBudget(
  work: Promise<unknown>,
  deadline: number,
  now: () => number = Date.now
): Promise<boolean> {
  const left = remainingMs(deadline, now);

  if (left === 0) return false;

  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), left);
    // The flow must never be the reason a hook process stays alive.
    timer.unref?.();
  });

  try {
    return await Promise.race([work.then(() => true), expiry]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
