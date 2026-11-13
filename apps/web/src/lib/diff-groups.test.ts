import type { FileView, RevisionView } from "@emend/contract";
import { expect, test, vi } from "vitest";
import { diffFiles, diffGroups, pathOrder } from "./diff-groups.ts";

const file = (path: string, values: Partial<FileView> = {}): FileView => ({
  id: crypto.randomUUID(),
  path,
  oldPath: null,
  role: "diff",
  status: "modified",
  topic: null,
  order: 0,
  mediaType: "text/plain",
  flag: null,
  hasOld: true,
  hasNew: true,
  ...values,
});

test("path order compares segments, keeps folders together and puts a shared prefix first", () => {
  const paths = ["src/z.ts", "apps/web-x/a.ts", "apps/web/y.ts", "src/a/b.ts", "apps/web/x.ts", "src/a"];
  const files = paths.map((path) => file(path));
  const ordered = pathOrder(files);
  expect(ordered.map((file) => file.path)).toEqual([
    "apps/web/x.ts",
    "apps/web/y.ts",
    "apps/web-x/a.ts",
    "src/a",
    "src/a/b.ts",
    "src/z.ts",
  ]);
  expect(ordered).not.toBe(files);
  expect(files.map((file) => file.path)).toEqual(paths);
});

test("letters sort before case differences, numbers sort naturally and case-only order is deterministic", () => {
  const files = ["src/Z.ts", "src/f10.ts", "src/A.ts", "src/B.ts", "src/f2.ts", "src/a.ts"].map((path) => file(path));
  const expected = ["src/a.ts", "src/A.ts", "src/B.ts", "src/f2.ts", "src/f10.ts", "src/Z.ts"];
  expect(pathOrder(files).map((file) => file.path)).toEqual(expected);
  expect(pathOrder(files.toReversed()).map((file) => file.path)).toEqual(expected);
});

test("collation ties use the full path's code points, then the file order", () => {
  const first = file("f02.ts", { order: 1 });
  const second = file("f02.ts", { order: 2 });
  const last = file("f2.ts", { order: 0 });
  expect(pathOrder([last, second, first])).toEqual([first, second, last]);
  expect(pathOrder([first, last, second])).toEqual([first, second, last]);
});

test("path order splits each path at most once", () => {
  const files = Array.from({ length: 50 }, (_, index) => file(`src/deep/nested/f${50 - index}.ts`));
  const split = vi.spyOn(String.prototype, "split");
  let calls: number;
  try {
    pathOrder(files);
    calls = split.mock.calls.length;
  } finally {
    split.mockRestore();
  }
  expect(calls).toBeLessThanOrEqual(files.length);
});

test("diff files preserve ranked groups in Topics and exclude other roles in A to Z", () => {
  const first = file("z.ts", { topic: "first", order: 2 });
  const second = file("b.ts", { topic: "first", order: 3 });
  const last = file("a.ts", { topic: "last", order: 0 });
  const other = file("c.ts", { topic: "missing", order: 1 });
  const revision: Pick<RevisionView, "topics" | "files"> = {
    topics: [
      { slug: "last", title: "Last", importance: 20, summary: "" },
      { slug: "first", title: "First", importance: 10, summary: "" },
    ],
    files: [other, second, file("doc.md", { role: "doc" }), last, first],
  };
  expect(diffFiles(revision, "topics")).toEqual([...diffGroups(revision).values()].flatMap((group) => group.files));
  expect(diffFiles(revision, "topics")).toEqual([first, second, last, other]);
  expect(diffFiles(revision, "path")).toEqual([last, second, other, first]);
});
