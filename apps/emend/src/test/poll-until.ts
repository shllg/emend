import { TestRunner, vi } from "vitest";

// Vitest treats a test timeout of 0 as unlimited, and a timer given 0 or Infinity fires at once.
const LONGEST_TIMER_DELAY = 2_147_483_647;

/**
 * For state without a completion event. Each poll gets only the running test's remaining real time.
 * An expired deadline fails immediately; a test timeout of 0 uses the longest supported timer delay.
 * Not for concurrent tests: Vitest keeps a single current-test variable, so the deadline would be the wrong test's.
 */
export function pollUntil<T>(assertion: () => T | Promise<T>, options: { interval?: number } = {}): Promise<T> {
  const task = TestRunner.getCurrentTest();
  if (!task) throw new Error("pollUntil must run inside a test");
  const start = task.result?.startTime;
  if (start === undefined) throw new Error("pollUntil requires the running test's start time");
  const timeout = task.timeout === 0 ? LONGEST_TIMER_DELAY : start + task.timeout - vi.getRealSystemTime();
  if (timeout <= 0) throw new Error("pollUntil cannot start at or after the test's deadline");
  return vi.waitFor(assertion, { ...options, timeout });
}
