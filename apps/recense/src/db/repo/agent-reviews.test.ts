import { createHash } from "node:crypto";
import { expect, test } from "vitest";
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

test("an added file with an old blob shows an old line, a deleted file with a new blob a new line", async () => {
  const added = row({ path: "added", status: "added", oldBlob: oldHash });
  expect((await revisionDiff([added])).digest).toBe(sha(`added\told\t${oldHash}\n`));
  const deleted = row({ path: "deleted", status: "deleted", newBlob: newHash });
  expect((await revisionDiff([deleted])).digest).toBe(sha(`deleted\tnew\t${newHash}\n`));
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

test("an image row uses its image blobs, or oversized for a flagged side", async () => {
  const imageA = "c".repeat(64);
  const imageB = "d".repeat(64);
  const image = (fields: Partial<Row>) => row({ path: "logo.png", flag: "binary", ...fields });
  const first = await revisionDiff([image({ oldImageBlob: imageA, newImageBlob: imageB })]);
  expect(first.digest).toBe(sha(`logo.png\tnew\t${imageB}\nlogo.png\told\t${imageA}\n`));
  const large = await revisionDiff([image({ oldImageBlob: imageA, newImageFlag: "oversized" })]);
  expect(large.digest).toBe(sha(`logo.png\tnew\toversized\nlogo.png\told\t${imageA}\n`));
  const other = await revisionDiff([image({ oldImageBlob: imageA, newImageBlob: imageA })]);
  expect(other.digest).toBe(sha(`logo.png\tnew\t${imageA}\nlogo.png\told\t${imageA}\n`));
  expect(other.digest).not.toBe(first.digest);
});
