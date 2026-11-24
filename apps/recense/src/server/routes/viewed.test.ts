import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { LIMITS, RevisionView } from "@recense/contract";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { files, reviews, revisions, viewedFiles, writeups } from "../../db/schema.ts";
import { createToken } from "../auth/tokens.ts";
import { error, mailboxFixture } from "../mailbox/test-support.ts";

let f: Awaited<ReturnType<typeof mailboxFixture>>;
let oldBlob: string, newBlob: string;
beforeEach(async () => {
  f = await mailboxFixture();
  oldBlob = await f.deps.blobs.put(f.ownerId, Buffer.from("before\n"), "text/plain");
  newBlob = await f.deps.blobs.put(f.ownerId, Buffer.from("after\n"), "text/plain");
  await seed(f.revisionId);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await f.cleanup();
});
async function seed(revisionId: string, ownerId = f.ownerId, change: Partial<typeof files.$inferInsert> = {}) {
  const blob = await f.deps.blobs.put(ownerId, Buffer.from('{"sections":[]}'), "application/json");
  await f.db.query(async (q) => {
    await q.insert(writeups).values({ ownerId, revisionId, sourceBlob: blob, renderedBlob: blob });
    await q.insert(files).values({
      ownerId,
      revisionId,
      path: "src/a.ts",
      role: "diff",
      status: "modified",
      ord: 0,
      mediaType: "text/plain",
      oldBlob,
      newBlob,
      ...change,
    });
  });
}
const mark = (
  viewed = true,
  revision = 1,
  paths = ["src/a.ts"],
  who: "reviewer" | "foreign" | "agent" = "reviewer",
  reviewId = f.reviewId,
) => f.request(`/reviews/${reviewId}/viewed`, "PUT", { revision, paths, viewed }, who);
const view = async (seq = 1, reviewId = f.reviewId, who: "reviewer" | "foreign" = "reviewer") => {
  const response = await f.request(`/reviews/${reviewId}/revisions/${seq}`, "GET", undefined, who);
  expect(response.status).toBe(200);
  return RevisionView.parse(await response.json());
};
const marks = () =>
  f.db.read((q) =>
    q
      .select()
      .from(viewedFiles)
      .where(and(eq(viewedFiles.ownerId, f.ownerId), eq(viewedFiles.reviewId, f.reviewId))),
  );

test("mark, unmark and re-mark are idempotent", async () => {
  expect((await view()).files[0]?.viewed).toBeUndefined();
  expect((await mark(true, 1, ["src/a.ts", "src/a.ts"])).status).toBe(204);
  expect((await view()).files[0]).toMatchObject({ viewed: "viewed", viewedOn: 1 });
  const first = (await marks())[0];
  expect(first).toMatchObject({ revisionSeq: 1, oldBlob, newBlob });
  expect((await mark()).status).toBe(204);
  expect(await marks()).toHaveLength(1);
  expect((await marks())[0]?.id).toBe(first?.id);
  expect((await mark(false)).status).toBe(204);
  expect((await mark(false)).status).toBe(204);
  expect(await marks()).toEqual([]);
  expect((await view()).files[0]).not.toHaveProperty("viewedOn");
  expect((await mark()).status).toBe(204);
  expect((await view()).files[0]?.viewed).toBe("viewed");
});

test("reviewer-only, owner isolation, revision membership and atomic path validation", async () => {
  await error(await mark(true, 1, undefined, "agent"), 403, "forbidden");
  await error(await mark(true, 1, undefined, "foreign"), 404, "unknown_review");
  await error(await mark(true, 1, undefined, "reviewer", randomUUID()), 404, "unknown_review");
  const another = randomUUID();
  await f.db.query(async (q) => {
    await q.insert(reviews).values({
      id: another,
      ownerId: f.ownerId,
      originInstanceId: f.instanceId,
      reviewKey: "another",
      title: "Another",
    });
    await q.insert(revisions).values({ ownerId: f.ownerId, reviewId: another, seq: 2, contentKey: randomUUID() });
    await q.insert(files).values({
      ownerId: f.ownerId,
      revisionId: f.revisionId,
      role: "doc",
      path: "doc.md",
      ord: 1,
      mediaType: "text/markdown",
    });
  });
  await error(await mark(true, 2), 404, "not_found");
  for (const path of ["missing.ts", "doc.md"]) {
    await error(await mark(true, 1, ["src/a.ts", path]), 400, "invalid_request");
    expect(await marks()).toEqual([]);
  }
  expect((await mark()).status).toBe(204);
  await error(await mark(false, 1, undefined, "foreign"), 404, "unknown_review");
  await error(
    await f.request(`/reviews/${f.reviewId}/revisions/1`, "GET", undefined, "foreign"),
    404,
    "unknown_review",
  );
  const foreignReview = randomUUID(),
    foreignRevision = randomUUID();
  await f.db.query(async (q) => {
    await q.insert(reviews).values({
      id: foreignReview,
      ownerId: f.otherOwnerId,
      originInstanceId: f.instanceId,
      reviewKey: "foreign",
      title: "Foreign",
    });
    await q.insert(revisions).values({
      id: foreignRevision,
      ownerId: f.otherOwnerId,
      reviewId: foreignReview,
      seq: 1,
      contentKey: randomUUID(),
    });
  });
  await seed(foreignRevision, f.otherOwnerId, { oldBlob: null, newBlob: null });
  expect((await view(1, foreignReview, "foreign")).files[0]?.viewed).toBeUndefined();
  expect((await mark(true, 1, undefined, "foreign", foreignReview)).status).toBe(204);
  expect((await mark(false)).status).toBe(204);
  expect((await view(1, foreignReview, "foreign")).files[0]?.viewed).toBe("viewed");
});

test("guards reject admin and reviewer bearers, missing Origin and invalid or oversized PUT bodies", async () => {
  for (const kind of ["admin", "reviewer"] as const) {
    const token = await createToken(f.db, f.ownerId, kind);
    const response = await f.app.request(`${f.deps.config.baseUrl}/api/v1/reviews/${f.reviewId}/viewed`, {
      method: "PUT",
      headers: { Host: "127.0.0.1:3636", Authorization: `Bearer ${token.secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ revision: 1, paths: ["src/a.ts"], viewed: true }),
    });
    await error(response, kind === "admin" ? 403 : 401, kind === "admin" ? "forbidden" : "unauthorized");
  }
  await error(
    await f.app.request(`${f.deps.config.baseUrl}/api/v1/reviews/${f.reviewId}/viewed`, {
      method: "PUT",
      headers: { Host: "127.0.0.1:3636", Cookie: "recense_session=synthetic" },
      body: "{}",
    }),
    403,
    "bad_origin",
  );
  for (const body of [
    { revision: 0, paths: ["src/a.ts"], viewed: true },
    { revision: 1, paths: [], viewed: true },
    { revision: 1, paths: ["../a"], viewed: true },
  ]) {
    await error(await f.request(`/reviews/${f.reviewId}/viewed`, "PUT", body), 400, "invalid_request");
  }
  await error(
    await f.request(`/reviews/${f.reviewId}/viewed`, "PUT", { padding: "x".repeat(LIMITS.requestJsonBytes) }),
    413,
    "too_large",
  );
  expect(await marks()).toEqual([]);
});

test("unchanged blobs stay viewed; changed pairs go stale; current paths and nullable sides determine marks", async () => {
  expect((await mark()).status).toBe(204);
  await seed(await f.revision(2));
  expect((await view(2)).files[0]).toMatchObject({ viewed: "viewed", viewedOn: 1 });
  const revision3 = await f.revision(3);
  await seed(revision3, f.ownerId, { oldBlob: null });
  await f.db.query((q) =>
    q.insert(files).values({
      ownerId: f.ownerId,
      revisionId: revision3,
      path: "new.ts",
      oldPath: "src/a.ts",
      role: "diff",
      status: "renamed",
      ord: 1,
      mediaType: "text/plain",
      oldBlob,
      newBlob,
    }),
  );
  expect((await view(3)).files[0]).toMatchObject({ viewed: "stale", viewedOn: 1 });
  expect((await view(3)).files[1]).not.toHaveProperty("viewed");
  expect((await mark(true, 3)).status).toBe(204);
  expect((await view(3)).files[0]).toMatchObject({ viewed: "viewed", viewedOn: 3 });
  expect((await view(1)).files[0]).toMatchObject({ viewed: "stale", viewedOn: 3 });
  expect((await mark(true, 1)).status).toBe(204);
  expect((await view(1)).files[0]).toMatchObject({ viewed: "viewed", viewedOn: 1 });
});

test("topic batches span statement chunks", async () => {
  const rows = Array.from({ length: 501 }, (_, index) => ({
    ownerId: f.ownerId,
    revisionId: f.revisionId,
    path: `batch/${index}.ts`,
    role: "diff" as const,
    status: "mode-changed" as const,
    ord: index + 1,
    mediaType: "text/plain",
    oldBlob,
    newBlob,
  }));
  await f.db.query((q) => q.insert(files).values(rows));
  const paths = rows.map((row) => row.path);
  expect((await mark(true, 1, paths)).status).toBe(204);
  expect(await marks()).toHaveLength(paths.length);
  expect((await view()).files.filter((file) => file.viewed === "viewed")).toHaveLength(paths.length);
  expect((await mark(true, 1, paths)).status).toBe(204);
  expect(await marks()).toHaveLength(paths.length);
  expect((await mark(false, 1, paths)).status).toBe(204);
  expect(await marks()).toEqual([]);
});

test.each(["binary", "oversized"] as const)(
  "%s files are viewed only on their marked revision, even with equal nullable pairs",
  async (flag) => {
    const sides = { oldBlob: flag === "oversized" ? oldBlob : null, newBlob: null };
    await f.db.query((q) =>
      q
        .update(files)
        .set({ flag, ...sides })
        .where(and(eq(files.ownerId, f.ownerId), eq(files.revisionId, f.revisionId))),
    );
    await seed(await f.revision(2), f.ownerId, { flag, ...sides });
    // A flag in either revision is enough; removing the flag must not make an old mark trusted.
    await seed(await f.revision(3), f.ownerId, { flag: null, ...sides });
    expect((await mark()).status).toBe(204);
    expect((await view(1)).files[0]).toMatchObject({ viewed: "viewed", viewedOn: 1 });
    for (const seq of [2, 3]) expect((await view(seq)).files[0]).toMatchObject({ viewed: "stale", viewedOn: 1 });
    expect((await mark(true, 3)).status).toBe(204);
    expect((await view(3)).files[0]).toMatchObject({ viewed: "viewed", viewedOn: 3 });
    for (const seq of [1, 2]) expect((await view(seq)).files[0]).toMatchObject({ viewed: "stale", viewedOn: 3 });
  },
);

test("a deleted text file's absent new side stays viewed across unchanged revisions", async () => {
  await f.db.query((q) =>
    q
      .update(files)
      .set({ status: "deleted", newBlob: null })
      .where(and(eq(files.ownerId, f.ownerId), eq(files.revisionId, f.revisionId))),
  );
  await seed(await f.revision(2), f.ownerId, { status: "deleted", newBlob: null });
  expect((await mark()).status).toBe(204);
  for (const seq of [1, 2]) expect((await view(seq)).files[0]).toMatchObject({ viewed: "viewed", viewedOn: 1 });
});

test("a changed rename source makes equal blob pairs stale", async () => {
  await seed(await f.revision(2), f.ownerId, { status: "renamed", oldPath: "src/z.ts" });
  await seed(await f.revision(3), f.ownerId, { status: "renamed", oldPath: "src/other.ts" });
  expect((await mark()).status).toBe(204);
  expect((await view(1)).files[0]?.viewed).toBe("viewed");
  expect((await view(2)).files[0]?.viewed).toBe("stale");
  expect((await mark(true, 2)).status).toBe(204);
  expect((await view(2)).files[0]?.viewed).toBe("viewed");
  expect((await view(3)).files[0]?.viewed).toBe("stale");
  expect((await view(1)).files[0]?.viewed).toBe("stale");
});

test("the marks plan starts within the review and looks up files by revision and path", async () => {
  expect((await mark()).status).toBe(204);
  const prepare = DatabaseSync.prototype.prepare;
  const plan: string[] = [];
  vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, query: string) {
    const statement = prepare.call(this, query);
    if (query.includes('from "viewed_files"') && query.includes('join "files"')) {
      const all = statement.all.bind(statement);
      vi.spyOn(statement, "all").mockImplementation((...params) => {
        plan.push(
          ...prepare
            .call(this, `EXPLAIN QUERY PLAN ${query}`)
            .all(...params)
            .map((row) => String(row.detail)),
        );
        return all(...params);
      });
    }
    return statement;
  });
  await view();
  expect(plan[0]).toContain("viewed_files_owner_review_path_unique (owner_id=? AND review_id=?)");
  expect(
    plan.some((step) => step.includes("files_owner_revision_path_idx (owner_id=? AND revision_id=? AND path=?)")),
  ).toBe(true);
  expect(plan.join("\n")).not.toContain("files_owner_idx");
  expect(plan.join("\n")).not.toContain("SCAN");
});

test("viewed events reach only the owner's bus after commit, and refused PUTs emit nothing", async () => {
  const events = f.deps.events;
  if (!events) throw new Error("Missing events");
  const committed: Promise<number>[] = [];
  const owner = vi.fn(() => {
    committed.push(marks().then((rows) => rows.length));
  });
  const review = vi.fn(),
    foreign = vi.fn(),
    otherReview = vi.fn();
  const stops = [
    events.subscribe(f.ownerId, null, owner),
    events.subscribe(f.ownerId, f.reviewId, review),
    events.subscribe(f.otherOwnerId, null, foreign),
    events.subscribe(f.ownerId, randomUUID(), otherReview),
  ];
  try {
    expect((await mark()).status).toBe(204);
    expect((await mark(false)).status).toBe(204);
    expect(await Promise.all(committed)).toEqual([1, 0]);
    const event = { type: "viewed", reviewId: f.reviewId };
    expect(owner.mock.calls).toEqual([[event], [event]]);
    expect(review.mock.calls).toEqual([[event], [event]]);
    expect(foreign).not.toHaveBeenCalled();
    expect(otherReview).not.toHaveBeenCalled();
    await error(await mark(true, 1, ["missing.ts"]), 400, "invalid_request");
    await error(await mark(true, 1, undefined, "foreign"), 404, "unknown_review");
    await error(await mark(true, 1, undefined, "agent"), 403, "forbidden");
    expect(owner).toHaveBeenCalledTimes(2);
    expect(foreign).not.toHaveBeenCalled();
  } finally {
    for (const stop of stops) stop();
  }
});
