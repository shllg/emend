import { expect, onTestFinished, TestRunner, test, vi } from "vitest";
import { pollUntil, pollUntilForTask } from "./poll-until.ts";

// Spy on the helper's options; all polling still goes through pollUntil.
const pollingApi = vi;

test("each poll gets the test's full timeout, above Vitest's default wait deadline", { timeout: 10000 }, async ({
  task,
}) => {
  const wait = vi.spyOn(pollingApi, "waitFor").mockResolvedValue("ready");
  onTestFinished(() => wait.mockRestore());
  expect(await pollUntil(() => "ready", { interval: 7 })).toBe("ready");
  expect(wait).toHaveBeenCalledWith(expect.any(Function), { interval: 7, timeout: task.timeout });
});

test("calling outside a test returns a rejected promise", async () => {
  const current = vi.spyOn(TestRunner, "getCurrentTest").mockReturnValue(undefined);
  onTestFinished(() => current.mockRestore());
  const assertion = vi.fn();
  const result = pollUntil(assertion);
  expect(result).toBeInstanceOf(Promise);
  await expect(result).rejects.toThrow("pollUntil must run inside a test");
  expect(assertion).not.toHaveBeenCalled();
});

// Drive waitFor's attempts directly: Vitest's polling scheduler uses safe (real) timers,
// even when application timers are faked. These lifecycle checks need no clock at all.
function pollingAttempts() {
  let attempt: () => unknown = () => {
    throw new Error("poll has not started");
  };
  const done = Promise.withResolvers<unknown>();
  const wait = vi.spyOn(pollingApi, "waitFor").mockImplementation((assertion) => {
    attempt = assertion;
    return done.promise;
  });
  onTestFinished(() => wait.mockRestore());
  return {
    pending: () => expect(attempt).toThrow("not yet"),
    finish: () => done.resolve(attempt()),
  };
}

test.each(["fail", "pass", "next test"] as const)("a body poll stops on %s", async (end) => {
  const attempts = pollingAttempts();
  const task: NonNullable<Parameters<typeof pollUntilForTask>[0]> = { timeout: 5000, result: { state: "run" } };
  let current = task;
  const assertion = vi.fn(() => {
    throw new Error("not yet");
  });
  const result = pollUntilForTask(task, () => current, assertion);
  const rejected = expect(result).rejects.toThrow("the test finished before the condition held");
  attempts.pending();
  expect(assertion).toHaveBeenCalledOnce();
  if (end === "next test") current = { ...task };
  else task.result = { state: end };
  attempts.finish();
  await rejected;
  expect(assertion).toHaveBeenCalledOnce();
});

test.each(["pass", "fail"] as const)(
  "a cleanup poll after %s stops only when Vitest leaves the test",
  async (state) => {
    const attempts = pollingAttempts();
    const task: NonNullable<Parameters<typeof pollUntilForTask>[0]> = { timeout: 5000, result: { state } };
    let current: typeof task | undefined = task;
    const assertion = vi.fn(() => {
      throw new Error("not yet");
    });
    const result = pollUntilForTask(task, () => current, assertion);
    const rejected = expect(result).rejects.toThrow("the test finished before the condition held");
    attempts.pending();
    attempts.pending();
    expect(assertion).toHaveBeenCalledTimes(2);
    current = undefined;
    attempts.finish();
    await rejected;
    expect(assertion).toHaveBeenCalledTimes(2);
  },
);

test("polling under an unlimited test timeout keeps polling until the condition holds", { timeout: 0 }, async () => {
  let calls = 0;
  const value = await pollUntil(() => {
    calls++;
    if (calls < 3) throw new Error("not yet");
    return calls;
  });
  expect(value).toBe(3);
  expect(calls).toBe(3);
});
