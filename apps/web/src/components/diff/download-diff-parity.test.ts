import { parseDiffFromFile } from "@pierre/diffs";
import { expect, test } from "vitest";
import { downloadDiffHunks } from "../../../../../packages/core/src/render/download-diff.ts";

const many = Array.from({ length: 50 }, (_, index) => `line ${index + 1}\n`).join("");
test.each([
  ["modified", "keep\nold\n", "keep\nnew\nextra\n"],
  ["added", null, "one\ntwo\n"],
  ["deleted", "one\ntwo\n", null],
  ["gains newline", "one", "one\n"],
  ["loses newline", "one\n", "one"],
  ["CRLF", "keep\r\nold\r\n", "keep\r\nnew\r\n"],
  ["CRLF to LF", "one\r\ntwo\r\n", "one\ntwo\n"],
  ["whitespace", "one \n\nend\n", "one\n \nend\n"],
  ["separate hunks", many, many.replace("line 10\n", "changed ten\n").replace("line 30\n", "changed thirty\n")],
  ["joined context", many, many.replace("line 10\n", "changed ten\n").replace("line 18\n", "changed eighteen\n")],
  ["identical", "same\n", "same\n"],
])("download hunks and the browser agree for %s", (_name, old, next) => {
  const parsed = parseDiffFromFile(
    old === null ? null : { name: "synthetic.txt", contents: old },
    next === null ? null : { name: "synthetic.txt", contents: next },
  );
  const hunks = downloadDiffHunks(old ?? "", next ?? "", 1000);
  expect(hunks).not.toBeNull();
  expect(
    hunks?.map((hunk) => ({
      oldStart: hunk.oldStart,
      newStart: hunk.newStart,
      oldLines: hunk.lines.filter((line) => line.startsWith(" ") || line.startsWith("-")).length,
      newLines: hunk.lines.filter((line) => line.startsWith(" ") || line.startsWith("+")).length,
    })),
  ).toEqual(
    parsed.hunks.map((hunk) => ({
      oldStart: hunk.deletionStart,
      newStart: hunk.additionStart,
      oldLines: hunk.deletionCount,
      newLines: hunk.additionCount,
    })),
  );
});
