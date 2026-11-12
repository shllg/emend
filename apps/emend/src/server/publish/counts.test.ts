import { randomUUID } from "node:crypto";
import type { PublishFile } from "@emend/contract";
import { beforeEach, expect, test, vi } from "vitest";
import { pacing } from "../pacing.ts";
import { countDiffFiles, createDiffCountBudget, DIFF_COUNT_NULL_TTL_MS } from "./counts.ts";
import { WorkTimeout } from "./executor.ts";
import { PublishAborted } from "./lifecycle.ts";
import { type Executor, executeWork } from "./work.ts";

let ownerId: string;
beforeEach(() => {
  ownerId = randomUUID();
});

const file = (path: string, values: Partial<PublishFile> = {}): PublishFile => ({
  path,
  role: "diff",
  oldPath: null,
  oldBlob: "a".repeat(64),
  newBlob: "b".repeat(64),
  flag: null,
  ...values,
});
const read = async (sha: string) => new TextEncoder().encode(sha.startsWith("a") ? "old\n" : "new\nextra\n").buffer;

test("only unflagged diffs are counted, with one job per ordered blob pair", async () => {
  const execute = vi.fn(executeWork);
  const result = await countDiffFiles(
    ownerId,
    [
      file("first"),
      file("alias"),
      file("reverse", { oldBlob: "b".repeat(64), newBlob: "a".repeat(64) }),
      file("added", { oldBlob: null }),
      file("deleted", { newBlob: null }),
      file("binary", { flag: "binary" }),
      file("large", { flag: "oversized" }),
      file("doc", { role: "doc" }),
    ],
    read,
    execute,
  );
  expect(result).toEqual(
    new Map([
      ["first", { additions: 2, deletions: 1 }],
      ["alias", { additions: 2, deletions: 1 }],
      ["reverse", { additions: 1, deletions: 2 }],
      ["added", { additions: 2, deletions: 0 }],
      ["deleted", { additions: 0, deletions: 1 }],
    ]),
  );
  expect(execute).toHaveBeenCalledTimes(4);
});

test("the cumulative budget stops new work and leaves remaining files null", async () => {
  let time = 0;
  const execute = vi.fn<Executor>(async () => {
    time += 6;
    return { kind: "diff-counts", counts: { additions: 2, deletions: 1 } };
  });
  const files = Array.from({ length: 4 }, (_, i) => file(`${i}`, { newBlob: String(i).repeat(64) }));
  const result = await countDiffFiles(ownerId, files, read, execute, undefined, createDiffCountBudget(10), () => time);
  expect([...result.values()]).toEqual([{ additions: 2, deletions: 1 }, { additions: 2, deletions: 1 }, null, null]);
  expect(execute).toHaveBeenCalledTimes(2);
  const unread = vi.fn(read);
  expect(await countDiffFiles(ownerId, [file("zero")], unread, execute, undefined, createDiffCountBudget(0))).toEqual(
    new Map([["zero", null]]),
  );
  expect(unread).not.toHaveBeenCalled();
});

test.each(["timeout", "failure", "wrong kind"])(
  "a thrown %s is not memoized and a later call stores recovered counts",
  async (outcome) => {
    const execute = vi.fn(executeWork);
    if (outcome === "wrong kind") execute.mockResolvedValueOnce({ kind: "line-count", count: 0 });
    else execute.mockRejectedValueOnce(outcome === "timeout" ? new WorkTimeout() : new Error("Worker failed"));
    const result = await countDiffFiles(ownerId, [file("failed"), file("next", { oldBlob: null })], read, execute);
    expect([...result.values()]).toEqual([null, { additions: 2, deletions: 0 }]);
    expect(execute).toHaveBeenCalledTimes(2);
    const recovered = await countDiffFiles(ownerId, [file("failed")], read, execute);
    expect(recovered.get("failed")).toEqual({ additions: 2, deletions: 1 });
    expect(execute).toHaveBeenCalledTimes(3);
    expect(await countDiffFiles(ownerId, [file("failed")], read, execute)).toEqual(recovered);
    expect(execute).toHaveBeenCalledTimes(3);
  },
);

test("failed counting consumes the revision budget too", async () => {
  let time = 0;
  const execute = vi.fn<Executor>(async () => {
    time += 10;
    throw new WorkTimeout();
  });
  expect([
    ...(await countDiffFiles(
      ownerId,
      [file("one"), file("two", { oldBlob: null })],
      read,
      execute,
      undefined,
      createDiffCountBudget(10),
      () => time,
    )),
  ]).toEqual([
    ["one", null],
    ["two", null],
  ]);
  expect(execute).toHaveBeenCalledTimes(1);
});

test("a jsdiff timeout remains null", async () => {
  const execute = vi.fn<Executor>(async () => ({ kind: "diff-counts", counts: null }));
  expect(await countDiffFiles(ownerId, [file("one"), file("alias")], read, execute)).toEqual(
    new Map([
      ["one", null],
      ["alias", null],
    ]),
  );
  expect(execute).toHaveBeenCalledTimes(1);
});

test("abort is never swallowed, including after the budget is spent", async () => {
  const controller = new AbortController();
  const execute: Executor = async () => {
    controller.abort();
    throw new WorkTimeout();
  };
  await expect(countDiffFiles(ownerId, [file("one")], read, execute, controller.signal)).rejects.toBeInstanceOf(
    PublishAborted,
  );
  await expect(
    countDiffFiles(ownerId, [file("one")], read, execute, controller.signal, createDiffCountBudget(0)),
  ).rejects.toBeInstanceOf(PublishAborted);
  for (const error of [new PublishAborted(), new DOMException("Aborted", "AbortError")])
    await expect(
      countDiffFiles(ownerId, [file("one")], read, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
});

test("the same owner's successful result is reused without reads, work or budget and never expires", async () => {
  const execute = vi.fn(executeWork);
  const first = await countDiffFiles(ownerId, [file("one")], read, execute);
  const unread = vi.fn(read);
  const now = vi.fn(() => Number.MAX_SAFE_INTEGER);
  const budget = createDiffCountBudget(0);
  expect(await countDiffFiles(ownerId, [file("one")], unread, execute, undefined, budget, now)).toEqual(first);
  expect(unread).not.toHaveBeenCalled();
  expect(now).not.toHaveBeenCalled();
  expect(execute).toHaveBeenCalledTimes(1);
  expect(budget.spentMs).toBe(0);
  await countDiffFiles(randomUUID(), [file("one")], read, execute);
  expect(execute).toHaveBeenCalledTimes(2);
});

test("a returned null expires after fifteen minutes and is retried subject to the budget", async () => {
  expect(DIFF_COUNT_NULL_TTL_MS).toBe(15 * 60 * 1000);
  let time = 100;
  const now = () => time;
  const execute = vi.fn(executeWork).mockResolvedValueOnce({ kind: "diff-counts", counts: null });
  const first = await countDiffFiles(ownerId, [file("one")], read, execute, undefined, createDiffCountBudget(), now);
  expect(first.get("one")).toBeNull();
  time += DIFF_COUNT_NULL_TTL_MS - 1;
  const unread = vi.fn(read);
  const emptyBudget = createDiffCountBudget(0);
  expect(await countDiffFiles(ownerId, [file("one")], unread, execute, undefined, emptyBudget, now)).toEqual(first);
  expect(unread).not.toHaveBeenCalled();
  expect(execute).toHaveBeenCalledTimes(1);
  expect(emptyBudget.spentMs).toBe(0);
  time++;
  expect(await countDiffFiles(ownerId, [file("one")], unread, execute, undefined, emptyBudget, now)).toEqual(first);
  expect(unread).not.toHaveBeenCalled();
  expect(execute).toHaveBeenCalledTimes(1);
  const retried = await countDiffFiles(ownerId, [file("one")], read, execute, undefined, createDiffCountBudget(), now);
  expect(retried.get("one")).toEqual({ additions: 2, deletions: 1 });
  expect(execute).toHaveBeenCalledTimes(2);
  time += DIFF_COUNT_NULL_TTL_MS * 2;
  expect(await countDiffFiles(ownerId, [file("one")], read, execute, undefined, createDiffCountBudget(), now)).toEqual(
    retried,
  );
  expect(execute).toHaveBeenCalledTimes(2);
});

test.each(["null", "timeout", "failure", "wrong kind"])(
  "a late %s cannot overwrite concurrent successful counts",
  async (outcome) => {
    const pending = Promise.withResolvers<Awaited<ReturnType<Executor>>>();
    const started = Promise.withResolvers<void>();
    const late = countDiffFiles(ownerId, [file("one")], read, async () => {
      started.resolve();
      return pending.promise;
    });
    await started.promise;
    const successful = await countDiffFiles(ownerId, [file("one")], read, executeWork);
    if (outcome === "null") pending.resolve({ kind: "diff-counts", counts: null });
    else if (outcome === "wrong kind") pending.resolve({ kind: "line-count", count: 0 });
    else pending.reject(outcome === "timeout" ? new WorkTimeout() : new Error("Worker failed"));
    expect((await late).get("one")).toBeNull();
    expect(successful.get("one")).toEqual({ additions: 2, deletions: 1 });
    const execute = vi.fn(executeWork);
    const unread = vi.fn(read);
    expect(await countDiffFiles(ownerId, [file("one")], unread, execute)).toEqual(successful);
    expect(execute).not.toHaveBeenCalled();
    expect(unread).not.toHaveBeenCalled();
  },
);

test("a budget-skipped pair is counted on the next request", async () => {
  const execute = vi.fn(executeWork);
  expect(await countDiffFiles(ownerId, [file("one")], read, execute, undefined, createDiffCountBudget(0))).toEqual(
    new Map([["one", null]]),
  );
  expect(execute).not.toHaveBeenCalled();
  expect(await countDiffFiles(ownerId, [file("one")], read, execute)).toEqual(
    new Map([["one", { additions: 2, deletions: 1 }]]),
  );
  expect(execute).toHaveBeenCalledTimes(1);
});

test.each(["signal", "error"])("an abort via %s never poisons the memo", async (via) => {
  const controller = new AbortController();
  await expect(
    countDiffFiles(
      ownerId,
      [file("one")],
      read,
      async () => {
        if (via === "signal") controller.abort();
        throw via === "signal" ? new WorkTimeout() : new DOMException("Aborted", "AbortError");
      },
      controller.signal,
    ),
  ).rejects.toThrow();
  const execute = vi.fn(executeWork);
  expect(await countDiffFiles(ownerId, [file("one")], read, execute)).toEqual(
    new Map([["one", { additions: 2, deletions: 1 }]]),
  );
  expect(execute).toHaveBeenCalledTimes(1);
  // A memo hit must still respect an already aborted request.
  controller.abort();
  await expect(countDiffFiles(ownerId, [file("one")], read, execute, controller.signal)).rejects.toBeInstanceOf(
    PublishAborted,
  );
});

test("each owner's cap evicts only that owner's oldest result", async () => {
  const otherOwner = randomUUID();
  const execute = vi.fn<Executor>(async () => ({ kind: "diff-counts", counts: { additions: 1, deletions: 0 } }));
  const files = Array.from({ length: 20000 }, (_, i) =>
    file(`${i}`, { oldBlob: null, newBlob: i.toString(16).padStart(64, "0") }),
  );
  await countDiffFiles(otherOwner, files.slice(0, 1), read, execute);
  await countDiffFiles(
    ownerId,
    files,
    async () => new ArrayBuffer(0),
    execute,
    undefined,
    createDiffCountBudget(),
    () => 0,
  );
  expect(execute).toHaveBeenCalledTimes(20001);
  await countDiffFiles(ownerId, files.slice(0, 1), read, execute);
  expect(execute).toHaveBeenCalledTimes(20001);
  await countDiffFiles(ownerId, [file("overflow", { oldBlob: null, newBlob: "f".repeat(64) })], read, execute);
  expect(execute).toHaveBeenCalledTimes(20002);
  await countDiffFiles(otherOwner, files.slice(0, 1), read, execute);
  await countDiffFiles(ownerId, files.slice(-1), read, execute);
  expect(execute).toHaveBeenCalledTimes(20002);
  await countDiffFiles(ownerId, files.slice(0, 1), read, execute);
  expect(execute).toHaveBeenCalledTimes(20003);
});

test("cached and skipped files still yield and observe cancellation", async () => {
  const controller = new AbortController();
  const probe = vi.fn(() => controller.abort());
  pacing.probe = probe;
  try {
    await expect(
      countDiffFiles(
        ownerId,
        Array.from({ length: 200 }, (_, i) => file(`${i}`)),
        read,
        executeWork,
        controller.signal,
        createDiffCountBudget(0),
      ),
    ).rejects.toBeInstanceOf(PublishAborted);
    expect(probe).toHaveBeenCalledWith("publish-counts");
  } finally {
    pacing.probe = undefined;
  }
});
