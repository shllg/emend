import { createHash } from "node:crypto";
import { expect, onTestFinished, test } from "vitest";
import { expectPaced, observePacingTurns, unitsOf } from "../../server/pacing-test-support.ts";
import { revisionDiff } from "./agent-reviews.ts";

type Row = Parameters<typeof revisionDiff>[0][number];

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const oldHash = "a".repeat(64);
const newHash = "b".repeat(64);
const row = (fields: Partial<Row> & Pick<Row, "path">): Row => ({
  oldPath: null,
  status: "modified",
  oldBlob: null,
  newBlob: null,
  flag: null,
  oldImageBlob: null,
  newImageBlob: null,
  oldImageFlag: null,
  newImageFlag: null,
  ...fields,
});

test("the empty diff hashes zero bytes", async () => {
  expect(await revisionDiff([])).toEqual({
    files: 0,
    digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  });
});

test("side lines sort by UTF-8 bytes even where UTF-16 code units order paths differently", async () => {
  const rows = ["\u{10000}", "", "a"].map((path) => row({ path, status: "added", flag: "binary" as const }));
  const text = "a\tnew\tbinary\n\tnew\tbinary\n\u{10000}\tnew\tbinary\n";
  expect(await revisionDiff(rows)).toEqual({ files: 3, digest: sha(text) });
});

test("a text or image blob on an excluded side contributes unexpected", async () => {
  const added = row({ path: "added", status: "added", oldBlob: oldHash });
  expect(await revisionDiff([added])).toEqual({ files: 1, digest: sha("added\told\tunexpected\n") });
  const deleted = row({ path: "deleted", status: "deleted", newBlob: newHash });
  expect(await revisionDiff([deleted])).toEqual({ files: 1, digest: sha("deleted\tnew\tunexpected\n") });
  const excludedImage = row({ path: "deleted.png", status: "deleted", newImageBlob: newHash });
  expect(await revisionDiff([excludedImage])).toEqual({ files: 1, digest: sha("deleted.png\tnew\tunexpected\n") });
});

test("a modified file with only a new blob and no flag shows only the new line", async () => {
  const modified = row({ path: "edit", status: "modified", newBlob: newHash });
  expect(await revisionDiff([modified])).toEqual({ files: 1, digest: sha(`edit\tnew\t${newHash}\n`) });
});

test("a flagged row without blobs shows flag lines by status", async () => {
  const flagged = (path: string, status: Row["status"]) => row({ path, status, flag: "oversized" });
  const text =
    "added\tnew\toversized\n" + "deleted\told\toversized\n" + "edit\tnew\toversized\n" + "edit\told\toversized\n";
  const rows = [flagged("edit", "modified"), flagged("deleted", "deleted"), flagged("added", "added")];
  expect(await revisionDiff(rows)).toEqual({ files: 3, digest: sha(text) });
});

test("a binary raster uses the image blobs, or oversized for an oversized image side", async () => {
  const image = row({ path: "logo.png", flag: "binary", oldImageBlob: oldHash, newImageBlob: newHash });
  expect(await revisionDiff([image])).toEqual({
    files: 1,
    digest: sha(`logo.png\tnew\t${newHash}\nlogo.png\told\t${oldHash}\n`),
  });
  const oversized = { ...image, newBlob: newHash, newImageBlob: null, newImageFlag: "oversized" as const };
  expect(await revisionDiff([oversized])).toEqual({
    files: 1,
    digest: sha(`logo.png\tnew\toversized\nlogo.png\told\t${oldHash}\n`),
  });
});

test("an added raster with stray old text marks only the old side unexpected", async () => {
  const added = row({ path: "logo.png", status: "added", flag: "binary", oldBlob: oldHash, newImageBlob: newHash });
  expect(await revisionDiff([added])).toEqual({
    files: 1,
    digest: sha(`logo.png\tnew\t${newHash}\nlogo.png\told\tunexpected\n`),
  });
});

test.each([
  ["oversized", "old.SVG\told\toversized\n"],
  ["binary", "old.SVG\told\tbinary\n"],
  [null, "old.SVG\told\tunexpected\n"],
] as const)("an SVG picture without source uses its file flag or unexpected (%s)", async (flag, oldLine) => {
  const renamed = row({
    path: "logo.png",
    oldPath: "old.SVG",
    status: "renamed",
    flag,
    oldImageBlob: oldHash,
    newImageBlob: newHash,
  });
  const expected = `logo.png\tnew\t${newHash}\n${oldLine}`;
  expect(await revisionDiff([renamed])).toEqual({ files: 1, digest: sha(expected) });
});

test("an SVG with matching source and image uses their hash", async () => {
  const svg = row({ path: "logo.svg", status: "added", newBlob: newHash, newImageBlob: newHash });
  expect(await revisionDiff([svg])).toEqual({ files: 1, digest: sha(`logo.svg\tnew\t${newHash}\n`) });
});

test("a raster with conflicting text and image blobs contributes unexpected", async () => {
  const raster = row({ path: "logo.png", status: "added", newBlob: oldHash, newImageBlob: newHash });
  expect(await revisionDiff([raster])).toEqual({ files: 1, digest: sha("logo.png\tnew\tunexpected\n") });
});

test("the digest processes at most 500 diff rows between yields", async () => {
  const log = observePacingTurns();
  onTestFinished(log.restore);
  const rows = Array.from({ length: 1200 }, (_, i) => ({
    ...row({ path: `file-${i}`, status: "added" }),
    get newBlob() {
      log.record("diff-row");
      return newHash;
    },
  }));
  expect((await revisionDiff(rows))?.files).toBe(rows.length);
  expect(expectPaced(log.events, "agent-review-diff", unitsOf("diff-row"), 500)).toBe(rows.length);
});
