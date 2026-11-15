import { OTHER_TOPIC, type TopicMeta } from "@emend/contract";
import { structuredPatch } from "diff";
import { expect, test } from "vitest";
import { isLockfile } from "../lockfiles.ts";
import {
  DOWNLOAD_DIFF_CONTEXT,
  DOWNLOAD_DIFF_LINES,
  DOWNLOAD_DIFF_REVEAL_CONTEXT,
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

const hundredLines = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`);
const hundred = `${hundredLines.join("\n")}\n`;
const changedEighty = hundred.replace("line 80\n", "changed eighty\n");

test("without reveals matches normalized context-four jsdiff hunks across synthetic edits", () => {
  const cases: [string, string, string][] = [
    ["modify", "keep\nold\n", "keep\nnew\nextra\n"],
    ["add only", "", "one\ntwo\n"],
    ["delete only", "one\ntwo\n", ""],
    ["gains trailing newline", "one", "one\n"],
    ["loses trailing newline", "one\n", "one"],
    ["long file gains trailing newline", hundred.slice(0, -1), hundred],
    ["long file loses trailing newline", hundred, hundred.slice(0, -1)],
    ["unchanged unterminated tail", hundred.slice(0, -1), changedEighty.slice(0, -1)],
    ["both lack trailing newline", "one", "two"],
    ["CRLF", "keep\r\nold\r\n", "keep\r\nnew\r\n"],
    ["CRLF to LF", "one\r\ntwo\r\n", "one\ntwo\n"],
    ["identical", hundred, hundred],
    ["identical without trailing newline", "same", "same"],
    ["empty", "", ""],
  ];
  for (const gap of [8, 9])
    cases.push([
      `${gap} unchanged lines between changes`,
      hundred,
      hundred.replace("line 10\n", "changed ten\n").replace(`line ${11 + gap}\n`, "changed later\n"),
    ]);
  for (const length of [1, 2, 9, 10, 30])
    for (const ending of ["\n", "\r\n"])
      for (const trailing of [false, true]) {
        const lines = hundredLines.slice(0, length);
        const join = (rows: string[]) => rows.join(ending) + (trailing ? ending : "");
        const old = join(lines);
        const label = `${length} lines, ${JSON.stringify(ending)}, trailing=${trailing}`;
        cases.push([`${label} add all`, "", old], [`${label} delete all`, old, ""]);
        for (const index of new Set([0, Math.floor(length / 2), length - 1])) {
          cases.push(
            [`${label} modify ${index}`, old, join(lines.with(index, "modified"))],
            [`${label} insert ${index}`, old, join(lines.toSpliced(index, 0, "inserted"))],
            [`${label} delete ${index}`, old, join(lines.toSpliced(index, 1))],
          );
        }
        cases.push([`${label} append`, old, join([...lines, "appended"])]);
      }
  for (const [label, old, next] of cases) {
    const patch = structuredPatch("", "", old, next, undefined, undefined, { context: 4, timeout: 1000 });
    if (!patch) throw new Error(`Unexpected abort: ${label}`);
    const expected = patch.hunks.map((hunk) => ({
      oldStart: hunk.oldStart - (hunk.oldLines === 0 ? 1 : 0),
      newStart: hunk.newStart - (hunk.newLines === 0 ? 1 : 0),
      lines: hunk.lines,
    }));
    expect(downloadDiffHunks(old, next, 1000, DOWNLOAD_DIFF_LINES), label).toEqual(expected);
  }
});

test.each(["old", "new"] as const)("reveals an unchanged %s-side line in its own numbered hunk", (side) => {
  expect(DOWNLOAD_DIFF_REVEAL_CONTEXT).toBe(3);
  const normal = downloadDiffHunks(hundred, changedEighty, 1000, DOWNLOAD_DIFF_LINES);
  if (!Array.isArray(normal)) throw new Error("Expected default hunks");
  expect(downloadDiffHunks(hundred, changedEighty, 1000, DOWNLOAD_DIFF_LINES, [{ side, start: 20, end: 20 }])).toEqual([
    { oldStart: 17, newStart: 17, lines: hundredLines.slice(16, 23).map((line) => ` ${line}`) },
    ...normal,
  ]);
});

test.each([
  ["old", 17, 18],
  ["new", 16, 17],
] as const)("uses the %s-side coordinates after an insertion shifts line numbers", (side, oldStart, newStart) => {
  const hunks = downloadDiffHunks(hundred, `inserted\n${changedEighty}`, 1000, DOWNLOAD_DIFF_LINES, [
    { side, start: 20, end: 20 },
  ]);
  if (!Array.isArray(hunks)) throw new Error("Expected revealed hunks");
  expect(hunks).toHaveLength(3);
  expect(hunks[1]).toEqual({
    oldStart,
    newStart,
    lines: hundredLines.slice(oldStart - 1, oldStart + 6).map((line) => ` ${line}`),
  });
});

test("reveals a full line range and merges touching reveals with change context", () => {
  const hunks = downloadDiffHunks(hundred, changedEighty, 1000, DOWNLOAD_DIFF_LINES, [
    { side: "new", start: 20, end: 30 },
    { side: "new", start: 73, end: 73 },
    { side: "old", start: 74, end: 74 },
  ]);
  expect(hunks).toEqual([
    { oldStart: 17, newStart: 17, lines: hundredLines.slice(16, 33).map((line) => ` ${line}`) },
    {
      oldStart: 70,
      newStart: 70,
      lines: [
        ...hundredLines.slice(69, 79).map((line) => ` ${line}`),
        "-line 80",
        "+changed eighty",
        ...hundredLines.slice(80, 84).map((line) => ` ${line}`),
      ],
    },
  ]);
});

test("revealed context and its no-newline marker count toward maxLines", () => {
  const reveal = [{ side: "new" as const, start: 20, end: 20 }];
  const normal = downloadDiffHunks(hundred, changedEighty, 1000, 10);
  if (!Array.isArray(normal)) throw new Error("Expected default hunks");
  expect(normal).toHaveLength(1);
  expect(downloadDiffHunks(hundred, changedEighty, 1000, 16, reveal)).toBe("too-long");
  expect(downloadDiffHunks(hundred, changedEighty, 1000, 17, reveal)).toHaveLength(2);
  const old = hundred.slice(0, -1);
  const next = changedEighty.slice(0, -1);
  expect(downloadDiffHunks(old, next, 1000, 10)).toEqual(normal);
  const tail = [{ side: "old" as const, start: 100, end: 100 }];
  expect(downloadDiffHunks(old, next, 1000, 14, tail)).toBe("too-long");
  const hunks = downloadDiffHunks(old, next, 1000, 15, tail);
  if (!Array.isArray(hunks)) throw new Error("Expected revealed hunks at the exact line limit");
  expect(hunks[1]).toEqual({
    oldStart: 97,
    newStart: 97,
    lines: [...hundredLines.slice(96).map((line) => ` ${line}`), "\\ No newline at end of file"],
  });
  expect(downloadDiffHunks(hundred, changedEighty, 1000, 14, [{ side: "new", start: 1, end: 1 }])).toEqual([
    { oldStart: 1, newStart: 1, lines: hundredLines.slice(0, 4).map((line) => ` ${line}`) },
    ...normal,
  ]);
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
