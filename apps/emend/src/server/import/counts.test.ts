import { randomUUID } from "node:crypto";
import { ImportBundle } from "@emend/contract";
import { expect, onTestFinished, test, vi } from "vitest";
import { createDiffCountBudget } from "../publish/counts.ts";
import { executeWork } from "../publish/work.ts";
import { importFixture, replayBundle } from "../routes/import-test-support.ts";
import { prepareImport } from "./prepare.ts";

test("import shares one counting budget and reuses blob pairs across revisions", async () => {
  const f = await importFixture();
  onTestFinished(() => f.cleanup());
  const input = await replayBundle(f, 5, 0);
  const template = input.files[0];
  if (!template) throw new Error("Missing file template");
  const hashes = await Promise.all(
    ["first\n", "second\n", "third\n"].map((text) => f.deps.blobs.put(f.ownerId, Buffer.from(text), "text/plain")),
  );
  const pairs = [hashes[0], hashes[0], hashes[1], hashes[2], hashes[0]];
  input.files = input.revisions.map((revision, i) => ({
    ...template,
    id: randomUUID(),
    revisionId: revision.id,
    role: "diff",
    status: "added",
    mediaType: "text/plain",
    path: "source.txt",
    newBlob: pairs[i] ?? null,
  }));
  let time = 0;
  const counted = vi.fn();
  f.deps.publishExecutor = async (work) => {
    if (work.kind === "diff-counts") {
      counted();
      time += 6;
    }
    return executeWork(work);
  };
  const budget = createDiffCountBudget(10);
  const prepared = await prepareImport(f.ownerId, ImportBundle.parse(input), f.deps, undefined, {
    budget,
    now: () => time,
  });
  try {
    expect(counted).toHaveBeenCalledTimes(2);
    expect(budget.spentMs).toBe(12);
    expect(input.revisions.map((revision) => prepared.counted.get(revision.id)?.get("source.txt"))).toEqual([
      { additions: 1, deletions: 0 },
      { additions: 1, deletions: 0 },
      { additions: 1, deletions: 0 },
      null,
      { additions: 1, deletions: 0 },
    ]);
  } finally {
    f.deps.blobs.release(prepared.holds);
  }
});
