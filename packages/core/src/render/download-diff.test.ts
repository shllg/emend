import { OTHER_TOPIC, type TopicMeta } from "@emend/contract";
import { expect, test } from "vitest";
import { isLockfile } from "../lockfiles.ts";
import {
  DOWNLOAD_DIFF_CONTEXT,
  DOWNLOAD_DIFF_LINES,
  type DownloadDiffFile,
  downloadDiffGroups,
  downloadDiffHunks,
} from "./download-diff.ts";

const file = (topic: string | null, order: number): DownloadDiffFile => ({
  path: `${order}.ts`,
  oldPath: null,
  status: "modified",
  flag: null,
  topic,
  order,
  hasOld: true,
  hasNew: true,
  additions: null,
  deletions: null,
});

test("groups by stable topic importance and file order, with unknown topics in Other last", () => {
  const topics: TopicMeta[] = [
    { slug: "later", title: "Later", summary: "", importance: 20 },
    { slug: "first", title: "First", summary: "", importance: 10 },
    { slug: "tied", title: "Tied", summary: "", importance: 10 },
    { slug: "empty", title: "Empty", summary: "", importance: 1 },
    { ...OTHER_TOPIC, title: "Stored title", summary: "", importance: 0 },
  ];
  expect(
    downloadDiffGroups(topics, [
      file("later", 0),
      file("first", 5),
      file(null, 2),
      file("unknown", 1),
      file("first", 3),
      file("tied", 4),
      file("other", 6),
      file("first", 3),
    ]),
  ).toEqual([
    { slug: "first", title: "First", files: [4, 7, 1] },
    { slug: "tied", title: "Tied", files: [5] },
    { slug: "later", title: "Later", files: [0] },
    { ...OTHER_TOPIC, files: [3, 2, 6] },
  ]);
  expect(downloadDiffGroups(topics, [])).toEqual([]);
  expect(downloadDiffGroups([], [file(null, 0)])).toEqual([{ ...OTHER_TOPIC, files: [0] }]);
});

test.each([
  ["modified", "keep\nold\n", "keep\nnew\n", 1, 1, [" keep", "-old", "+new"]],
  ["added", "", "one\ntwo\n", 0, 1, ["+one", "+two"]],
  ["deleted", "one\ntwo\n", "", 1, 0, ["-one", "-two"]],
  ["no newline", "one", "two", 1, 1, ["-one", "\\ No newline at end of file", "+two", "\\ No newline at end of file"]],
  ["CRLF", "keep\r\nold\r\n", "keep\r\nnew\r\n", 1, 1, [" keep\r", "-old\r", "+new\r"]],
] as const)("numbers %s hunks", (_name, old, next, oldStart, newStart, lines) => {
  expect(downloadDiffHunks(old, next, 1000, DOWNLOAD_DIFF_LINES)).toEqual([{ oldStart, newStart, lines }]);
});

test("keeps four context lines on both sides of a change", () => {
  const old = Array.from({ length: 30 }, (_, i) => `line ${i + 1}\n`);
  const next = [...old];
  next[14] = "changed\n";
  expect(DOWNLOAD_DIFF_CONTEXT).toBe(4);
  expect(downloadDiffHunks(old.join(""), next.join(""), 1000, DOWNLOAD_DIFF_LINES)).toEqual([
    {
      oldStart: 11,
      newStart: 11,
      lines: [
        " line 11",
        " line 12",
        " line 13",
        " line 14",
        "-line 15",
        "+changed",
        " line 16",
        " line 17",
        " line 18",
        " line 19",
      ],
    },
  ]);
  expect(downloadDiffHunks("same\n", "same\n", 1000, DOWNLOAD_DIFF_LINES)).toEqual([]);
});

test("returns too-long when the total across hunks exceeds maxLines and accepts an exact fit", () => {
  const old = Array.from({ length: 30 }, (_, i) => `line ${i + 1}\n`).join("");
  const next = old.replace("line 10\n", "changed ten\n").replace("line 25\n", "changed twenty-five\n");
  expect(downloadDiffHunks(old, next, 1000, 19)).toBe("too-long");
  const hunks = downloadDiffHunks(old, next, 1000, 20);
  expect(hunks).toHaveLength(2);
  if (!Array.isArray(hunks)) throw new Error("Expected hunks at the exact line limit");
  expect(hunks.reduce((total, hunk) => total + hunk.lines.length, 0)).toBe(20);
});

test("counts no-newline markers toward maxLines before returning hunks", () => {
  expect(downloadDiffHunks("", "one", 1000, 1)).toBe("too-long");
  expect(downloadDiffHunks("", "one", 1000, 2)).toEqual([
    { oldStart: 0, newStart: 1, lines: ["+one", "\\ No newline at end of file"] },
  ]);
});

test("aborts a large rewrite at a tiny timeout", () => {
  const old = Array.from({ length: 20000 }, (_, i) => `old ${i}\n`).join("");
  const next = Array.from({ length: 20000 }, (_, i) => `new ${i}\n`).join("");
  expect(downloadDiffHunks(old, next, 1, DOWNLOAD_DIFF_LINES)).toBeNull();
});

test("recognizes lock files by their last path segment with the same casing as the app", () => {
  for (const path of ["pnpm-lock.yaml", "nested/Cargo.lock", "nested/package-lock.json"])
    expect(isLockfile(path)).toBe(true);
  for (const path of ["src/lock.ts", "pnpm-lock.yaml.ts", "cargo.lock"]) expect(isLockfile(path)).toBe(false);
});
