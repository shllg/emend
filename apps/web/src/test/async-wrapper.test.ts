import { getConfig } from "@testing-library/react";
import { expect, onTestFinished, TestRunner, test, vi } from "vitest";
import { guardAsyncWrapper } from "./setup.ts";

type Task = Pick<NonNullable<ReturnType<typeof TestRunner.getCurrentTest>>, "result">;

function fixture(state: "run" | "pass" | "fail" = "run") {
  const task: Task = { result: { state } };
  let current: Task | undefined = task;
  const condition = Promise.withResolvers<string>();
  const checked = Promise.withResolvers<void>();
  let reads = 0;
  const getCurrent = () => {
    if (++reads === 2) checked.resolve();
    return current;
  };
  const cleaned = vi.fn();
  const previous = vi.fn(async (callback: () => Promise<string>) => {
    try {
      return await callback();
    } finally {
      cleaned();
    }
  });
  const callback = vi.fn(() => condition.promise);
  const result = guardAsyncWrapper(previous, getCurrent)(callback);
  const resumed = vi.fn();
  const observed = result.then(resumed, resumed);
  return {
    task,
    condition,
    previous,
    callback,
    cleaned,
    result,
    resumed,
    observed,
    leave: () => {
      current = undefined;
    },
    next: () => {
      current = { result: { state: "run" } };
    },
    async checked() {
      // The lifecycle check signals synchronously. One further microtask lets an incorrectly
      // forwarded result reach `resumed`, without any timer or real elapsed-time assumption.
      await checked.promise;
      await Promise.resolve();
    },
  };
}

test.each(["resolve", "reject"] as const)("an active wait preserves its wrapper's %s outcome", async (outcome) => {
  const f = fixture();
  const error = new Error("synthetic wait failure");
  if (outcome === "resolve") {
    f.condition.resolve("ready");
    await expect(f.result).resolves.toBe("ready");
  } else {
    f.condition.reject(error);
    await expect(f.result).rejects.toBe(error);
  }
  await f.observed;
  expect(f.previous).toHaveBeenCalledExactlyOnceWith(f.callback);
  expect(f.callback).toHaveBeenCalledOnce();
  expect(f.cleaned).toHaveBeenCalledOnce();
  expect(f.resumed).toHaveBeenCalledOnce();
});

for (const outcome of ["resolve", "reject"] as const) {
  test.each(["fail", "pass", "next test"] as const)(`a late ${outcome} never resumes a body after %s`, async (end) => {
    const f = fixture();
    if (end === "next test") f.next();
    else f.task.result = { state: end };
    if (outcome === "resolve") f.condition.resolve("later test's DOM matched");
    else f.condition.reject(new Error("late wait failure"));
    await f.checked();
    expect(f.cleaned).toHaveBeenCalledOnce();
    expect(f.resumed).not.toHaveBeenCalled();
  });

  test.each(["pass", "fail"] as const)(
    `a cleanup ${outcome} cannot resume after Vitest leaves a %s test`,
    async (state) => {
      const f = fixture(state);
      f.leave();
      if (outcome === "resolve") f.condition.resolve("ready");
      else f.condition.reject(new Error("late cleanup failure"));
      await f.checked();
      expect(f.cleaned).toHaveBeenCalledOnce();
      expect(f.resumed).not.toHaveBeenCalled();
    },
  );
}

test.each(["pass", "fail"] as const)("cleanup waits can settle while the %s test is still current", async (state) => {
  const f = fixture(state);
  f.condition.resolve("cleaned up");
  await expect(f.result).resolves.toBe("cleaned up");
  expect(f.cleaned).toHaveBeenCalledOnce();
});

test("setup installs the lifecycle wrapper", async ({ task }) => {
  const simulatedResult: { state: "run" | "fail" } = { state: "run" };
  const simulated: typeof task = { ...task, result: simulatedResult };
  const checked = Promise.withResolvers<void>();
  let reads = 0;
  const current = vi.spyOn(TestRunner, "getCurrentTest").mockImplementation(() => {
    if (++reads === 2) checked.resolve();
    return simulated;
  });
  onTestFinished(() => current.mockRestore());
  const condition = Promise.withResolvers<void>();
  const resumed = vi.fn();
  void getConfig()
    .asyncWrapper(() => condition.promise)
    .then(resumed, resumed);
  simulatedResult.state = "fail";
  // React's existing wrapper also runs: its rejection path cleans up without scheduling a timer.
  condition.reject(new Error("late Testing Library failure"));
  await checked.promise;
  await Promise.resolve();
  expect(resumed).not.toHaveBeenCalled();
});
