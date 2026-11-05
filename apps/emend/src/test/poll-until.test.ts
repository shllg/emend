import { expect, onTestFinished, test, vi } from "vitest";
import { pollUntil } from "./poll-until.ts";

// Spy on the helper's options; all polling still goes through pollUntil.
const pollingApi = vi;

test("each poll gets the test's remaining time, even above Vitest's default wait deadline", { timeout: 10000 }, async ({
  task,
}) => {
  const start = task.result?.startTime;
  if (start === undefined) throw new Error("missing test start");
  const now = vi.spyOn(vi, "getRealSystemTime");
  onTestFinished(() => now.mockRestore());
  const wait = vi.spyOn(pollingApi, "waitFor").mockResolvedValue("ready");
  onTestFinished(() => wait.mockRestore());
  for (const elapsed of [250, 4000, 9999]) {
    now.mockReturnValue(start + elapsed);
    expect(await pollUntil(() => "ready", { interval: 7 })).toBe("ready");
    expect(wait).toHaveBeenLastCalledWith(expect.any(Function), { interval: 7, timeout: task.timeout - elapsed });
  }
});

test.for([0, 1])("a poll starting %s ms past the deadline fails before calling its assertion", (past, { task }) => {
  const start = task.result?.startTime;
  if (start === undefined) throw new Error("missing test start");
  const now = vi.spyOn(vi, "getRealSystemTime").mockReturnValue(start + task.timeout + past);
  onTestFinished(() => now.mockRestore());
  const wait = vi.spyOn(pollingApi, "waitFor");
  onTestFinished(() => wait.mockRestore());
  const assertion = vi.fn();
  expect(() => pollUntil(assertion)).toThrow("at or after the test's deadline");
  expect(wait).not.toHaveBeenCalled();
  expect(assertion).not.toHaveBeenCalled();
});

test("fake Date and performance clocks do not change the poll's real deadline", async ({ task }) => {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  vi.setSystemTime(0);
  const wait = vi.spyOn(pollingApi, "waitFor").mockResolvedValue("ready");
  onTestFinished(() => wait.mockRestore());
  const start = task.result?.startTime;
  if (start === undefined) throw new Error("missing test start");
  const before = vi.getRealSystemTime();
  await pollUntil(() => "ready");
  const after = vi.getRealSystemTime();
  const options = wait.mock.calls[0]?.[1];
  if (typeof options !== "object") throw new Error("missing polling options");
  expect(options.timeout).toBeGreaterThanOrEqual(start + task.timeout - after);
  expect(options.timeout).toBeLessThanOrEqual(start + task.timeout - before);
});

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
