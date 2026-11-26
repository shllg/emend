import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { revisionDiff } from "./agent-reviews.ts";

test("the empty diff hashes zero bytes", () => {
  expect(revisionDiff([])).toEqual({
    files: 0,
    digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  });
});

test("side lines sort by UTF-8 bytes even where UTF-16 code units order paths differently", () => {
  const row = { oldPath: null, status: "added" as const, oldBlob: null, newBlob: null, flag: "binary" as const };
  const rows = ["\u{10000}", "\ue000", "a"].map((path) => ({ ...row, path }));
  const text = "a\tnew\tbinary\n\ue000\tnew\tbinary\n\u{10000}\tnew\tbinary\n";
  expect(revisionDiff(rows)).toEqual({ files: 3, digest: createHash("sha256").update(text).digest("hex") });
});
