import { TestRunner, vi } from "vitest";

// Vitest treats a test timeout of 0 as unlimited, and a timer given 0 or Infinity fires at once.
const LONGEST_TIMER_DELAY = 2_147_483_647;

/**
 * For state without a completion event. The running test owns the deadline.
 * Not for concurrent tests: Vitest keeps a single current-test variable, so the deadline would be the wrong test's.
 */
export function pollUntil<T>(assertion: () => T | Promise<T>, options: { interval?: number } = {}): Promise<T> {
  const task = TestRunner.getCurrentTest();
  if (!task) throw new Error("pollUntil must run inside a test");
  return vi.waitFor(assertion, { ...options, timeout: task.timeout || LONGEST_TIMER_DELAY });
}
