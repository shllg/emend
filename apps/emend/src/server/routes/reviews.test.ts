import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as contract from "@emend/contract";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  changedBlocks,
  deliveries,
  files,
  placements,
  repos,
  reviews,
  revisions,
  sends,
  writeups,
} from "../../db/schema.ts";
import { APP_CSP } from "../http/headers.ts";
import { publishReview } from "../mailbox/lifecycle-support.ts";
import { error, mailboxFixture } from "../mailbox/test-support.ts";

let f: Awaited<ReturnType<typeof mailboxFixture>>;
beforeEach(async () => {
  f = await mailboxFixture();
  await seedWriteup(f.revisionId);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await f.cleanup();
});
async function seedWriteup(revisionId: string) {
  const blob = await f.deps.blobs.put(f.ownerId, Buffer.from(JSON.stringify({ sections: [] })), "application/json");
  await f.db.query((q) =>
    q.insert(writeups).values({ ownerId: f.ownerId, revisionId, sourceBlob: blob, renderedBlob: blob }),
  );
}
const get = (suffix = "", who: "reviewer" | "foreign" | "agent" = "reviewer") =>
  f.request(`/reviews${suffix}`, "GET", undefined, who);

test.each([
  { kind: "review", name: "Code project", stored: undefined, project: "Code project" },
  { kind: "publish", name: "Doc project", stored: undefined, project: "Doc project" },
  { kind: "publish", name: null, stored: undefined, project: null },
  { kind: "review", name: "Original", stored: "Newest", project: "Newest" },
  { kind: "review", name: "Legacy project", stored: null, project: "Legacy project" },
  { kind: "review", name: ".git", stored: null, project: null },
  { kind: "review", name: ".git", stored: undefined, project: ".git" },
  { kind: "publish", name: null, stored: "Named project", project: "Named project" },
])(
  "inbox and review project $project use column $stored before repo $name",
  async ({ kind, name, stored, project }) => {
    const repo = name === null ? null : { key: "b".repeat(64), name };
    const published = await publishReview(f, {
      repo,
      diff: kind === "review",
      docs: { "plan.md": "# Synthetic plan" },
      writeup: { overview: "", tldr: "", decisions: null, topics: {} },
    });
    if (stored !== undefined)
      await f.db.query((q) =>
        q
          .update(reviews)
          .set({ project: stored })
          .where(and(eq(reviews.ownerId, f.ownerId), eq(reviews.id, published.reviewId))),
      );
    const list = contract.InboxList.parse(await (await get()).json());
    expect(list.items.find((item) => item.id === published.reviewId)).toMatchObject({
      repo: repo?.key ?? null,
      project,
      kind,
    });
    expect(await (await get(`/${published.reviewId}`)).json()).toMatchObject({
      repo: repo?.key ?? null,
      project,
      kind,
    });
  },
);

test("all three GETs parse their schemas and enforce reviewer scope and owner isolation", async () => {
  const approved = await f.request(`/reviews/${f.reviewId}/sends`, "POST", { kind: "approve", revision: 1 });
  expect(approved.status).toBe(201);
  const own = contract.InboxList.parse(await (await get()).json());
  expect(own.items).toMatchObject([{ id: f.reviewId, state: "approved", list: "active" }]);
  for (const [path, schema] of [
    ["", contract.InboxList],
    [`/${f.reviewId}`, contract.ReviewView],
    [`/${f.reviewId}/revisions/1`, contract.RevisionView],
  ] as const) {
    const response = await get(path);
    expect(response.status).toBe(200);
    expect(schema.safeParse(await response.json()).success).toBe(true);
    await error(await get(path, "agent"), 403, "forbidden");
    if (path) await error(await get(path, "foreign"), 404, "unknown_review");
    else
      expect(await (await get(path, "foreign")).json()).toEqual({
        approvedActiveHours: 12,
        items: [],
        serverTime: new Date(f.deps.now()).toISOString(),
      });
  }
  await error(await get(`/${randomUUID()}`), 404, "unknown_review");
  await error(await get(`/${randomUUID()}/revisions/1`), 404, "unknown_review");
  for (const seq of ["2", "0", "bad", "1.5"])
    await error(await get(`/${f.reviewId}/revisions/${seq}`), 404, "not_found");
});
test("inbox sorts newest first and caps the result at 200", async () => {
  let selects = 0;
  const read = f.db.read.bind(f.db);
  vi.spyOn(f.db, "read").mockImplementation((fn) =>
    read((q) =>
      fn(
        new Proxy(q, {
          get(target, property, receiver) {
            if (property === "select")
              return (...args: Parameters<typeof q.select>) => {
                selects++;
                return q.select(...args);
              };
            return Reflect.get(target, property, receiver);
          },
        }),
      ),
    ),
  );
  expect((await get()).status).toBe(200);
  const singleReviewSelects = selects;
  await f.db.query(async (q) => {
    await q
      .update(reviews)
      .set({ updatedAt: 1 })
      .where(and(eq(reviews.ownerId, f.ownerId), eq(reviews.id, f.reviewId)));
    for (let i = 0; i < 202; i++) {
      const reviewId = randomUUID();
      await q.insert(reviews).values({
        id: reviewId,
        ownerId: f.ownerId,
        originInstanceId: f.instanceId,
        reviewKey: `synthetic-${i}`,
        title: `Review ${i}`,
        updatedAt: 1000 + i,
      });
      await q.insert(revisions).values({ ownerId: f.ownerId, reviewId, seq: 1, contentKey: randomUUID() });
    }
  });
  selects = 0;
  const response = await get();
  expect(response.status).toBe(200);
  expect(selects).toBe(singleReviewSelects);
  const list = contract.InboxList.parse(await response.json());
  expect(list.items).toHaveLength(contract.LIMITS.inboxItems);
  expect(list.items[0]?.title).toBe("Review 201");
  expect(list.items.at(-1)?.title).toBe("Review 2");
});
test("inbox counts drafts, unresolved threads, pending delivery and waiting state separately", async () => {
  const thread = await f.thread();
  await f.send();
  await f.comment(thread.threadId, "Another draft");
  expect(
    (
      await f.request(
        `/comments/${thread.commentId}/reply`,
        "POST",
        { outcome: "explained", body: "An answer" },
        "agent",
      )
    ).status,
  ).toBe(201);
  let response = await get(`/${f.reviewId}`);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    unsentCount: 1,
    openThreads: 1,
    pendingSend: true,
    agentWaiting: false,
  });
  const delivery = await f.take();
  expect(delivery.kind).toBe("go");
  if (delivery.kind !== "go") throw new Error("Expected a Go delivery to confirm");
  expect(await (await get(`/${f.reviewId}`)).json()).toMatchObject({ pendingSend: true });
  expect((await f.request(`/deliveries/${delivery.deliveryId}/confirm`, "POST", undefined, "agent")).status).toBe(204);
  await f.request(`/threads/${thread.threadId}/resolve`);
  const stop = f.deps.events?.beginWaiting(f.ownerId, f.reviewId, 1);
  response = await get(`/${f.reviewId}`);
  expect(await response.json()).toMatchObject({
    unsentCount: 1,
    openThreads: 0,
    pendingSend: false,
    agentWaiting: true,
  });
  stop?.();
});
test("revision includes insertion-ordered comments, placements, docs and changes after the last Send", async () => {
  const thread = await f.thread("First");
  await f.send();
  f.advance(-1000);
  const draft = await f.comment(thread.threadId, "Second");
  await f.request(`/comments/${thread.commentId}/reply`, "POST", { outcome: "fixed", body: "Third" }, "agent");
  const revision2 = await f.revision(2);
  await seedWriteup(revision2);
  const doc = await f.deps.blobs.put(f.ownerId, Buffer.from("[]"), "application/json");
  const repoId = randomUUID();
  await f.db.query(async (q) => {
    await q.insert(repos).values({ id: repoId, ownerId: f.ownerId, key: "c".repeat(64), name: "widget" });
    await q
      .update(reviews)
      .set({ repoId })
      .where(and(eq(reviews.ownerId, f.ownerId), eq(reviews.id, f.reviewId)));
    await q.insert(changedBlocks).values([
      { ownerId: f.ownerId, revisionId: f.revisionId, blockId: "overview-11111111" },
      { ownerId: f.ownerId, revisionId: revision2, blockId: "overview-22222222" },
    ]);
    await q.insert(files).values([
      {
        ownerId: f.ownerId,
        revisionId: revision2,
        path: "plan.md",
        role: "doc",
        ord: 0,
        mediaType: "text/markdown",
        renderedBlob: doc,
      },
      {
        ownerId: f.ownerId,
        revisionId: revision2,
        path: "docs/a #é.html",
        role: "doc",
        ord: 1,
        mediaType: "text/html",
      },
      { ownerId: f.ownerId, revisionId: revision2, path: "image.png", role: "asset", ord: 2, mediaType: "image/png" },
    ]);
  });
  const response = await get(`/${f.reviewId}/revisions/2`);
  expect(response.status).toBe(200);
  const view = contract.RevisionView.parse(await response.json());
  expect(view.changedBlocks).toEqual([{ blockId: "overview-22222222", revision: 2 }]);
  expect(view.files.map((file) => file.path)).toEqual(["plan.md", "docs/a #é.html"]);
  expect(view.docs[0]).toEqual({ path: "plan.md", kind: "markdown", blocks: [] });
  const html = view.docs[1];
  expect(html?.kind).toBe("html");
  if (html?.kind === "html") expect(html.contentUrl).toMatch(/^\/content\/[^/]+\/docs\/a%20%23%C3%A9\.html$/);
  expect(view.threads[0]).toMatchObject({ createdOn: 1, placement: { status: "unplaced", reason: "not-placed" } });
  expect(view.threads[0]?.comments.map((comment) => [comment.body, comment.sent, comment.sentOn])).toEqual([
    ["First", true, 1],
    ["Second", false, null],
    ["Third", false, null],
  ]);
  expect(view.threads[0]?.comments[2]).toMatchObject({ author: "agent", outcome: "fixed" });
  const old = contract.RevisionView.parse(await (await get(`/${f.reviewId}/revisions/1`)).json());
  expect(old.threads[0]?.placement).toEqual({ status: "placed", location: { kind: "review" } });
  expect(old.changedBlocks).toEqual([]);
  expect(old.threads[0]?.comments[1]?.id).toBe(draft.commentId);
  const review = contract.ReviewView.parse(await (await get(`/${f.reviewId}`)).json());
  expect(review.repo).toBe("c".repeat(64));
  expect(review.revisions.map((r) => r.seq)).toEqual([1, 2]);
  await f.db.query((q) =>
    q
      .update(sends)
      .set({ setAsideAt: f.deps.now() })
      .where(and(eq(sends.ownerId, f.ownerId), eq(sends.reviewId, f.reviewId))),
  );
  expect(await (await get(`/${f.reviewId}`)).json()).toMatchObject({ pendingSend: false });
});

test("changed blocks use the newest change after the last Send through the requested revision", async () => {
  await f.db.query((q) =>
    q.insert(changedBlocks).values({ ownerId: f.ownerId, revisionId: f.revisionId, blockId: "overview-11111111" }),
  );
  const beforeSend = contract.RevisionView.parse(await (await get(`/${f.reviewId}/revisions/1`)).json());
  expect(beforeSend.changedBlocks).toEqual([]);
  expect(
    await f.db.read((q) => q.select().from(changedBlocks).where(eq(changedBlocks.ownerId, f.ownerId))),
  ).toHaveLength(1);
  f.advance(-1000);
  const revision2 = await f.revision(2);
  const revision3 = await f.revision(3);
  const revision4 = await f.revision(4);
  await seedWriteup(revision2);
  await seedWriteup(revision3);
  await f.db.query(async (q) => {
    await q.insert(changedBlocks).values([
      { ownerId: f.ownerId, revisionId: revision3, blockId: "overview-33333333" },
      { ownerId: f.ownerId, revisionId: revision2, blockId: "overview-22222222" },
      { ownerId: f.ownerId, revisionId: revision3, blockId: "overview-22222222" },
      { ownerId: f.ownerId, revisionId: revision2, blockId: "overview-44444444" },
      { ownerId: f.ownerId, revisionId: revision4, blockId: "overview-22222222" },
      { ownerId: f.ownerId, revisionId: revision4, blockId: "overview-55555555" },
    ]);
    for (const ownerId of [f.ownerId, f.otherOwnerId]) {
      const reviewId = randomUUID();
      const revisionId = randomUUID();
      await q.insert(reviews).values({
        id: reviewId,
        ownerId,
        originInstanceId: f.instanceId,
        reviewKey: randomUUID(),
        title: "Unrelated synthetic review",
      });
      await q.insert(revisions).values({ id: revisionId, ownerId, reviewId, seq: 3, contentKey: randomUUID() });
      await q.insert(changedBlocks).values([
        { ownerId, revisionId, blockId: "overview-22222222" },
        { ownerId, revisionId, blockId: "overview-66666666" },
      ]);
      await q.insert(sends).values({ ownerId, reviewId, revisionId, kind: "approve" });
    }
  });
  for (const [seq, expected] of [
    [1, []],
    [
      2,
      [
        { blockId: "overview-22222222", revision: 2 },
        { blockId: "overview-44444444", revision: 2 },
      ],
    ],
    [
      3,
      [
        { blockId: "overview-22222222", revision: 3 },
        { blockId: "overview-33333333", revision: 3 },
        { blockId: "overview-44444444", revision: 2 },
      ],
    ],
  ] as const) {
    const response = await get(`/${f.reviewId}/revisions/${seq}`);
    expect(response.status).toBe(200);
    expect(contract.RevisionView.parse(await response.json()).changedBlocks).toEqual(expected);
  }
});

test("a Send on revision 2 clears its changes and revision 3 returns only subsequent changes", async () => {
  const revision2 = await f.revision(2);
  await seedWriteup(revision2);
  await f.db.query((q) =>
    q.insert(changedBlocks).values([
      { ownerId: f.ownerId, revisionId: f.revisionId, blockId: "overview-11111111" },
      { ownerId: f.ownerId, revisionId: revision2, blockId: "overview-22222222" },
    ]),
  );
  expect(contract.RevisionView.parse(await (await get(`/${f.reviewId}/revisions/2`)).json()).changedBlocks).toEqual([
    { blockId: "overview-22222222", revision: 2 },
  ]);
  await f.thread("Update the explanation", { kind: "review" }, 2);
  await f.send({ revision: 2, kind: "go" });
  expect(contract.RevisionView.parse(await (await get(`/${f.reviewId}/revisions/2`)).json()).changedBlocks).toEqual([]);
  const revision3 = await f.revision(3);
  await seedWriteup(revision3);
  await f.db.query((q) =>
    q.insert(changedBlocks).values({ ownerId: f.ownerId, revisionId: revision3, blockId: "overview-33333333" }),
  );
  expect(contract.RevisionView.parse(await (await get(`/${f.reviewId}/revisions/3`)).json()).changedBlocks).toEqual([
    { blockId: "overview-33333333", revision: 3 },
  ]);
});

test("sentOn follows each comment's Send revision despite clock changes and older revision reads", async () => {
  const thread = await f.thread("First");
  const revision2 = await f.revision(2);
  await seedWriteup(revision2);
  await f.send({ revision: 2, kind: "go" });
  f.advance(-1000);
  await f.comment(thread.threadId, "Second");
  const revision3 = await f.revision(3);
  await seedWriteup(revision3);
  await f.send({ revision: 3, kind: "go" });
  f.advance(-1000);
  await f.comment(thread.threadId, "Third");
  expect(
    (await f.request(`/comments/${thread.commentId}/reply`, "POST", { outcome: "fixed", body: "Fourth" }, "agent"))
      .status,
  ).toBe(201);
  await f.db.query((q) =>
    q.insert(changedBlocks).values([
      { ownerId: f.ownerId, revisionId: revision2, blockId: "overview-11111111" },
      { ownerId: f.ownerId, revisionId: revision3, blockId: "overview-22222222" },
    ]),
  );
  for (const seq of [2, 3]) {
    const response = await get(`/${f.reviewId}/revisions/${seq}`);
    expect(response.status).toBe(200);
    const view = contract.RevisionView.parse(await response.json());
    expect(view.changedBlocks).toEqual([]);
    expect(view.threads[0]?.createdOn).toBe(1);
    expect(view.threads[0]?.comments.map(({ body, author, sent, sentOn }) => ({ body, author, sent, sentOn }))).toEqual(
      [
        { body: "First", author: "user", sent: true, sentOn: 2 },
        { body: "Second", author: "user", sent: true, sentOn: 3 },
        { body: "Third", author: "user", sent: false, sentOn: null },
        { body: "Fourth", author: "agent", sent: false, sentOn: null },
      ],
    );
  }
});
test("SPA fallback keeps app headers and no-cache; assets alone are immutable", async () => {
  await mkdir(join(f.dir, "assets"));
  await writeFile(join(f.dir, "index.html"), "<!doctype html><title>emend</title>");
  await writeFile(join(f.dir, "assets", "app-hash.js"), "export {};");
  const page = (path: string) => f.app.request(`http://127.0.0.1:3636${path}`, { headers: { Host: "127.0.0.1:3636" } });
  for (const path of ["/r/x", "/pair", "/devices", "/index.html", "/"]) {
    const response = await page(path);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<title>emend</title>");
    expect(response.headers.get("Content-Security-Policy")).toBe(APP_CSP);
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
  }
  expect((await page("/assets/app-hash.js")).headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  expect((await page("/assets/missing")).status).toBe(404);
});

test.each(["/api", "/api/", "/api/v2/reviews", "/content", "/api%2Fv1%2Freviews", "/content%2FKEY%2Fdocs"])(
  "SPA never serves index.html for decoded reserved path %s",
  async (path) => {
    await writeFile(join(f.dir, "index.html"), "<!doctype html><title>emend</title>");
    const response = await f.app.request(`http://127.0.0.1:3636${path}`, { headers: { Host: "127.0.0.1:3636" } });
    await error(response, 404, "not_found");
  },
);

test("revision reads preserve renamed sides and the placement stored for each revision", async () => {
  const oldBlob = await f.deps.blobs.put(f.ownerId, Buffer.from("const before = 1;"), "text/plain");
  const newBlob = await f.deps.blobs.put(f.ownerId, Buffer.from("const after = 2;"), "text/plain");
  await f.db.query((q) =>
    q.insert(files).values({
      ownerId: f.ownerId,
      revisionId: f.revisionId,
      path: "a.ts",
      role: "diff",
      status: "added",
      ord: 0,
      mediaType: "text/plain",
      newBlob: oldBlob,
    }),
  );
  const thread = await f.thread("Explain the rename.", { kind: "file", path: "a.ts" });
  const revision2 = await f.revision(2);
  const revision3 = await f.revision(3);
  await seedWriteup(revision2);
  await seedWriteup(revision3);
  await f.db.query(async (q) => {
    await q.insert(files).values({
      ownerId: f.ownerId,
      revisionId: revision2,
      path: "b.ts",
      oldPath: "a.ts",
      role: "diff",
      status: "renamed",
      ord: 0,
      mediaType: "text/plain",
      oldBlob,
      newBlob,
    });
    await q.insert(placements).values([
      {
        ownerId: f.ownerId,
        reviewId: f.reviewId,
        revisionId: revision2,
        threadId: thread.threadId,
        status: "placed",
        location: { kind: "file", path: "b.ts" },
      },
      {
        ownerId: f.ownerId,
        reviewId: f.reviewId,
        revisionId: revision3,
        threadId: thread.threadId,
        status: "unplaced",
        reason: "file-gone",
      },
    ]);
  });
  const views = [];
  for (const seq of [1, 2, 3]) {
    const response = await get(`/${f.reviewId}/revisions/${seq}`);
    expect(response.status).toBe(200);
    views.push(contract.RevisionView.parse(await response.json()));
  }
  expect(views[0]?.files[0]).toMatchObject({ path: "a.ts", oldPath: null, hasOld: false, hasNew: true });
  expect(views[1]?.files[0]).toMatchObject({
    path: "b.ts",
    oldPath: "a.ts",
    status: "renamed",
    hasOld: true,
    hasNew: true,
  });
  expect(views.map((view) => view.threads[0]?.placement)).toEqual([
    { status: "placed", location: { kind: "file", path: "a.ts" } },
    { status: "placed", location: { kind: "file", path: "b.ts" } },
    { status: "unplaced", reason: "file-gone" },
  ]);
});

const pickedUp = async () => {
  const view = (await (await get(`/${f.reviewId}`)).json()) as { pickedUpAt: string | null };
  const listed = (await (await get("")).json()) as { items: { pickedUpAt: string | null }[] };
  expect(listed.items[0]?.pickedUpAt).toBe(view.pickedUpAt);
  return view.pickedUpAt;
};
const confirmDelivery = async (deliveryId: string) =>
  expect((await f.request(`/deliveries/${deliveryId}/confirm`, "POST", undefined, "agent")).status).toBe(204);
const iso = (ms: number) => new Date(ms).toISOString();

test("pickedUpAt is null without a confirmed delivery and ignores a claimed but unconfirmed one", async () => {
  await f.thread();
  await f.send();
  const view = (await (await get(`/${f.reviewId}`)).json()) as { pickedUpAt: string | null };
  expect(view.pickedUpAt).toBeNull();
  expect((await f.take()).kind).toBe("go");
  expect(await pickedUp()).toBeNull();
});

test("pickedUpAt is the latest confirmation of a delivery with Sends, and a later revision clears it", async () => {
  const thread = await f.thread();
  await f.send();
  const first = await f.take();
  if (first.kind !== "go") throw new Error("Expected a Go delivery");
  f.advance(1000);
  await confirmDelivery(first.deliveryId);
  expect(await pickedUp()).toBe(iso(f.deps.now()));
  f.advance(5000);
  await f.comment(thread.threadId, "A second draft");
  await f.send();
  const second = await f.take();
  if (second.kind !== "go") throw new Error("Expected a Go delivery");
  f.advance(1000);
  await confirmDelivery(second.deliveryId);
  expect(await pickedUp()).toBe(iso(f.deps.now()));
  f.advance(1000);
  await f.revision(2);
  expect(await pickedUp()).toBeNull();
});

test("kind follows the newest revision's writeup: publish when empty, review otherwise", async () => {
  const empty = { overview: "", tldr: "", decisions: null, topics: {} };
  const docOnly = await publishReview(f, { key: "d", docs: { "notes.md": "# Notes" }, writeup: empty });
  const withWriteup = await publishReview(f, { key: "e", writeup: { ...empty, overview: "Synthetic overview" } });
  const kinds = async () => {
    const listed = (await (await get("")).json()) as { items: { id: string; kind: string }[] };
    const views = await Promise.all(
      [docOnly.reviewId, withWriteup.reviewId].map(
        async (id) => ((await (await get(`/${id}`)).json()) as { kind: string }).kind,
      ),
    );
    expect(views).toEqual([
      listed.items.find((i) => i.id === docOnly.reviewId)?.kind,
      listed.items.find((i) => i.id === withWriteup.reviewId)?.kind,
    ]);
    return views;
  };
  expect(await kinds()).toEqual(["publish", "review"]);
  // The seeded fixture review has no writeup flag set, so it reads as a review.
  const seeded = (await (await get(`/${f.reviewId}`)).json()) as { kind: string };
  expect(seeded.kind).toBe("review");
  // A newer revision flips each kind, and the older revision no longer counts.
  await publishReview(f, { key: "d", writeup: { ...empty, tldr: "Now a review" } });
  await publishReview(f, { key: "e", writeup: empty });
  expect(await kinds()).toEqual(["review", "publish"]);
  expect(await (await get("", "foreign")).json()).toEqual({
    approvedActiveHours: 12,
    items: [],
    serverTime: new Date(f.deps.now()).toISOString(),
  });
});

test("links and repoUrl come back on the revision, link issue numbers in the writeup and docs, and keep a doc publish a publish", async () => {
  const empty = { overview: "", tldr: "", decisions: null, topics: {} };
  const links = [{ url: "https://github.com/owner/name/pull/9", label: "PR 9", kind: "pr" }];
  const repoUrl = "https://github.com/owner/name";
  const { reviewId } = await publishReview(f, {
    key: "1",
    docs: { "notes.md": "Tracked in #77, not in `#78`." },
    writeup: { ...empty, overview: "Closes #12." },
    links,
    repoUrl,
  });
  const revision = (await (await get(`/${reviewId}/revisions/1`)).json()) as {
    links: unknown;
    repoUrl: string | null;
    writeup: { sections: { blocks: { html: string }[] }[] };
    docs: { kind: string; blocks?: { html: string }[] }[];
  };
  expect(revision.links).toEqual(links);
  expect(revision.repoUrl).toBe(repoUrl);
  expect(revision.writeup.sections.flatMap((s) => s.blocks.map((b) => b.html)).join("")).toContain(
    `href="${repoUrl}/issues/12"`,
  );
  const doc = revision.docs.flatMap((d) => d.blocks?.map((b) => b.html) ?? []).join("");
  expect(doc).toContain(`href="${repoUrl}/issues/77"`);
  expect(doc).not.toContain("issues/78");
  const docOnly = await publishReview(f, { key: "2", docs: { "n.md": "x" }, writeup: empty, links, repoUrl });
  const view = (await (await get(`/${docOnly.reviewId}`)).json()) as { kind: string };
  expect(view.kind).toBe("publish");
  // A revision without them omits both, and nothing is linked.
  const plain = await publishReview(f, { key: "3", writeup: { ...empty, overview: "Closes #12." } });
  const bare = (await (await get(`/${plain.reviewId}/revisions/1`)).json()) as { links?: unknown[]; repoUrl?: unknown };
  expect(bare.links ?? []).toEqual([]);
  expect(bare.repoUrl ?? null).toBeNull();
});

test.each([
  { links: [{ url: "javascript:alert(1)", label: "x" }] },
  { links: [{ url: "data:text/html,x", label: "x" }] },
  { links: [{ url: "http://example.test/x", label: "x" }] },
  { links: [{ url: "https://user:pw@example.test/x", label: "x" }] },
  { links: [{ url: `https://example.test/${"a".repeat(2048)}`, label: "x" }] },
  { links: Array.from({ length: 9 }, () => ({ url: "https://example.test/x", label: "x" })) },
  { repoUrl: "http://github.com/o/r" },
  { repoUrl: "https://user@github.com/o/r" },
  { repoUrl: "javascript:alert(1)" },
])("a publish with hostile links is refused: %j", async (extra) => {
  const response = await f.request(
    "/publish",
    "POST",
    {
      reviewKey: "4".repeat(64),
      repo: null,
      branch: null,
      title: "Hostile",
      base: null,
      head: null,
      topics: [],
      writeup: { overview: "x", tldr: "", decisions: null, topics: {} },
      files: [],
      ...extra,
    },
    "agent",
  );
  await error(response, 400, "invalid_request");
});

test("a code review with an empty writeup stays a review", async () => {
  const empty = { overview: "", tldr: "", decisions: null, topics: {} };
  const { reviewId } = await publishReview(f, { key: "f", diff: true, writeup: empty });
  const view = (await (await get(`/${reviewId}`)).json()) as { kind: string };
  expect(view.kind).toBe("review");
  const listed = (await (await get("")).json()) as { items: { id: string; kind: string }[] };
  expect(listed.items.find((item) => item.id === reviewId)?.kind).toBe("review");
});

test("an approval-only delivery counts", async () => {
  await f.send({ revision: 1, kind: "approve" });
  const delivery = await f.take();
  expect(delivery.kind).toBe("approve");
  if (delivery.kind !== "approve") throw new Error("Expected an approval delivery");
  f.advance(1000);
  await confirmDelivery(delivery.deliveryId);
  expect(await pickedUp()).toBe(iso(f.deps.now()));
});

test("a delivery leased, then outdated by a newer revision, then confirmed gives null", async () => {
  await f.thread();
  await f.send();
  const delivery = await f.take();
  if (delivery.kind !== "go") throw new Error("Expected a Go delivery");
  f.advance(1000);
  await f.revision(2);
  f.advance(1000);
  await confirmDelivery(delivery.deliveryId);
  expect(await pickedUp()).toBeNull();
});

test("a newer confirmed delivery whose only Send is set aside leaves the earlier delivery's time", async () => {
  const thread = await f.thread();
  await f.send();
  const first = await f.take();
  if (first.kind !== "go") throw new Error("Expected a Go delivery");
  f.advance(1000);
  await confirmDelivery(first.deliveryId);
  const firstAt = f.deps.now();
  f.advance(5000);
  await f.comment(thread.threadId, "A second draft");
  const second = await f.send();
  const next = await f.take();
  if (next.kind !== "go") throw new Error("Expected a Go delivery");
  f.advance(1000);
  await confirmDelivery(next.deliveryId);
  expect(await pickedUp()).toBe(iso(f.deps.now()));
  // No real flow sets aside the only Send of a confirmed delivery, so this uses a direct update.
  await f.db.query((q) => q.update(sends).set({ setAsideAt: f.deps.now() }).where(eq(sends.id, second.sendId)));
  expect(await pickedUp()).toBe(iso(firstAt));
});

test("another owner's confirmed delivery never counts for this owner", async () => {
  const foreignReview = randomUUID();
  const foreignRevision = randomUUID();
  const foreignDelivery = randomUUID();
  const at = f.deps.now() + 1000;
  await f.db.query(async (q) => {
    await q.insert(reviews).values({
      id: foreignReview,
      ownerId: f.otherOwnerId,
      originInstanceId: f.instanceId,
      reviewKey: "b".repeat(64),
      title: "Synthetic foreign review",
      createdAt: at,
    });
    await q.insert(revisions).values({
      id: foreignRevision,
      ownerId: f.otherOwnerId,
      reviewId: foreignReview,
      seq: 1,
      contentKey: randomUUID(),
      createdAt: at,
    });
    await q.insert(deliveries).values({
      id: foreignDelivery,
      ownerId: f.otherOwnerId,
      reviewId: foreignReview,
      leaseUntil: at,
      confirmedAt: at,
    });
    await q.insert(sends).values({
      ownerId: f.otherOwnerId,
      reviewId: foreignReview,
      revisionId: foreignRevision,
      kind: "go",
      mode: "fix-clear",
      deliveryId: foreignDelivery,
      createdAt: at,
    });
  });
  // The foreign owner sees its own pick-up; this owner sees none, and never the foreign review.
  const theirs = (await (await get("", "foreign")).json()) as { items: { id: string; pickedUpAt: string | null }[] };
  expect(theirs.items).toMatchObject([{ id: foreignReview, pickedUpAt: iso(at) }]);
  expect(await pickedUp()).toBeNull();
  const ours = (await (await get("")).json()) as { items: { id: string }[] };
  expect(ours.items.map((item) => item.id)).toEqual([f.reviewId]);
  await error(await get(`/${f.reviewId}`, "foreign"), 404, "unknown_review");
  await error(await get(`/${foreignReview}`), 404, "unknown_review");
});

test("a send-less closed delivery never counts", async () => {
  expect((await f.request(`/reviews/${f.reviewId}/retire`, "POST", {})).status).toBe(204);
  const response = await f.request(
    `/reviews/${f.reviewId}/take`,
    "POST",
    { waitSeconds: 0, accepts: ["closed"] },
    "agent",
  );
  const closed = contract.WaitResult.parse(await response.json());
  expect(closed.kind).toBe("closed");
  f.advance(1000);
  await confirmDelivery((closed as { deliveryId: string }).deliveryId);
  expect(await pickedUp()).toBeNull();
});

test("a set-aside Send does not count even on a confirmed delivery", async () => {
  await f.thread();
  const sent = await f.send();
  const delivery = await f.take();
  if (delivery.kind !== "go") throw new Error("Expected a Go delivery");
  f.advance(1000);
  await confirmDelivery(delivery.deliveryId);
  expect(await pickedUp()).toBe(iso(f.deps.now()));
  await f.db.query((q) => q.update(sends).set({ setAsideAt: f.deps.now() }).where(eq(sends.id, sent.sendId)));
  expect(await pickedUp()).toBeNull();
});
