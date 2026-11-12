import { randomUUID } from "node:crypto";
import { ImportBundle, type PublishFile, PublishResponse, RevisionView } from "@emend/contract";
import { and, eq } from "drizzle-orm";
import { expect, onTestFinished, test } from "vitest";
import { files as fileRows } from "../../db/schema.ts";
import { mailboxFixture } from "../mailbox/test-support.ts";
import { WorkTimeout } from "../publish/executor.ts";
import { executeWork } from "../publish/work.ts";
import { bundle, importFixture } from "./import-test-support.ts";

async function fixtureFiles(f: Awaited<ReturnType<typeof mailboxFixture>>): Promise<PublishFile[]> {
  const old = await f.deps.blobs.put(f.ownerId, Buffer.from("keep\nold\n"), "text/plain");
  const next = await f.deps.blobs.put(f.ownerId, Buffer.from("keep\nnew\nextra\n"), "text/plain");
  const file: PublishFile = {
    path: "modified.txt",
    role: "diff",
    status: "modified",
    oldPath: null,
    oldBlob: old,
    newBlob: next,
    flag: null,
  };
  return [
    file,
    { ...file, path: "added.txt", status: "added", oldBlob: null },
    { ...file, path: "deleted.txt", status: "deleted", newBlob: null },
    { ...file, path: "same.txt", newBlob: old },
    { ...file, path: "binary.dat", flag: "binary", oldBlob: null, newBlob: null },
    { ...file, path: "large.txt", flag: "oversized", oldBlob: null, newBlob: null },
    { path: "doc.md", role: "doc", oldPath: null, oldBlob: null, newBlob: next, flag: null },
  ];
}
const expected = [
  { additions: 2, deletions: 1 },
  { additions: 3, deletions: 0 },
  { additions: 0, deletions: 2 },
  { additions: 0, deletions: 0 },
  undefined,
  undefined,
  undefined,
];

test.each([false, true])("published counts are available in the revision (worker timeout: %s)", async (timeout) => {
  const f = await mailboxFixture();
  onTestFinished(() => f.cleanup());
  if (timeout)
    f.deps.publishExecutor = async (work) => {
      if (work.kind === "diff-counts") throw new WorkTimeout();
      return executeWork(work);
    };
  const response = await f.request(
    "/publish",
    "POST",
    {
      reviewKey: "b".repeat(64),
      repo: null,
      branch: null,
      title: "Line counts",
      base: null,
      head: null,
      topics: [],
      writeup: { overview: "Synthetic changes", tldr: "", decisions: null, topics: {} },
      files: await fixtureFiles(f),
    },
    "agent",
  );
  expect(response.status).toBe(200);
  const published = PublishResponse.parse(await response.json());
  const result = await f.request(`/reviews/${published.reviewId}/revisions/1`, "GET");
  expect(result.status).toBe(200);
  const revision = RevisionView.parse(await result.json());
  expect(revision.files.map((file) => file.counts)).toEqual(timeout ? expected.map(() => undefined) : expected);
  if (timeout)
    expect(
      await f.db.read((q) =>
        q
          .select({ additions: fileRows.additions, deletions: fileRows.deletions })
          .from(fileRows)
          .where(eq(fileRows.ownerId, f.ownerId)),
      ),
    ).toEqual(expected.map(() => ({ additions: null, deletions: null })));
  // Old revisions (and incomplete pairs) never invent zero counts.
  await f.db.query((q) =>
    q
      .update(fileRows)
      .set({ additions: null })
      .where(and(eq(fileRows.ownerId, f.ownerId), eq(fileRows.path, "modified.txt"))),
  );
  const legacy = RevisionView.parse(
    await (await f.request(`/reviews/${published.reviewId}/revisions/1`, "GET")).json(),
  );
  expect(legacy.files[0]?.counts).toBeUndefined();
});

test("imports derive counts from blobs for every revision without bundle fields", async () => {
  const f = await importFixture();
  onTestFinished(() => f.cleanup());
  const input = ImportBundle.parse(await bundle(f));
  const files = await fixtureFiles(f);
  input.files = input.revisions.flatMap((revision) =>
    files.map((file, ord) => ({
      id: randomUUID(),
      revisionId: revision.id,
      path: file.path,
      role: file.role,
      status: file.status ?? null,
      topicSlug: null,
      oldPath: null,
      oldBlob: file.oldBlob,
      newBlob: file.newBlob,
      flag: file.flag,
      ord,
      mediaType: file.role === "doc" ? "text/markdown" : "text/plain",
      renderedBlob: null,
      parentDocId: null,
    })),
  );
  const response = await f.importRequest("/import", input);
  expect(response.status).toBe(201);
  for (const row of input.revisions) {
    const result = await f.request(`/reviews/${input.review.id}/revisions/${row.seq}`, "GET");
    expect(result.status).toBe(200);
    const revision = RevisionView.parse(await result.json());
    expect(revision.files.map((file) => file.counts)).toEqual(expected);
  }
});
