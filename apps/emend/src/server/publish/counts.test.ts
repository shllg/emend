import type { PublishFile } from "@emend/contract";
import { expect, test, vi } from "vitest";
import { pacing } from "../pacing.ts";
import { countDiffFiles } from "./counts.ts";
import { WorkTimeout } from "./executor.ts";
import { PublishAborted } from "./lifecycle.ts";
import { type Executor, executeWork } from "./work.ts";

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
  const result = await countDiffFiles(files, read, execute, undefined, 10, () => time);
  expect([...result.values()]).toEqual([{ additions: 2, deletions: 1 }, { additions: 2, deletions: 1 }, null, null]);
  expect(execute).toHaveBeenCalledTimes(2);
  const unread = vi.fn(read);
  expect(await countDiffFiles([file("zero")], unread, execute, undefined, 0)).toEqual(new Map([["zero", null]]));
  expect(unread).not.toHaveBeenCalled();
});

test.each([new WorkTimeout(), new Error("Worker failed")])(
  "a failed pair is cached as null and counting continues (%s)",
  async (error) => {
    const execute = vi.fn(executeWork).mockRejectedValueOnce(error);
    const result = await countDiffFiles(
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
    ...(await countDiffFiles([file("one"), file("two", { oldBlob: null })], read, execute, undefined, 10, () => time)),
  ]).toEqual([
    ["one", null],
    ["two", null],
  ]);
  expect(execute).toHaveBeenCalledTimes(1);
});

test("a jsdiff timeout remains null", async () => {
  const execute = vi.fn<Executor>(async () => ({ kind: "diff-counts", counts: null }));
  expect(await countDiffFiles([file("one"), file("alias")], read, execute)).toEqual(
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
  await expect(countDiffFiles([file("one")], read, execute, controller.signal)).rejects.toBeInstanceOf(PublishAborted);
  await expect(countDiffFiles([file("one")], read, execute, controller.signal, 0)).rejects.toBeInstanceOf(
    PublishAborted,
  );
  for (const error of [new PublishAborted(), new DOMException("Aborted", "AbortError")])
    await expect(
      countDiffFiles([file("one")], read, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
});

test("cached and skipped files still yield and observe cancellation", async () => {
  const controller = new AbortController();
  const probe = vi.fn(() => controller.abort());
  pacing.probe = probe;
  try {
    await expect(
      countDiffFiles(
        Array.from({ length: 200 }, (_, i) => file(`${i}`)),
        read,
        executeWork,
        controller.signal,
        0,
      ),
    ).rejects.toBeInstanceOf(PublishAborted);
    expect(probe).toHaveBeenCalledWith("publish-counts");
  } finally {
    pacing.probe = undefined;
  }
});
