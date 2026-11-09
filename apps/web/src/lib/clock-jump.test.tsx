import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useClockJump } from "./clock-jump.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "performance", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-11-04T12:00:00.000Z"));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test.each([2, -2])("detects a wall-clock jump of %s hours once, then uses the new baseline", (hours) => {
  const onJump = vi.fn();
  renderHook(() => useClockJump(onJump));
  act(() => void vi.advanceTimersByTime(60_000));
  expect(onJump).not.toHaveBeenCalled();
  const monotonic = performance.now();
  vi.setSystemTime(Date.now() + hours * 3_600_000);
  expect(performance.now()).toBe(monotonic);
  act(() => void vi.advanceTimersByTime(60_000));
  expect(onJump).toHaveBeenCalledOnce();
  act(() => void vi.advanceTimersByTime(3 * 60_000));
  expect(onJump).toHaveBeenCalledOnce();
});

test("normal ticks and clock differences of at most five seconds do not fire", () => {
  const onJump = vi.fn();
  const onTick = vi.fn();
  renderHook(() => useClockJump(onJump, onTick));
  act(() => void vi.advanceTimersByTime(10 * 60_000));
  expect(onTick).toHaveBeenCalledTimes(10);
  expect(onTick).toHaveBeenLastCalledWith(Date.now());
  expect(onJump).not.toHaveBeenCalled();
  vi.setSystemTime(Date.now() + 5_000);
  act(() => void vi.advanceTimersByTime(60_000));
  expect(onJump).not.toHaveBeenCalled();
  vi.setSystemTime(Date.now() - 5_001);
  act(() => void vi.advanceTimersByTime(60_000));
  expect(onJump).toHaveBeenCalledOnce();
});

test("uses the latest callback and clears its interval on unmount", () => {
  const first = vi.fn();
  const latest = vi.fn();
  const hook = renderHook(({ onJump }) => useClockJump(onJump), { initialProps: { onJump: first } });
  hook.rerender({ onJump: latest });
  vi.setSystemTime(Date.now() + 3_600_000);
  act(() => void vi.advanceTimersByTime(60_000));
  expect(first).not.toHaveBeenCalled();
  expect(latest).toHaveBeenCalledOnce();
  hook.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
