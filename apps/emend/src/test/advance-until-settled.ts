import { setImmediate as nextTurn } from "node:timers/promises";
import { onTestFinished, vi } from "vitest";
import type * as pauseModule from "../cli/pause.ts";

/** The pending `pause()` calls of the code under test; see `trackPauses`. */
export type Pauses = { pending(): number };

/**
 * Counts the `pause()` calls (apps/emend/src/cli/pause.ts) that are asleep right now. The test file
 * must first replace that module with a copy that can be spied on:
 * `vi.mock("<path>/pause.ts", async (original) => ({ ...(await original<typeof import("<path>/pause.ts")>()) }))`.
 * Each call still runs the original, which sleeps on the faked `setTimeout`. Call it in the test; the
 * spy is restored when the test finishes.
 *
 * Limitation: the count says that some wait sleeps, not which one. With several concurrent operations,
 * one can sleep in `pause()` while another still awaits I/O, and the clock then advances under it.
 * A caller with concurrent waits must make sure that cannot change the outcome. The two-waits test
 * is sound because the Send is stored before the clock moves: whichever wait runs next, the
 * other one finds the Send claimed and can only time out.
 */
export function trackPauses(module: typeof pauseModule): Pauses {
  const original = module.pause;
  let pending = 0;
  const spy = vi.spyOn(module, "pause").mockImplementation((...args) => {
    pending++;
    try {
      return original(...args).finally(() => {
        pending--;
      });
    } catch (error) {
      // pause() throws at once for an already-aborted signal.
      pending--;
      throw error;
    }
  });
  onTestFinished(() => {
    spy.mockRestore();
  });
  return { pending: () => pending };
}

/**
 * Returns the value of `promise`, moving the fake clock only while the code under test is asleep in
 * `pause()`: it waits on real turns, with no timer moved, until the promise has settled or a pause is
 * pending, then runs the next timer (the pause's, which is earlier than a request timeout). With one
 * wait at a time, fake time never runs ahead of real I/O such as the database or a transport; see
 * `trackPauses` for concurrent waits. Needs `vi.useFakeTimers` and `trackPauses`. The loop ends when the
 * test finishes, and the test's own timeout does the failing.
 */
export async function advanceWhilePaused<T>(promise: Promise<T>, pauses: Pauses): Promise<T> {
  let settled = false;
  const done = promise.finally(() => {
    settled = true;
  });
  // Mark the rejection handled here; the caller's await below still throws it.
  done.catch(() => {});
  while (true) {
    await untilReal("the code under test to settle or sleep in pause()", () => settled || pauses.pending() > 0);
    if (settled) return done;
    await vi.advanceTimersToNextTimerAsync();
    // A real turn, so that a pause which has fired but is not yet counted down cannot spin the loop.
    await nextTurn();
  }
}

/**
 * Waits for `check` to pass without moving any timer, for readiness under fake timers: `vi.waitFor`
 * advances fake time on every check, which ties the fake budget of a wait to real load. `check`
 * passes when it returns anything but `false` and does not throw. It runs once per real event-loop
 * turn, until the test finishes; the test's own timeout does the failing, and the error names `what`.
 */
export async function untilReal<T>(what: string, check: () => T | Promise<T>): Promise<Exclude<T, false>> {
  let stopped = false;
  onTestFinished(() => {
    stopped = true;
  });
  let last: unknown;
  while (!stopped) {
    try {
      const value = await check();
      if (value !== false) return value as Exclude<T, false>;
      last = undefined;
    } catch (error) {
      last = error;
    }
    await nextTurn();
  }
  throw new Error(`The test finished while waiting for ${what}${last instanceof Error ? `: ${last.message}` : ""}`);
}
