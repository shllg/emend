import { randomUUID } from "node:crypto";
import type { PublishFile } from "@emend/contract";
import { beforeEach, expect, test, vi } from "vitest";
import { pacing } from "../pacing.ts";
import { countDiffFiles, createDiffCountBudget } from "./counts.ts";
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

test.each([new WorkTimeout(), new Error("Worker failed")])(
  "a failed pair is cached as null and counting continues (%s)",
  async (error) => {
    const execute = vi.fn(executeWork).mockRejectedValueOnce(error);
    const result = await countDiffFiles(
      ownerId,
      [file("failed"), file("alias"), file("next", { oldBlob: null })],
      read,
      execute,
    );
    expect([...result.values()]).toEqual([null, null, { additions: 2, deletions: 0 }]);
    expect(execute).toHaveBeenCalledTimes(2);
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

test.each(["success", "timeout", "failure"])(
  "the same owner's %s result is reused without reads, work or budget",
  async (outcome) => {
    const execute = vi.fn<Executor>(async (work) => {
      if (outcome === "timeout") throw new WorkTimeout();
      if (outcome === "failure") throw new Error("Worker failed");
      return executeWork(work);
    });
    const first = await countDiffFiles(ownerId, [file("one")], read, execute);
    const unread = vi.fn(read);
    const now = vi.fn(() => 0);
    const budget = createDiffCountBudget(0);
    expect(await countDiffFiles(ownerId, [file("one")], unread, execute, undefined, budget, now)).toEqual(first);
    expect(unread).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(budget.spentMs).toBe(0);
    await countDiffFiles(randomUUID(), [file("one")], read, execute);
    expect(execute).toHaveBeenCalledTimes(2);
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

test("the bounded memo evicts its oldest result", async () => {
  const execute = vi.fn<Executor>(async () => ({ kind: "diff-counts", counts: { additions: 1, deletions: 0 } }));
  const files = Array.from({ length: 20001 }, (_, i) =>
    file(`${i}`, { oldBlob: null, newBlob: i.toString(16).padStart(64, "0") }),
  );
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
  await countDiffFiles(ownerId, files.slice(-1), read, execute);
  expect(execute).toHaveBeenCalledTimes(20001);
  await countDiffFiles(ownerId, files.slice(0, 1), read, execute);
  expect(execute).toHaveBeenCalledTimes(20002);
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
