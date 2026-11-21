import { LIMITS } from "@emend/contract";
import type { HtmlCodeColour } from "@emend/core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Executor, WorkResult } from "../publish/work.ts";
import { clearCodeColourCache, closeCodeColourRenderer, codeColours, codeColourTiming } from "./code-colours.ts";

const timing = { ...codeColourTiming };
const page = '<pre><code class="language-ts">const seed = "🌱";</code></pre>';
const colours: HtmlCodeColour[] = [
  { start: 30, end: 48, markup: '<span style="color:var(--syn-keyword)">const</span>' },
];
const result: WorkResult = { kind: "code-colours", colours };
const executor = () => vi.fn<Executor>().mockResolvedValue(result);

beforeEach(() => {
  Object.assign(codeColourTiming, timing);
  clearCodeColourCache();
});
afterEach(async () => {
  await closeCodeColourRenderer();
  clearCodeColourCache();
  Object.assign(codeColourTiming, timing);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("colours come from the executor and the job receives the page as UTF-8 bytes", async () => {
  const deps = { publishExecutor: executor() };
  expect(await codeColours(deps, "owner:doc", page)).toBe(colours);
  expect(deps.publishExecutor).toHaveBeenCalledExactlyOnceWith({
    kind: "code-colours",
    bytes: new TextEncoder().encode(page).buffer,
  });
  expect(await codeColours(deps, "owner:doc", page)).toBe(colours);
  expect(deps.publishExecutor).toHaveBeenCalledOnce();
});

test("concurrent reads of one key share one job", async () => {
  const gate = Promise.withResolvers<WorkResult>();
  const deps = { publishExecutor: executor().mockReturnValue(gate.promise) };
  const first = codeColours(deps, "shared", page);
  const second = codeColours(deps, "shared", page);
  gate.resolve(result);
  expect(await Promise.all([first, second])).toEqual([colours, colours]);
  expect(await codeColours(deps, "shared", page)).toBe(colours);
  expect(deps.publishExecutor).toHaveBeenCalledOnce();
});

test.each(["<p>Plain synthetic doc</p>", "<codex>const seed = 1;</codex>"])(
  "a page without a code tag runs no job: %s",
  async (html) => {
    const deps = { publishExecutor: executor() };
    expect(await codeColours(deps, "plain", html)).toEqual([]);
    expect(deps.publishExecutor).not.toHaveBeenCalled();
  },
);

test("a page over the character cap runs no job", async () => {
  const deps = { publishExecutor: executor() };
  expect(await codeColours(deps, "large", page + "x".repeat(LIMITS.markdownDocBytes))).toEqual([]);
  expect(deps.publishExecutor).not.toHaveBeenCalled();
});

test("a parse that never answers meets the read deadline, times out and is retried after failedMs", async () => {
  vi.useFakeTimers();
  Object.assign(codeColourTiming, { renderMs: 30, deadlineMs: 20, failedMs: 1000 });
  // Stands for a tag with enough distinct attributes to outlast the worker's render limit.
  const deps = { publishExecutor: executor().mockReturnValueOnce(new Promise<never>(() => {})) };
  const read = codeColours(deps, "attributes", page);
  const settled = vi.fn();
  void read.then(settled);
  await vi.advanceTimersByTimeAsync(19);
  expect(settled).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(await read).toEqual([]);
  await vi.advanceTimersByTimeAsync(510);
  expect(await codeColours(deps, "attributes", page)).toEqual([]);
  await vi.advanceTimersByTimeAsync(999);
  expect(await codeColours(deps, "attributes", page)).toEqual([]);
  expect(deps.publishExecutor).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(await codeColours(deps, "attributes", page)).toBe(colours);
  expect(deps.publishExecutor).toHaveBeenCalledTimes(2);
});

test("a rejected job is marked failed without caching its fallback", async () => {
  vi.useFakeTimers();
  codeColourTiming.failedMs = 1000;
  const deps = { publishExecutor: executor().mockRejectedValueOnce(new Error("Worker failed")) };
  expect(await codeColours(deps, "failed", page)).toEqual([]);
  expect(await codeColours(deps, "failed", page)).toEqual([]);
  expect(deps.publishExecutor).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(codeColourTiming.failedMs);
  expect(await codeColours(deps, "failed", page)).toBe(colours);
  expect(deps.publishExecutor).toHaveBeenCalledTimes(2);
});

test("a resolved empty result is cached", async () => {
  const deps = { publishExecutor: executor().mockResolvedValue({ kind: "code-colours", colours: [] }) };
  expect(await codeColours(deps, "empty", page)).toEqual([]);
  expect(await codeColours(deps, "empty", page)).toEqual([]);
  expect(deps.publishExecutor).toHaveBeenCalledOnce();
});

test("a job that misses the read deadline still fills the cache", async () => {
  vi.useFakeTimers();
  Object.assign(codeColourTiming, { renderMs: 100, deadlineMs: 20 });
  const gate = Promise.withResolvers<WorkResult>();
  const deps = { publishExecutor: executor().mockReturnValue(gate.promise) };
  const read = codeColours(deps, "slow", page);
  await vi.advanceTimersByTimeAsync(codeColourTiming.deadlineMs);
  expect(await read).toEqual([]);
  const finished = codeColours(deps, "slow", page);
  gate.resolve(result);
  expect(await finished).toBe(colours);
  const later = { publishExecutor: executor().mockRejectedValue(new Error("Must use the cache")) };
  expect(await codeColours(later, "slow", page)).toBe(colours);
  expect(later.publishExecutor).not.toHaveBeenCalled();
  expect(deps.publishExecutor).toHaveBeenCalledOnce();
});

test("jobs run one at a time", async () => {
  const gate = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  let running = 0;
  let most = 0;
  const deps = {
    publishExecutor: vi.fn<Executor>(async () => {
      running += 1;
      most = Math.max(most, running);
      started.resolve();
      await gate.promise;
      running -= 1;
      return result;
    }),
  };
  const reads = ["one", "two", "three"].map((key) => codeColours(deps, key, page));
  await started.promise;
  expect(deps.publishExecutor).toHaveBeenCalledOnce();
  gate.resolve();
  expect(await Promise.all(reads)).toEqual([colours, colours, colours]);
  expect(deps.publishExecutor).toHaveBeenCalledTimes(3);
  expect(most).toBe(1);
});

test("a full queue skips a key without marking it failed", async () => {
  codeColourTiming.maxQueue = 1;
  const gate = Promise.withResolvers<WorkResult>();
  const deps = { publishExecutor: executor().mockReturnValue(gate.promise) };
  const running = codeColours(deps, "running", page);
  const queued = codeColours(deps, "queued", page);
  expect(await codeColours(deps, "full", page)).toEqual([]);
  expect(deps.publishExecutor).toHaveBeenCalledOnce();
  gate.resolve(result);
  expect(await Promise.all([running, queued])).toEqual([colours, colours]);
  expect(await codeColours(deps, "full", page)).toBe(colours);
  expect(deps.publishExecutor).toHaveBeenCalledTimes(3);
});

test("a cache hit moves to newest and the sixty-fifth entry evicts the oldest", async () => {
  const deps = { publishExecutor: executor() };
  for (let index = 0; index < 64; index++) await codeColours(deps, `doc:${index}`, page);
  await codeColours(deps, "doc:0", page);
  expect(deps.publishExecutor).toHaveBeenCalledTimes(64);
  await codeColours(deps, "doc:64", page);
  await codeColours(deps, "doc:0", page);
  await codeColours(deps, "doc:2", page);
  expect(deps.publishExecutor).toHaveBeenCalledTimes(65);
  await codeColours(deps, "doc:1", page);
  expect(deps.publishExecutor).toHaveBeenCalledTimes(66);
});

test("the byte cap counts every markup string as two bytes per character", async () => {
  // Two splices take 6 MB per entry; three entries exceed 16 MiB only when counted as UTF-16.
  const wide: HtmlCodeColour[] = [
    { start: 0, end: 1, markup: "x".repeat(1_500_000) },
    { start: 2, end: 3, markup: "x".repeat(1_500_000) },
  ];
  const deps = { publishExecutor: executor().mockResolvedValue({ kind: "code-colours", colours: wide }) };
  for (const key of ["one", "two", "three"]) await codeColours(deps, key, page);
  await codeColours(deps, "three", page);
  await codeColours(deps, "two", page);
  expect(deps.publishExecutor).toHaveBeenCalledTimes(3);
  await codeColours(deps, "one", page);
  expect(deps.publishExecutor).toHaveBeenCalledTimes(4);
});

test("an entry larger than the byte cap is returned without being cached", async () => {
  const wide: HtmlCodeColour[] = [{ start: 0, end: 1, markup: "x".repeat(8 * 1048576 + 1) }];
  const deps = { publishExecutor: executor().mockResolvedValue({ kind: "code-colours", colours: wide }) };
  expect(await codeColours(deps, "large", page)).toBe(wide);
  expect(await codeColours(deps, "large", page)).toBe(wide);
  expect(deps.publishExecutor).toHaveBeenCalledTimes(2);
});

test("clearing drops cached colours and failed keys", async () => {
  const deps = { publishExecutor: executor().mockRejectedValueOnce(new Error("Worker failed")) };
  await codeColours(deps, "failed", page);
  await codeColours(deps, "cached", page);
  clearCodeColourCache();
  expect(await codeColours(deps, "failed", page)).toBe(colours);
  expect(await codeColours(deps, "cached", page)).toBe(colours);
  expect(deps.publishExecutor).toHaveBeenCalledTimes(4);
});

test.each([
  { action: "clear", reset: clearCodeColourCache, fails: false },
  { action: "clear", reset: clearCodeColourCache, fails: true },
  { action: "close", reset: closeCodeColourRenderer, fails: false },
  { action: "close", reset: closeCodeColourRenderer, fails: true },
])("$action drops pending cache writes and failures ($fails), and skips queued jobs", async ({ reset, fails }) => {
  const gate = Promise.withResolvers<WorkResult>();
  const started = Promise.withResolvers<void>();
  const deps = {
    publishExecutor: vi.fn<Executor>(() => {
      started.resolve();
      return gate.promise;
    }),
  };
  const running = codeColours(deps, "running", page);
  const queued = codeColours(deps, "queued", page);
  await started.promise;
  await reset();
  if (fails) gate.reject(new Error("Worker failed"));
  else gate.resolve(result);
  await running;
  expect(await queued).toEqual([]);
  expect(deps.publishExecutor).toHaveBeenCalledOnce();
  const fresh = { publishExecutor: executor() };
  expect(await codeColours(fresh, "running", page)).toBe(colours);
  expect(await codeColours(fresh, "queued", page)).toBe(colours);
  expect(fresh.publishExecutor).toHaveBeenCalledTimes(2);
});
