import { TestRunner, vi } from "vitest";

// Vitest treats a test timeout of 0 as unlimited, and a timer given 0 or Infinity fires at once.
const LONGEST_TIMER_DELAY = 2_147_483_647;
const STOP = Symbol("test finished");
type PollTask = Pick<NonNullable<ReturnType<typeof TestRunner.getCurrentTest>>, "timeout" | "result">;

/**
 * For state without a completion event. Each poll gets the test's full timeout from its own start;
 * timeout 0 uses the longest supported timer delay. Body polls stop calling the assertion when the
 * body finishes, and cleanup polls when Vitest leaves the test. Both reject if stopped before success.
 * Not for concurrent tests: Vitest keeps a single current-test variable.
 */
export async function pollUntil<T>(assertion: () => T | Promise<T>, options: { interval?: number } = {}): Promise<T> {
  return pollUntilForTask(TestRunner.getCurrentTest(), () => TestRunner.getCurrentTest(), assertion, options);
}

/** Lifecycle inputs are explicit so the stop rules can be tested without timing out a real test. */
export async function pollUntilForTask<T>(
  task: PollTask | undefined,
  currentTest: () => PollTask | undefined,
  assertion: () => T | Promise<T>,
  options: { interval?: number } = {},
): Promise<T> {
  if (!task) throw new Error("pollUntil must run inside a test");
  const body = task.result?.state === "run";
  const timeout = task.timeout === 0 ? LONGEST_TIMER_DELAY : task.timeout;
  const result = await vi.waitFor(
    () => {
      if (currentTest() !== task || (body && task.result?.state !== "run")) return STOP;
      return assertion();
    },
    { ...options, timeout },
  );
  if (result === STOP) throw new Error("pollUntil: the test finished before the condition held");
  return result;
}
