import { parseDiffFromFile } from "@pierre/diffs";
import { expect, test } from "vitest";
import { diffLineCounts } from "../../../../../packages/core/src/diff-counts.ts";
import { diffCounts } from "./presentation.ts";

test.each([
  ["modified", "keep\nold\n", "keep\nnew\nextra\n"],
  ["added", null, "one\ntwo\n"],
  ["deleted", "one\ntwo\n", null],
  ["gains newline", "one", "one\n"],
  ["loses newline", "one\n", "one"],
  ["CRLF", "keep\r\nold\r\n", "keep\r\nnew\r\n"],
  ["CRLF to LF", "one\r\ntwo\r\n", "one\ntwo\n"],
  ["whitespace", "one \n\nend\n", "one\n \nend\n"],
])("core and the browser agree for %s", (_name, old, next) => {
  const parsed = parseDiffFromFile(
    old === null ? null : { name: "synthetic.txt", contents: old },
    next === null ? null : { name: "synthetic.txt", contents: next },
  );
  expect(diffLineCounts(old ?? "", next ?? "")).toEqual(diffCounts(parsed));
});
