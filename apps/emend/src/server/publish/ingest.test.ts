import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LIMITS, type PublishRequest } from "@emend/contract";
import { renderDoc, renderWriteup } from "@emend/core";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { changedBlocks, files, instances, placements, reviews, revisions, threads, writeups } from "../../db/schema.ts";
import { testDb } from "../../db/test-support.ts";
import { BlobStore } from "../../store/blobs.ts";
import { WorkTimeout, workerExecutor } from "./executor.ts";
import { ingest } from "./ingest.ts";
import { type Executor, executeWork } from "./work.ts";

let f: Awaited<ReturnType<typeof testDb>>;
let blobs: BlobStore;
const input = (): PublishRequest => ({
  reviewKey: "a".repeat(64),
  repo: null,
  branch: null,
  title: "Synthetic",
  base: null,
  head: null,
  topics: [],
  files: [],
  writeup: { overview: "Hello", tldr: "Summary", decisions: null, topics: {} },
});
beforeEach(async () => {
  f = await testDb();
  blobs = new BlobStore(f.db, join(f.dir, "state"));
});
afterEach(async () => {
  await f.cleanup();
});
function publish(
  body: PublishRequest,
  instanceId: string = f.instanceId,
  ownerId: string = f.ownerId,
  executor: Executor = executeWork,
) {
  return ingest(ownerId, instanceId, body, { db: f.db, blobs, baseUrl: "http://127.0.0.1:3636", executor });
}
test.each([false, true])("first publish skips changes; revision 2 compares against it (empty=%s)", async (empty) => {
  const executor = vi.fn(executeWork);
  const firstDoc = await blobs.put(f.ownerId, Buffer.from("Original doc"), "text/markdown");
  const nextDoc = await blobs.put(f.ownerId, Buffer.from("Updated doc"), "text/markdown");
  const doc = { path: "plan.md", role: "doc" as const, oldPath: null, oldBlob: null, newBlob: firstDoc, flag: null };
  const first = input();
  if (empty) first.writeup = { overview: "", tldr: "", decisions: "", topics: {} };
  else first.files = [doc];
  await publish(first, f.instanceId, f.ownerId, executor);
  const changes = () => f.db.read((q) => q.select().from(changedBlocks).where(eq(changedBlocks.ownerId, f.ownerId)));
  expect(await changes()).toEqual([]);
  expect(executor.mock.calls.filter(([work]) => work.kind === "changed")).toHaveLength(0);

  const next = { ...input(), files: [{ ...doc, newBlob: nextDoc }] };
  next.writeup.overview = "Updated overview";
  await publish(next, f.instanceId, f.ownerId, executor);
  expect(executor.mock.calls.filter(([work]) => work.kind === "changed")).toHaveLength(1);
  const rendered = await renderWriteup(next.writeup, []);
  const expected = [
    ...rendered.sections.filter((section) => empty || section.key === "overview").flatMap((section) => section.blocks),
    ...(await renderDoc("Updated doc", doc.path)),
  ];
  expect((await changes()).map((row) => row.blockId).sort()).toEqual(expected.map((block) => block.id).sort());
  const second = await f.db.read((q) =>
    q
      .select()
      .from(revisions)
      .where(and(eq(revisions.ownerId, f.ownerId), eq(revisions.seq, 2)))
      .get(),
  );
  expect((await changes()).every((row) => row.revisionId === second?.id)).toBe(true);
});
test("same key appends a revision, reopens and counts placed and unplaced threads", async () => {
  const first = await publish(input());
  const revision = await f.db.query((q) => q.select().from(revisions).where(eq(revisions.ownerId, f.ownerId)).get());
  if (!revision) throw new Error("missing revision");
  await f.db.query(async (q) => {
    await q.insert(threads).values([
      { ownerId: f.ownerId, reviewId: first.reviewId, createdRevisionId: revision.id, target: { kind: "review" } },
      {
        ownerId: f.ownerId,
        reviewId: first.reviewId,
        createdRevisionId: revision.id,
        target: { kind: "file", path: "gone.ts" },
      },
    ]);
    await q
      .update(reviews)
      .set({ state: "approved", approvedRevision: revision.id })
      .where(eq(reviews.ownerId, f.ownerId));
  });
  const second = await publish(input());
  expect(second).toEqual({
    reviewId: first.reviewId,
    revision: 2,
    url: `http://127.0.0.1:3636/r/${first.reviewId}`,
    placed: 1,
    unplaced: 1,
    unrendered: [],
  });
  const rows = await f.db.query((q) => q.select().from(revisions).where(eq(revisions.ownerId, f.ownerId)));
  expect(new Set(rows.map((r) => r.contentKey)).size).toBe(2);
  expect(rows.every((r) => /^[A-Za-z0-9_-]{43}$/.test(r.contentKey))).toBe(true);
  expect(await f.db.query((q) => q.select().from(placements).where(eq(placements.ownerId, f.ownerId)))).toHaveLength(2);
  expect(await f.db.query((q) => q.select().from(reviews).where(eq(reviews.ownerId, f.ownerId)).get())).toMatchObject({
    state: "open",
    approvedRevision: null,
  });
});
test("missing, foreign and other-instance review ids are identical; moved reviews refuse", async () => {
  const first = await publish(input());
  const another = randomUUID();
  await f.db.query((q) => q.insert(instances).values({ id: another, name: "Other" }));
  for (const [id, origin, owner] of [
    [randomUUID(), f.instanceId, f.ownerId],
    [first.reviewId, another, f.ownerId],
    [first.reviewId, f.instanceId, f.otherOwnerId],
  ]) {
    await expect(publish({ ...input(), reviewId: id }, origin, owner)).rejects.toMatchObject({
      code: "unknown_review",
    });
  }
  await f.db.query((q) =>
    q.update(reviews).set({ movedToUrl: "https://example.test/r/moved" }).where(eq(reviews.ownerId, f.ownerId)),
  );
  await expect(publish(input())).rejects.toMatchObject({ code: "review_moved" });
});
test("missing and foreign blobs roll back creation; renders docs and stores source and blocks", async () => {
  const hash = await blobs.put(f.otherOwnerId, Buffer.from("# Title"), "text/markdown");
  const body: PublishRequest = {
    ...input(),
    files: [{ path: "plan.md", oldPath: null, role: "doc", oldBlob: null, newBlob: hash, flag: null }],
  };
  await expect(publish(body)).rejects.toMatchObject({ code: "blob_missing" });
  expect(await f.db.query((q) => q.select().from(reviews).where(eq(reviews.ownerId, f.ownerId)))).toHaveLength(0);
  await blobs.put(f.ownerId, Buffer.from("# Title"), "text/plain");
  await publish(body);
  const doc = await f.db.query((q) => q.select().from(files).where(eq(files.ownerId, f.ownerId)).get());
  expect(doc).toMatchObject({ mediaType: "text/markdown" });
  expect(doc?.renderedBlob).toMatch(/^[a-f0-9]{64}$/);
  expect(await f.db.query((q) => q.select().from(writeups).where(eq(writeups.ownerId, f.ownerId)))).toHaveLength(1);
});
test("concurrent publishes with the same key create only one review", async () => {
  const results = await Promise.all([publish(input()), publish(input())]);
  expect(results.map((r) => r.revision).sort()).toEqual([1, 2]);
  expect(results[0]?.reviewId).toBe(results[1]?.reviewId);
});

test("places renamed lines across an unplaced revision and records only newly changed blocks", async () => {
  const original = await blobs.put(f.ownerId, Buffer.from("one\nneedle\nthree\n"), "text/plain");
  const changed = await blobs.put(f.ownerId, Buffer.from("zero\none\nneedle\nthree\n"), "text/plain");
  const file = (path: string, oldPath: string | null, newBlob: string | null): PublishRequest["files"][number] => ({
    path,
    oldPath,
    role: "diff",
    status: oldPath ? "renamed" : "modified",
    oldBlob: null,
    newBlob,
    flag: newBlob ? null : "oversized",
  });
  const first = await publish({ ...input(), files: [file("a.ts", null, original)] });
  const revision = await f.db.query((q) => q.select().from(revisions).where(eq(revisions.ownerId, f.ownerId)).get());
  if (!revision) throw new Error("missing revision");
  await f.db.query((q) =>
    q.insert(threads).values({
      ownerId: f.ownerId,
      reviewId: first.reviewId,
      createdRevisionId: revision.id,
      target: {
        kind: "lines",
        path: "a.ts",
        side: "new",
        start: 2,
        end: 2,
        lines: ["needle"],
        before: ["one"],
        after: ["three"],
      },
    }),
  );
  const second = await publish({ ...input(), files: [file("b.ts", "a.ts", null)] });
  expect(second).toMatchObject({ unplaced: 1, placed: 0 });
  const third = await publish({ ...input(), files: [file("c.ts", "a.ts", changed)] });
  expect(third).toMatchObject({ placed: 1, unplaced: 0 });
  const rows = await f.db.query((q) => q.select().from(placements).where(eq(placements.ownerId, f.ownerId)));
  expect(rows.find((row) => row.status === "placed")?.location).toEqual({
    kind: "lines",
    path: "c.ts",
    side: "new",
    start: 3,
    end: 3,
  });
  const revs = await f.db.query((q) =>
    q.select().from(revisions).where(eq(revisions.ownerId, f.ownerId)).orderBy(revisions.seq),
  );
  const latest = revs.at(-1);
  if (!latest) throw new Error("missing revision");
  expect(
    await f.db.query((q) =>
      q
        .select()
        .from(changedBlocks)
        .where(and(eq(changedBlocks.ownerId, f.ownerId), eq(changedBlocks.revisionId, latest.id))),
    ),
  ).toEqual([]);
});

test.each([
  ["plan.md", LIMITS.markdownDocBytes],
  ["plan.html", LIMITS.htmlDocBytes],
] as const)("server rejects oversized %s before reading blob bytes", async (path, limit) => {
  const { blobs: metadata } = await import("../../db/schema.ts");
  const hash = "c".repeat(64);
  await f.db.query((q) =>
    q.insert(metadata).values({ ownerId: f.ownerId, sha256: hash, size: limit + 1, mediaType: "text/plain" }),
  );
  const get = vi.spyOn(blobs, "get");
  const doc = { path, role: "doc" as const, oldPath: null, oldBlob: null, newBlob: hash, flag: null };
  await expect(publish({ ...input(), files: [doc] })).rejects.toMatchObject({ code: "too_large" });
  expect(get).not.toHaveBeenCalled();
});

test.each([
  ["asset", 0],
  ["asset", 1],
  ["HTML doc and assets", 0],
  ["HTML doc and assets", 1],
] as const)("server enforces the %s byte limit plus %i before reading blob bytes", async (kind, over) => {
  const { blobs: metadata } = await import("../../db/schema.ts");
  const html = Buffer.from('<img src="a.png"><img src="b.png">');
  const hash = await blobs.put(f.ownerId, html, "text/html");
  const sizes =
    kind === "asset"
      ? [LIMITS.assetBytes + over]
      : [LIMITS.assetBytes, LIMITS.htmlDocWithAssetsBytes - html.length - LIMITS.assetBytes + over];
  // Assets need only metadata; a content read would fail because no files exist.
  const assets = sizes.map((size, i) => ({
    ownerId: f.ownerId,
    sha256: String(i).repeat(64),
    size,
    mediaType: "image/png",
  }));
  await f.db.query((q) => q.insert(metadata).values(assets));
  const paths = sizes.map((_, i) => `${String.fromCharCode(97 + i)}.png`);
  const get = vi.spyOn(blobs, "get");
  const base = { oldPath: null, oldBlob: null, flag: null };
  const publishing = publish({
    ...input(),
    files: [
      { ...base, path: "plan.html", role: "doc", newBlob: hash, assets: paths },
      ...assets.map((asset, i) => ({
        ...base,
        path: paths[i] ?? "",
        role: "asset" as const,
        parent: "plan.html",
        newBlob: asset.sha256,
      })),
    ],
  });
  if (over) {
    await expect(publishing).rejects.toMatchObject({ code: "too_large" });
    expect(get).not.toHaveBeenCalled();
  } else {
    await expect(publishing).resolves.toMatchObject({ revision: 1 });
    expect(get.mock.calls.map(([, sha]) => sha)).toEqual([hash]);
  }
});
test("render failure rolls back a writeup, doc failure degrades, placement timeout refuses", async () => {
  const hash = await blobs.put(f.ownerId, Buffer.from("markdown"), "text/plain");
  const body: PublishRequest = {
    ...input(),
    files: [{ path: "plan.md", role: "doc", oldPath: null, oldBlob: null, newBlob: hash, flag: null }],
  };
  const broken: Executor = async () => {
    throw new Error("synthetic render failure");
  };
  await expect(publish(body, f.instanceId, f.ownerId, broken)).rejects.toMatchObject({ code: "invalid_request" });
  expect(await f.db.query((q) => q.select().from(reviews).where(eq(reviews.ownerId, f.ownerId)))).toHaveLength(0);
  const docBroken: Executor = async (work) => {
    if (work.kind === "doc") throw new WorkTimeout();
    return executeWork(work);
  };
  const first = await publish(body, f.instanceId, f.ownerId, docBroken);
  expect(await f.db.query((q) => q.select().from(files).where(eq(files.ownerId, f.ownerId)).get())).toMatchObject({
    renderedBlob: null,
  });
  const revision = await f.db.query((q) => q.select().from(revisions).where(eq(revisions.ownerId, f.ownerId)).get());
  if (!revision) throw new Error("missing");
  await f.db.query((q) =>
    q.insert(threads).values({
      ownerId: f.ownerId,
      reviewId: first.reviewId,
      createdRevisionId: revision.id,
      target: { kind: "review" },
    }),
  );
  const placeBroken: Executor = async (work) => {
    if (work.kind === "place") throw new WorkTimeout();
    return executeWork(work);
  };
  await expect(publish(body, f.instanceId, f.ownerId, placeBroken)).rejects.toMatchObject({
    code: "too_large",
    message: "The placement timed out.",
  });
  expect(
    await f.db.query((q) =>
      q
        .select()
        .from(revisions)
        .where(and(eq(revisions.ownerId, f.ownerId), eq(revisions.reviewId, first.reviewId))),
    ),
  ).toHaveLength(1);
});

test("a thread created during computation retries with cached rendering and transferred IDs", async () => {
  const worker = workerExecutor();
  try {
    const first = await publish(input());
    const revision = await f.db.query((q) => q.select().from(revisions).where(eq(revisions.ownerId, f.ownerId)).get());
    if (!revision) throw new Error("missing revision");
    let computations = 0;
    let docComputations = 0;
    const hash = await blobs.put(f.ownerId, Buffer.from("# Cached doc"), "text/markdown");
    const executor: Executor = async (work) => {
      if (work.kind === "doc") docComputations++;
      if (work.kind === "writeup" && ++computations === 1)
        await f.db.query((q) =>
          q.insert(threads).values({
            ownerId: f.ownerId,
            reviewId: first.reviewId,
            createdRevisionId: revision.id,
            target: { kind: "review" },
          }),
        );
      return worker(work);
    };
    expect(
      await publish(
        {
          ...input(),
          files: [{ path: "cached.md", role: "doc", oldPath: null, oldBlob: null, newBlob: hash, flag: null }],
        },
        f.instanceId,
        f.ownerId,
        executor,
      ),
    ).toMatchObject({ revision: 2, placed: 1 });
    expect(computations).toBe(1);
    expect(docComputations).toBe(1);
    const rows = await f.db.query((q) => q.select().from(changedBlocks).where(eq(changedBlocks.ownerId, f.ownerId)));
    expect(rows.some((row) => row.blockId.startsWith("doc-"))).toBe(true);
  } finally {
    await worker.close();
  }
});

test("three changing snapshots return publish_conflict without a partial revision", async () => {
  const first = await publish(input());
  const revision = await f.db.query((q) => q.select().from(revisions).where(eq(revisions.ownerId, f.ownerId)).get());
  if (!revision) throw new Error("missing revision");
  await f.db.query((q) =>
    q.insert(threads).values({
      ownerId: f.ownerId,
      reviewId: first.reviewId,
      createdRevisionId: revision.id,
      target: { kind: "review" },
    }),
  );
  let computations = 0;
  const executor: Executor = async (work) => {
    if (work.kind === "place") {
      computations++;
      await f.db.query((q) =>
        q.insert(threads).values({
          ownerId: f.ownerId,
          reviewId: first.reviewId,
          createdRevisionId: revision.id,
          target: { kind: "review" },
        }),
      );
    }
    return executeWork(work);
  };
  await expect(publish(input(), f.instanceId, f.ownerId, executor)).rejects.toMatchObject({ code: "publish_conflict" });
  expect(computations).toBe(3);
  expect(await f.db.query((q) => q.select().from(revisions).where(eq(revisions.ownerId, f.ownerId)))).toHaveLength(1);
});

test("revision byte budget rejects unique metadata before any blob read", async () => {
  const { blobs: metadata } = await import("../../db/schema.ts");
  const hashes = Array.from({ length: 33 }, (_, i) => i.toString(16).padStart(64, "0"));
  await f.db.query((q) =>
    q.insert(metadata).values(
      hashes.map((sha256) => ({
        ownerId: f.ownerId,
        sha256,
        size: LIMITS.htmlDocBytes,
        mediaType: "text/html",
      })),
    ),
  );
  const get = vi.spyOn(blobs, "get");
  await expect(
    publish({
      ...input(),
      files: hashes.map((hash, i) => ({
        path: `${i}.html`,
        role: "doc",
        oldPath: null,
        oldBlob: null,
        newBlob: hash,
        flag: null,
      })),
    }),
  ).rejects.toMatchObject({ code: "too_large" });
  expect(get).not.toHaveBeenCalled();
});

test("duplicate HTML is read once for metadata; binary and asset content stay unread", async () => {
  const html = await blobs.put(f.ownerId, Buffer.alloc(LIMITS.htmlDocBytes, 32), "text/html");
  const asset = await blobs.put(f.ownerId, Buffer.from([0, 1, 2]), "image/png");
  const get = vi.spyOn(blobs, "get");
  await publish(
    {
      ...input(),
      files: [
        ...Array.from({ length: 24 }, (_, i) => ({
          path: `${i}.html`,
          role: "doc" as const,
          oldPath: null,
          oldBlob: null,
          newBlob: html,
          flag: null,
        })),
        { path: "a.png", role: "asset", parent: "0.html", oldPath: null, oldBlob: null, newBlob: asset, flag: null },
        { path: "binary.bin", role: "diff", oldPath: null, oldBlob: null, newBlob: null, flag: "binary" },
      ],
    },
    f.instanceId,
    f.ownerId,
    // The subject is how often the blob is read, not what the metadata of 8 MiB of spaces says.
    async (work) => (work.kind === "doc-metadata" ? { kind: "doc-metadata", headings: [] } : executeWork(work)),
  );
  expect(get.mock.calls.map(([, hash]) => hash)).toEqual([html]);
});

test.each([
  ["b.ts", "a.ts", "c.ts", "a.ts", "new", "renamed"],
  ["a.ts", null, "c.ts", "a.ts", "new", "renamed"],
  ["b.ts", "a.ts", "a.ts", null, "new", "modified"],
  ["a.ts", null, "a.ts", null, "old", "deleted"],
  ["b.ts", "a.ts", null, null, "new", "deleted"],
] as const)(
  "places %s → %s against the next published revision (%s)",
  async (beforePath, beforeOld, afterPath, afterOld, side, status) => {
    const hash = await blobs.put(f.ownerId, Buffer.from("needle\n"), "text/plain");
    const file = (path: string, oldPath: string | null): PublishRequest["files"][number] => ({
      path,
      oldPath,
      role: "diff",
      status: side === "old" ? "deleted" : oldPath ? "renamed" : "modified",
      oldBlob: hash,
      newBlob: side === "old" ? null : hash,
      flag: null,
    });
    const first = await publish({ ...input(), files: [file(beforePath, beforeOld)] });
    const revision = await f.db.query((q) => q.select().from(revisions).where(eq(revisions.ownerId, f.ownerId)).get());
    if (!revision) throw new Error("missing revision");
    await f.db.query((q) =>
      q.insert(threads).values({
        ownerId: f.ownerId,
        reviewId: first.reviewId,
        createdRevisionId: revision.id,
        target: { kind: "lines", path: beforePath, side, start: 1, end: 1, lines: ["needle"], before: [], after: [] },
      }),
    );
    const second = await publish({ ...input(), files: afterPath ? [{ ...file(afterPath, afterOld), status }] : [] });
    const row = await f.db.query((q) => q.select().from(placements).where(eq(placements.ownerId, f.ownerId)).get());
    if (afterPath) {
      expect(second).toMatchObject({ placed: 1, unplaced: 0 });
      expect(row?.location).toMatchObject({ path: afterPath, side, start: 1, end: 1 });
    } else {
      expect(second).toMatchObject({ placed: 0, unplaced: 1 });
      expect(row?.reason).toBe("file-gone");
    }
  },
);

test("diff rows always use text/plain and may share a path with a doc or asset", async () => {
  const hash = await blobs.put(f.ownerId, Buffer.from("# Plan"), "text/plain");
  const base = { oldPath: null, oldBlob: null, newBlob: hash, flag: null };
  await publish({
    ...input(),
    files: [
      { ...base, path: "plan.md", role: "doc" },
      { ...base, path: "plan.md", role: "diff" },
      { ...base, path: "plan.html", role: "doc" },
      { ...base, path: "style.css", role: "asset", parent: "plan.html" },
      { ...base, path: "style.css", role: "diff" },
    ],
  });
  const rows = await f.db.query((q) => q.select().from(files).where(eq(files.ownerId, f.ownerId)));
  expect(rows).toHaveLength(5);
  expect(new Set(rows.map((r) => r.id)).size).toBe(5);
  expect(
    rows.filter((r) => r.role === "diff").every((r) => r.mediaType === "text/plain" && r.renderedBlob === null),
  ).toBe(true);
  expect(rows.find((r) => r.role === "asset")?.parentDocId).toBe(rows.find((r) => r.path === "plan.html")?.id);
});

test("writeup errors and timeouts identify the failed stage; failed docs are reported", async () => {
  await expect(
    publish(input(), f.instanceId, f.ownerId, async () => {
      throw new Error("private details");
    }),
  ).rejects.toMatchObject({ code: "invalid_request", message: "The writeup could not be rendered." });
  await expect(
    publish(input(), f.instanceId, f.ownerId, async () => {
      throw new WorkTimeout();
    }),
  ).rejects.toMatchObject({ code: "too_large", message: "The writeup rendering timed out." });
  const hash = await blobs.put(f.ownerId, Buffer.from("doc"), "text/plain");
  const result = await publish(
    {
      ...input(),
      files: [
        { path: "bad.md", role: "doc", oldPath: null, oldBlob: null, newBlob: hash, flag: null },
        {
          path: "good.md",
          role: "doc",
          oldPath: null,
          oldBlob: null,
          newBlob: await blobs.put(f.ownerId, Buffer.from("good doc"), "text/plain"),
          flag: null,
        },
      ],
    },
    f.instanceId,
    f.ownerId,
    async (work) => {
      if (work.kind === "doc" && work.path === "bad.md") throw new WorkTimeout();
      return executeWork(work);
    },
  );
  expect(result.unrendered).toEqual(["bad.md"]);
});

test("placement reads only targeted sides and deduplicates their shared hashes", async () => {
  const wanted = await blobs.put(f.ownerId, Buffer.from("needle\n"), "text/plain");
  const unused = await blobs.put(f.ownerId, Buffer.from("unused\n"), "text/plain");
  const body: PublishRequest = {
    ...input(),
    files: ["a.ts", "b.ts", "unused.ts"].map((path) => ({
      path,
      role: "diff",
      oldPath: null,
      oldBlob: unused,
      newBlob: path === "unused.ts" ? unused : wanted,
      flag: null,
    })),
  };
  const first = await publish(body);
  const revision = await f.db.query((q) => q.select().from(revisions).where(eq(revisions.ownerId, f.ownerId)).get());
  if (!revision) throw new Error("missing revision");
  await f.db.query((q) =>
    q.insert(threads).values(
      ["a.ts", "b.ts"].map((path) => ({
        ownerId: f.ownerId,
        reviewId: first.reviewId,
        createdRevisionId: revision.id,
        target: {
          kind: "lines" as const,
          path,
          side: "new" as const,
          start: 1,
          end: 1,
          lines: ["needle"],
          before: [],
          after: [],
        },
      })),
    ),
  );
  const get = vi.spyOn(blobs, "get");
  expect(await publish(body)).toMatchObject({ placed: 2, unplaced: 0 });
  expect(get.mock.calls.filter(([, hash]) => hash === wanted)).toHaveLength(1);
  expect(get.mock.calls.filter(([, hash]) => hash === unused)).toHaveLength(0);
});

test("shared HTML placement serializes one source, not one copy per document", async () => {
  const { serialize } = await import("node:v8");
  const source = `<p>needle</p>${" ".repeat(100000)}`;
  const hash = await blobs.put(f.ownerId, Buffer.from(source), "text/html");
  const body: PublishRequest = {
    ...input(),
    files: Array.from({ length: 24 }, (_, i) => ({
      path: `${i}.html`,
      role: "doc",
      oldPath: null,
      oldBlob: null,
      newBlob: hash,
      flag: null,
    })),
  };
  const first = await publish(body);
  const revision = await f.db.query((q) => q.select().from(revisions).where(eq(revisions.ownerId, f.ownerId)).get());
  if (!revision) throw new Error("missing revision");
  await f.db.query((q) =>
    q.insert(threads).values(
      body.files.map(({ path }) => ({
        ownerId: f.ownerId,
        reviewId: first.reviewId,
        createdRevisionId: revision.id,
        target: { kind: "html-span" as const, path, quote: "needle", prefix: "", suffix: "" },
      })),
    ),
  );
  const get = vi.spyOn(blobs, "get");
  const result = await publish(body, f.instanceId, f.ownerId, async (work) => {
    if (work.kind === "place") expect(serialize(work).length).toBeLessThan(Buffer.byteLength(source) + 20000);
    return executeWork(work);
  });
  expect(result.placed).toBe(24);
  // One source read for metadata, one for placement, regardless of the doc count.
  expect(get.mock.calls.filter(([, sha]) => sha === hash)).toHaveLength(2);
});

test.each([false, true])("carried paths survive five unplaced revisions and a rename (legacy=%s)", async (legacy) => {
  const needle = await blobs.put(f.ownerId, Buffer.from("needle\n"), "text/plain");
  const absent = await blobs.put(f.ownerId, Buffer.from("absent\n"), "text/plain");
  const body = (path: string, hash: string): PublishRequest => ({
    ...input(),
    files: [
      { path, oldPath: path === "b.ts" ? "a.ts" : null, role: "diff", oldBlob: needle, newBlob: hash, flag: null },
    ],
  });
  const first = await publish(body("a.ts", needle));
  const revision = await f.db.query((q) => q.select().from(revisions).where(eq(revisions.ownerId, f.ownerId)).get());
  if (!revision) throw new Error("missing revision");
  await f.db.query((q) =>
    q.insert(threads).values(
      Array.from({ length: 2 }, () => ({
        ownerId: f.ownerId,
        reviewId: first.reviewId,
        createdRevisionId: revision.id,
        target: {
          kind: "lines" as const,
          path: "a.ts",
          side: "new" as const,
          start: 1,
          end: 1,
          lines: ["needle"],
          before: [],
          after: [],
        },
      })),
    ),
  );
  for (let round = 1; round <= 6; round++) {
    if (legacy)
      await f.db.query((q) => q.update(placements).set({ carried: null }).where(eq(placements.ownerId, f.ownerId)));
    const result = await publish(
      body(round >= 3 ? "b.ts" : "a.ts", round === 6 ? needle : absent),
      f.instanceId,
      f.ownerId,
      async (work) => {
        if (work.kind === "place") {
          if (!legacy) expect(work.threads.every((t) => t.renames.length === 1)).toBe(true);
          expect(work.threads[0]?.renames.at(-1)).toBe(work.threads[1]?.renames.at(-1));
        }
        return executeWork(work);
      },
    );
    expect(result).toMatchObject(round === 6 ? { placed: 2, unplaced: 0 } : { placed: 0, unplaced: 2 });
  }
  const rows = await f.db.query((q) => q.select().from(placements).where(eq(placements.ownerId, f.ownerId)));
  expect(rows.filter((row) => row.status === "placed").map((row) => row.location)).toEqual(
    Array.from({ length: 2 }, () => ({ kind: "lines", path: "b.ts", side: "new", start: 1, end: 1 })),
  );
});

test("after five revisions a carried placement snapshot reads file rows from exactly two revisions", async () => {
  const needle = await blobs.put(f.ownerId, Buffer.from("needle\n"), "text/plain");
  const absent = await blobs.put(f.ownerId, Buffer.from("absent\n"), "text/plain");
  const body = (hash: string): PublishRequest => ({
    ...input(),
    files: [{ path: "a.ts", oldPath: null, role: "diff", oldBlob: needle, newBlob: hash, flag: null }],
  });
  const first = await publish(body(needle));
  const anchor = await f.db.query((q) => q.select().from(revisions).where(eq(revisions.ownerId, f.ownerId)).get());
  if (!anchor) throw new Error("missing revision");
  await f.db.query((q) =>
    q.insert(threads).values({
      ownerId: f.ownerId,
      reviewId: first.reviewId,
      createdRevisionId: anchor.id,
      target: { kind: "lines", path: "a.ts", side: "new", start: 1, end: 1, lines: ["needle"], before: [], after: [] },
    }),
  );
  for (let i = 1; i < 5; i++) expect(await publish(body(absent))).toMatchObject({ placed: 0, unplaced: 1 });
  const history = await f.db.query((q) =>
    q.select().from(revisions).where(eq(revisions.ownerId, f.ownerId)).orderBy(revisions.seq),
  );
  const ids = new Set(history.map((r) => r.id));
  const loaded: string[] = [];
  const prepare = DatabaseSync.prototype.prepare;
  const spy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ) {
    const statement = prepare.call(this, sql);
    if (/^select\b/i.test(sql) && / from "files" /.test(sql)) {
      const record = (params: unknown[]) => {
        for (const value of params) if (typeof value === "string" && ids.has(value)) loaded.push(value);
      };
      const all = statement.all.bind(statement);
      const get = statement.get.bind(statement);
      vi.spyOn(statement, "all").mockImplementation((...params) => {
        record(params);
        return all(...params);
      });
      vi.spyOn(statement, "get").mockImplementation((...params) => {
        record(params);
        return get(...params);
      });
    }
    return statement;
  });
  try {
    expect(await publish(body(needle))).toMatchObject({ revision: 6, placed: 1, unplaced: 0 });
    expect(loaded).toHaveLength(2);
    expect(new Set(loaded)).toEqual(new Set([anchor.id, history.at(-1)?.id]));
  } finally {
    spy.mockRestore();
  }
});
