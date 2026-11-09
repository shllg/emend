import { randomUUID } from "node:crypto";
import { mkdir, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ImportBundle, importRowCount, indexImportBundle, LIMITS, RevisionView } from "@emend/contract";
import * as core from "@emend/core";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, expect, onTestFinished, test, vi } from "vitest";
import * as tables from "../../db/schema.ts";
import { chargePlacementMetadata } from "../import/placement-budget.ts";
import { importPlacements } from "../import/placements.ts";
import * as payload from "../mailbox/payload.ts";
import { error } from "../mailbox/test-support.ts";
import { WorkTimeout, workerExecutor } from "../publish/executor.ts";
import { publishSlots } from "../publish/lifecycle.ts";
import { executeWork, serializeRendered } from "../publish/work.ts";
import {
  bundle,
  capsBundle,
  escapedHtmlBundle,
  importFixture,
  longPath,
  metadataBundle,
  metadataShapes,
  multibyteCapsBundle,
  nestedSourceBundle,
  placementStorage,
  replayBundle,
  required,
  sharedTargetBundle,
  snapshot,
  unchangedSideShapes,
  unchangedSidesBundle,
} from "./import-test-support.ts";

let f: Awaited<ReturnType<typeof importFixture>>;
beforeEach(async () => {
  onTestFinished(() => {
    vi.restoreAllMocks();
  });
  f = await importFixture();
  onTestFinished(() => f.cleanup());
});
test("copies ids and history atomically, releases unconfirmed Sends, rotates content keys and skips retries", async () => {
  const input = await bundle(f);
  const response = await f.importRequest("/import", input);
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ skipped: false });
  await f.db.read(async (q) => {
    for (const [table, copied, extra] of [
      [tables.revisions, input.revisions, [f.revisionId]],
      [tables.topics, input.topics, []],
      [tables.files, input.files, []],
      [tables.writeups, input.writeups, []],
      [tables.threads, input.threads, []],
      [tables.comments, input.comments, []],
      [tables.sends, input.sends, []],
    ] as const) {
      const rows = await q.select({ id: table.id }).from(table).where(eq(table.ownerId, f.ownerId));
      expect(new Set(rows.map((r) => r.id))).toEqual(new Set([...copied.map((r) => r.id), ...extra]));
    }
  });
  const view = await (await f.request(`/reviews/${input.review.id}`, "GET")).json();
  expect(view).toMatchObject({
    importedAt: new Date(f.deps.now()).toISOString(),
    movedTo: null,
    origin: { id: f.origin, name: "Synthetic laptop" },
    revisions: [{ seq: 1 }, { seq: 2 }],
  });
  const revision = RevisionView.parse(await (await f.request(`/reviews/${input.review.id}/revisions/1`, "GET")).json());
  expect(required(revision.threads[0]).comments.map((c: { id: string }) => c.id)).toEqual(
    input.comments.map((c) => c.id),
  );
  expect(revision.docs[0]).toMatchObject({ kind: "html", contentUrl: expect.not.stringContaining("A".repeat(43)) });
  const deliveries = await f.db.read((q) =>
    q
      .select()
      .from(tables.deliveries)
      .where(and(eq(tables.deliveries.ownerId, f.ownerId), eq(tables.deliveries.reviewId, input.review.id))),
  );
  expect(deliveries.map((d) => d.id)).toEqual([input.deliveries[0]?.id]);
  const taken = await f.importRequest(`/reviews/${input.review.id}/take`, {});
  expect(taken.status).toBe(200);
  expect(await taken.json()).toMatchObject({
    kind: "go",
    comments: [{ id: input.comments[2]?.id, body: "Second feedback" }],
  });
  const before = await snapshot(f);
  const retry = await f.importRequest("/import", input);
  expect(retry.status).toBe(200);
  expect(await retry.json()).toEqual({ skipped: true });
  expect(await snapshot(f)).toEqual(before);
});
test.each([
  "origin",
  "review collision",
  "foreign review collision",
  "blob",
  "reference",
  "id collision",
  "duplicate id",
  "path",
  "body",
])("rejects %s and writes nothing", async (kind) => {
  const input = await bundle(f);
  if (kind === "origin") input.review.originInstanceId = f.instanceId;
  if (kind === "review collision") input.review.id = f.reviewId;
  if (kind === "foreign review collision") {
    input.review.id = randomUUID();
    await f.db.query((q) =>
      q.insert(tables.reviews).values({
        id: input.review.id,
        ownerId: f.otherOwnerId,
        originInstanceId: f.origin,
        reviewKey: "e".repeat(64),
        title: "Foreign",
      }),
    );
  }
  if (kind === "blob") required(input.files[0]).newBlob = "f".repeat(64);
  if (kind === "reference") required(input.comments[0]).threadId = randomUUID();
  if (kind === "id collision") required(input.comments[0]).id = f.revisionId;
  if (kind === "duplicate id") required(input.comments[1]).id = required(input.comments[0]).id;
  if (kind === "path") required(input.files[0]).path = "../doc.html";
  if (kind === "body") required(input.comments[0]).body = "x".repeat(LIMITS.commentBodyChars + 1);
  // Keep the rest of the graph internally consistent for review-id collision tests.
  if (kind.includes("review collision"))
    for (const rows of [
      input.revisions,
      input.threads,
      input.placements,
      input.comments,
      input.sends,
      input.deliveries,
    ])
      for (const row of rows) row.reviewId = input.review.id;
  const before = await snapshot(f);
  await error(
    await f.importRequest("/import", input),
    400,
    kind.includes("origin") || kind.includes("review collision")
      ? "wrong_origin"
      : kind === "blob"
        ? "blob_missing"
        : "invalid_request",
  );
  expect(await snapshot(f)).toEqual(before);
});
test("local agents cannot import; oversized bodies fail before writing", async () => {
  const input = await bundle(f);
  const before = await snapshot(f);
  await error(await f.request("/import", "POST", input, "agent"), 404, "not_found");
  await error(await f.importRequest("/import", { padding: "x".repeat(LIMITS.publishJsonBytes) }), 413, "too_large");
  expect(await snapshot(f)).toEqual(before);
});
test("machine cannot publish, take or reply across origins", async () => {
  const thread = await f.thread();
  await f.send();
  await error(await f.importRequest(`/reviews/${f.reviewId}/take`, {}), 404, "unknown_review");
  await error(
    await f.importRequest(`/comments/${thread.commentId}/reply`, { outcome: "explained", body: "No" }),
    404,
    "not_found",
  );
  await error(
    await f.importRequest("/publish", {
      reviewId: f.reviewId,
      reviewKey: "a".repeat(64),
      repo: null,
      branch: null,
      title: "Synthetic",
      base: null,
      head: null,
      topics: [],
      files: [],
      writeup: { overview: "", tldr: "", decisions: null, topics: {} },
    }),
    404,
    "unknown_review",
  );
});

test("regenerates hostile rendered content from source and preserves doc asset associations", async () => {
  const input = await bundle(f);
  const hostile = await f.deps.blobs.put(
    f.ownerId,
    Buffer.from(
      JSON.stringify({
        sections: [
          {
            key: "overview",
            label: "Overview",
            topic: null,
            blocks: [
              {
                id: "overview-12345678",
                section: "overview",
                kind: "paragraph",
                html: '<img src=x onerror="alert(1)"><script>alert(1)</script><a href="javascript:alert(1)">bad</a><svg onload="alert(1)"></svg>',
                text: "bad",
              },
            ],
          },
        ],
      }),
    ),
    "application/json",
  );
  for (const w of input.writeups) w.renderedBlob = hostile;
  const doc = required(input.files[0]);
  const assetId = randomUUID();
  const asset = await f.deps.blobs.put(f.ownerId, Buffer.from("body { color: blue; }"), "text/css");
  const withAssets = {
    ...input,
    docAssets: [{ revisionId: doc.revisionId, docId: doc.id, assetId }],
    files: [
      ...input.files,
      { ...doc, id: assetId, path: "style.css", role: "asset", newBlob: asset, parentDocId: doc.id, ord: 1 },
    ],
  };
  expect((await f.importRequest("/import", withAssets)).status).toBe(201);
  const revision = RevisionView.parse(await (await f.request(`/reviews/${input.review.id}/revisions/1`, "GET")).json());
  const html = revision.writeup.sections
    .flatMap((s) => s.blocks)
    .map((b) => b.html)
    .join("");
  expect(html).toContain("Synthetic writeup");
  expect(html).not.toMatch(/onerror|<script|javascript:|<svg/);
  const htmlDoc = revision.docs.find((d) => d.kind === "html");
  expect(htmlDoc?.kind).toBe("html");
  if (htmlDoc?.kind !== "html") throw new Error("Missing HTML doc");
  const assetUrl = htmlDoc.contentUrl.replace(/doc.html$/, "style.css");
  const response = await f.app.request(`http://127.0.0.1:3636${assetUrl}`, { headers: { Host: "127.0.0.1:3636" } });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("body { color: blue; }");
});

test.each([
  ["asset", 0],
  ["asset", 1],
  ["HTML doc and assets", 0],
  ["HTML doc and assets", 1],
] as const)("import enforces the %s byte limit plus %i", async (kind, over) => {
  const input = await bundle(f);
  const doc = required(input.files[0]);
  const html = await f.deps.blobs.get(f.ownerId, doc.newBlob);
  if (!html) throw new Error("Missing HTML fixture");
  const sizes =
    kind === "asset"
      ? [LIMITS.assetBytes + over]
      : [LIMITS.assetBytes, LIMITS.htmlDocWithAssetsBytes - html.length - LIMITS.assetBytes + over];
  const assets = sizes.map((size, i) => ({
    ownerId: f.ownerId,
    sha256: String(i).repeat(64),
    size,
    mediaType: "image/png",
  }));
  // Import checks asset sizes and file presence without reading their bytes.
  await f.deps.db.query((q) => q.insert(tables.blobs).values(assets));
  for (const asset of assets) {
    const folder = join(f.dir, "state", "blobs", asset.sha256.slice(0, 2));
    const path = join(folder, asset.sha256);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await writeFile(path, "", { mode: 0o600 });
    await truncate(path, asset.size);
  }
  const assetFiles = assets.map((asset, i) => ({
    ...doc,
    id: randomUUID(),
    path: `asset-${i}.png`,
    role: "asset",
    mediaType: "image/png",
    newBlob: asset.sha256,
    parentDocId: doc.id,
    ord: i + 1,
  }));
  const withAssets = {
    ...input,
    files: [...input.files, ...assetFiles],
    docAssets: assetFiles.map((asset) => ({ revisionId: doc.revisionId, docId: doc.id, assetId: asset.id })),
  };
  const before = await snapshot(f);
  const get = vi.spyOn(f.deps.blobs, "get");
  const response = await f.importRequest("/import", withAssets);
  if (over) {
    await error(response, 413, "too_large");
    expect(await snapshot(f)).toEqual(before);
    expect(get.mock.calls.some(([, hash]) => hash === doc.newBlob)).toBe(false);
  } else {
    expect(response.status).toBe(201);
    expect(get.mock.calls.some(([, hash]) => hash === doc.newBlob)).toBe(true);
  }
  expect(get.mock.calls.some(([, hash]) => assets.some((asset) => asset.sha256 === hash))).toBe(false);
});

test("a round trip keeps links and repoUrl from the source blob and links issue numbers again", async () => {
  const input = await bundle(f);
  const link = { url: "https://example.test/o/r/pull/7", label: "PR 7", kind: "pr" };
  const writeup = { overview: "Fixes #5", tldr: "", decisions: null, topics: {} };
  const put = (value: unknown) => f.deps.blobs.put(f.ownerId, Buffer.from(JSON.stringify(value)), "application/json");
  const source = await put({ ...writeup, links: [link], repoUrl: "https://github.com/owner/name" });
  for (const w of input.writeups) w.sourceBlob = source;
  expect((await f.importRequest("/import", input)).status).toBe(201);
  const revision = RevisionView.parse(await (await f.request(`/reviews/${input.review.id}/revisions/1`, "GET")).json());
  expect(revision.links).toEqual([link]);
  expect(revision.repoUrl).toBe("https://github.com/owner/name");
  const html = revision.writeup.sections.flatMap((s) => s.blocks.map((b) => b.html)).join("");
  expect(html).toContain('href="https://github.com/owner/name/issues/5"');
});

test("a source blob with a hostile link or repoUrl is refused", async () => {
  for (const extra of [{ links: [{ url: "javascript:alert(1)", label: "x" }] }, { repoUrl: "http://github.com/o/r" }]) {
    const input = await bundle(f);
    const source = await f.deps.blobs.put(
      f.ownerId,
      Buffer.from(JSON.stringify({ overview: "x", tldr: "", decisions: null, topics: {}, ...extra })),
      "application/json",
    );
    for (const w of input.writeups) w.sourceBlob = source;
    expect((await f.importRequest("/import", input)).status).toBe(400);
  }
});

test("imports writeup media as parentless assets and the writeup renders the image", async () => {
  const input = await bundle(f);
  const source = await f.deps.blobs.put(
    f.ownerId,
    Buffer.from(JSON.stringify({ overview: "![Before](media/a.png)", tldr: "", decisions: null, topics: {} })),
    "application/json",
  );
  for (const w of input.writeups) w.sourceBlob = source;
  const doc = required(input.files[0]);
  // A synthetic PNG header; the import does not decode image bytes.
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");
  const hash = await f.deps.blobs.put(f.ownerId, png, "image/png");
  const withMedia = {
    ...input,
    files: [
      ...input.files,
      { ...doc, id: randomUUID(), path: "media/a.png", role: "asset", mediaType: "image/png", newBlob: hash, ord: 1 },
    ],
  };
  expect((await f.importRequest("/import", withMedia)).status).toBe(201);
  const revision = RevisionView.parse(await (await f.request(`/reviews/${input.review.id}/revisions/1`, "GET")).json());
  const html = revision.writeup.sections.flatMap((s) => s.blocks.map((b) => b.html)).join("");
  expect(html).toContain(`src="/api/v1/media/${hash}"`);
  expect(html).toContain('<span class="emend-media-caption">Before</span>');
  const image = await f.request(`/media/${hash}`, "GET");
  expect(image.status).toBe(200);
  expect(image.headers.get("Content-Type")).toBe("image/png");
  expect(Buffer.from(await image.arrayBuffer())).toEqual(png);
});

test("preserves approval records and permits retry after a busy response", async () => {
  const input = await bundle(f);
  const approvalId = randomUUID();
  const approved = {
    ...input,
    review: { ...input.review, state: "approved", approvedRevision: required(input.revisions[1]).id },
    sends: [
      ...input.sends,
      {
        id: approvalId,
        reviewId: input.review.id,
        revisionId: required(input.revisions[1]).id,
        kind: "approve",
        mode: null,
        instruction: null,
        deliveryId: null,
        setAsideAt: null,
        createdAt: input.review.updatedAt,
      },
    ],
  };
  const responses = await Promise.all([f.importRequest("/import", approved), f.importRequest("/import", approved)]);
  expect(responses.map((r) => r.status).sort()).toEqual([201, 429]);
  expect((await f.importRequest("/import", approved)).status).toBe(200);
  const saved = await f.db.read((q) =>
    q
      .select()
      .from(tables.sends)
      .where(and(eq(tables.sends.ownerId, f.ownerId), eq(tables.sends.id, approvalId)))
      .get(),
  );
  expect(saved).toMatchObject({ kind: "approve", revisionId: required(input.revisions[1]).id });
  const view = await (await f.request(`/reviews/${input.review.id}`, "GET")).json();
  expect(view).toMatchObject({ state: "approved", list: "done", activeUntil: null });
  const imported = await f.db.read((q) =>
    q
      .select()
      .from(tables.reviews)
      .where(and(eq(tables.reviews.ownerId, f.ownerId), eq(tables.reviews.id, input.review.id)))
      .get(),
  );
  expect(imported?.approvedAt).toBeNull();
});

test.each(["revision", "send", "delivery", "asset", "writeup", "target", "file size"])(
  "rejects invalid %s with no partial writes",
  async (kind) => {
    const input = await bundle(f);
    if (kind === "revision") required(input.files[0]).revisionId = randomUUID();
    if (kind === "send") required(input.comments[0]).sendId = randomUUID();
    if (kind === "delivery") required(input.sends[0]).deliveryId = randomUUID();
    if (kind === "writeup") input.writeups.pop();
    if (kind === "asset") Object.assign(required(input.files[0]), { parentDocId: randomUUID() });
    if (kind === "target") Object.assign(required(input.threads[0]), { target: { kind: "file", path: "absent.ts" } });
    if (kind === "file size") {
      required(input.files[0]).path = "doc.md";
      required(input.files[0]).newBlob = await f.deps.blobs.put(
        f.ownerId,
        Buffer.alloc(LIMITS.markdownDocBytes + 1, 32),
        "text/markdown",
      );
    }
    const before = await snapshot(f);
    await error(
      await f.importRequest("/import", input),
      kind === "file size" ? 413 : 400,
      kind === "file size" ? "too_large" : "invalid_request",
    );
    expect(await snapshot(f)).toEqual(before);
  },
);

test("a late storage constraint failure rolls back the whole copy", async () => {
  const first = await bundle(f);
  expect((await f.importRequest("/import", first)).status).toBe(201);
  const second = await bundle(f);
  const before = await snapshot(f); // same owner/origin/review key, different ids
  await error(await f.importRequest("/import", second), 400, "invalid_request");
  expect(await snapshot(f)).toEqual(before);
});

test("ignores supplied placements referring outside a revision", async () => {
  const input = await bundle(f);
  const changed = {
    ...input,
    threads: input.threads.map((t) => ({ ...t, target: { kind: "file", path: "doc.html" } })),
    placements: input.placements.map((p) => ({ ...p, location: { kind: "file", path: "missing.html" } })),
  };
  expect((await f.importRequest("/import", changed)).status).toBe(201);
});

test("another owner's uploaded blob cannot satisfy an import reference", async () => {
  const input = await bundle(f);
  required(input.files[0]).newBlob = await f.deps.blobs.put(
    f.otherOwnerId,
    Buffer.from("<p>Foreign synthetic bytes</p>"),
    "text/html",
  );
  const before = await snapshot(f);
  await error(await f.importRequest("/import", input), 400, "blob_missing");
  expect(await snapshot(f)).toEqual(before);
});

test("revocation during rendering prevents the copy from committing", async () => {
  const input = await bundle(f);
  const before = await snapshot(f);
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const execute = f.deps.publishExecutor;
  if (!execute) throw new Error("Missing test renderer");
  let paused = false;
  f.deps.publishExecutor = async (work) => {
    if (!paused) {
      paused = true;
      entered.resolve();
      await resume.promise;
    }
    return execute(work);
  };
  const pending = f.importRequest("/import", input);
  onTestFinished(async () => {
    resume.resolve();
    await pending;
  });
  await entered.promise;
  try {
    const device = await f.db.read((q) =>
      q
        .select()
        .from(tables.devices)
        .where(and(eq(tables.devices.ownerId, f.ownerId), eq(tables.devices.instanceId, f.origin)))
        .get(),
    );
    expect(device).toBeDefined();
    expect((await f.request(`/devices/${device?.id}`, "DELETE")).status).toBe(204);
  } finally {
    resume.resolve();
  }
  await error(await pending, 401, "unauthorized");
  expect(await snapshot(f)).toEqual(before);
});

// Fix round 1 regression cases.
test("computes placements when the supplied list is incomplete", async () => {
  const input = await bundle(f);
  input.placements.pop();
  expect((await f.importRequest("/import", input)).status).toBe(201);
  const rows = await f.db.read((q) =>
    q
      .select()
      .from(tables.placements)
      .where(and(eq(tables.placements.ownerId, f.ownerId), eq(tables.placements.reviewId, input.review.id))),
  );
  expect(rows).toHaveLength(2);
});
test("a review-key conflict is refused before rendering", async () => {
  const first = await bundle(f);
  expect((await f.importRequest("/import", first)).status).toBe(201);
  const second = await bundle(f);
  let renders = 0;
  const execute = f.deps.publishExecutor;
  if (!execute) throw new Error("Missing renderer");
  f.deps.publishExecutor = (work) => {
    renders++;
    return execute(work);
  };
  await error(await f.importRequest("/import", second), 400, "invalid_request");
  expect(renders).toBe(0);
});
test("diff and Markdown doc at the same path retain distinct rendered fields", async () => {
  const input = await bundle(f);
  const doc = required(input.files[0]);
  doc.path = "doc.md";
  doc.newBlob = await f.deps.blobs.put(f.ownerId, Buffer.from("Synthetic doc"), "text/markdown");
  const diff = { ...doc, id: randomUUID(), role: "diff", status: "added", ord: 1 };
  expect((await f.importRequest("/import", { ...input, files: [...input.files, diff] })).status).toBe(201);
  const row = await f.db.read((q) =>
    q
      .select()
      .from(tables.files)
      .where(and(eq(tables.files.ownerId, f.ownerId), eq(tables.files.id, diff.id)))
      .get(),
  );
  expect(row?.renderedBlob).toBeNull();
});
test("an asset cannot adopt a diff as its parent doc", async () => {
  const input = await bundle(f);
  const doc = required(input.files[0]);
  const diff = { ...doc, id: randomUUID(), role: "diff", status: "added", ord: 1 };
  const asset = { ...doc, id: randomUUID(), path: "style.css", role: "asset", ord: 2, parentDocId: diff.id };
  await error(
    await f.importRequest("/import", {
      ...input,
      files: [...input.files, diff, asset],
      docAssets: [{ revisionId: doc.revisionId, docId: doc.id, assetId: asset.id }],
    }),
    400,
    "invalid_request",
  );
});
test("clamps every copied timestamp to the hub clock", async () => {
  const input = await bundle(f);
  const future = "2099-01-01T00:00:00.000Z";
  for (const row of [
    input.review,
    ...input.revisions,
    ...input.threads,
    ...input.comments,
    ...input.sends,
    ...input.deliveries,
  ]) {
    for (const key of ["createdAt", "updatedAt", "leaseUntil", "confirmedAt", "setAsideAt"])
      if (Reflect.get(row, key) != null) Reflect.set(row, key, future);
  }
  expect((await f.importRequest("/import", input)).status).toBe(201);
  await f.db.read(async (q) => {
    for (const table of [
      tables.reviews,
      tables.revisions,
      tables.threads,
      tables.comments,
      tables.sends,
      tables.deliveries,
    ]) {
      const rows = await q.select().from(table).where(eq(table.ownerId, f.ownerId));
      for (const row of rows.filter((row) => row.id !== f.reviewId && row.id !== f.revisionId))
        for (const key of ["createdAt", "updatedAt", "leaseUntil", "confirmedAt", "setAsideAt"]) {
          const value = Reflect.get(row, key);
          if (typeof value === "number") expect(value).toBeLessThanOrEqual(f.deps.now());
        }
    }
  });
});
test.each([false, true])("placement worker failure maps to the publish error (timeout: %s)", async (timeout) => {
  const input = await bundle(f);
  const execute = f.deps.publishExecutor;
  if (!execute) throw new Error("Missing renderer");
  f.deps.publishExecutor = async (work) => {
    if (work.kind === "place") {
      if (timeout) throw new WorkTimeout();
      throw new Error("Synthetic placement failure");
    }
    return execute(work);
  };
  await error(await f.importRequest("/import", input), timeout ? 413 : 400, timeout ? "too_large" : "invalid_request");
});
test("a running import rejects another import immediately without occupying publish slots", async () => {
  const input = await bundle(f);
  const entered = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>();
  const execute = f.deps.publishExecutor;
  if (!execute) throw new Error("Missing renderer");
  let first = true;
  f.deps.publishExecutor = async (work) => {
    if (first) {
      first = false;
      entered.resolve();
      await resume.promise;
    }
    return execute(work);
  };
  const pending = f.importRequest("/import", input);
  onTestFinished(async () => {
    resume.resolve();
    await pending;
  });
  await entered.promise;
  try {
    await error(await f.importRequest("/import", input), 429, "rate_limited");
    // Both publishing slots remain immediately available while import is paused.
    const releaseOne = await publishSlots.acquire();
    onTestFinished(releaseOne);
    const releaseTwo = await publishSlots.acquire();
    onTestFinished(releaseTwo);
  } finally {
    resume.resolve();
    await pending;
  }
});
test("aborting an import releases its slot before rendering resumes and creates no review", async () => {
  const input = await bundle(f);
  const entered = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>();
  const execute = f.deps.publishExecutor;
  if (!execute) throw new Error("Missing renderer");
  let first = true;
  f.deps.publishExecutor = async (work) => {
    if (first) {
      first = false;
      entered.resolve();
      await resume.promise;
    }
    return execute(work);
  };
  const abort = new AbortController();
  const pending = f.importRequest("/import", input, abort.signal);
  onTestFinished(async () => {
    abort.abort();
    resume.resolve();
    await pending;
  });
  await entered.promise;
  abort.abort();
  try {
    await error(await pending, 400, "invalid_request");
    const other = await bundle(f);
    other.review.reviewKey = "e".repeat(64);
    expect((await f.importRequest("/import", other)).status).toBe(201);
  } finally {
    resume.resolve();
  }
  const rows = await f.db.read((q) =>
    q
      .select()
      .from(tables.reviews)
      .where(and(eq(tables.reviews.ownerId, f.ownerId), eq(tables.reviews.id, input.review.id))),
  );
  expect(rows).toEqual([]);
});

test("imports a bundle at all five count ceilings and exactly 50000 inserted rows without exceeding the JSON byte ceiling", async () => {
  const { input, creation } = await capsBundle(f);
  expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThanOrEqual(LIMITS.publishJsonBytes);
  const spy = vi.spyOn(f.db, "transaction");
  const before = await snapshot(f);
  const over = { ...input, threads: input.threads.map((t, i) => (i ? t : { ...t, createdRevisionId: creation.id })) };
  await error(await f.importRequest("/import", over), 400, "invalid_request");
  expect(spy).not.toHaveBeenCalled();
  expect(await snapshot(f)).toEqual(before);
  expect((await f.importRequest("/import", input)).status).toBe(201);
  expect(spy).toHaveBeenCalledTimes(1);
  const after = await snapshot(f);
  const inserted = after.reduce((sum, row, i) => sum + (row?.n ?? 0) - (before[i]?.n ?? 0), 0);
  expect(inserted).toBe(LIMITS.importRows);
}, 90_000);

test.each(["revisions", "threads", "comments", "sends", "deliveries"] as const)(
  "one extra %s row gets invalid_request",
  async (key) => {
    const input = ImportBundle.parse(await bundle(f));
    const caps = {
      revisions: LIMITS.importRevisions,
      threads: LIMITS.importThreads,
      comments: LIMITS.importComments,
      sends: LIMITS.importSends,
      deliveries: LIMITS.importDeliveries,
    };
    const body = { ...input, [key]: Array.from({ length: caps[key] + 1 }, () => input[key][0]) };
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(LIMITS.publishJsonBytes);
    const before = await snapshot(f);
    await error(await f.importRequest("/import", body), 400, "invalid_request");
    expect(await snapshot(f)).toEqual(before);
  },
);

// Fix round 2 regressions, written before implementation.
test.each([false, true])("fix2: line placement is independent of doc/diff order (%s)", async (docFirst) => {
  const input = await bundle(f);
  const doc = {
    ...required(input.files[0]),
    path: "doc.md",
    newBlob: await f.deps.blobs.put(f.ownerId, Buffer.from("line one\nline two"), "text/markdown"),
  };
  const diff = { ...doc, id: randomUUID(), role: "diff", status: "added" };
  const files = (docFirst ? [doc, diff] : [diff, doc]).map((file, ord) => ({ ...file, ord }));
  const target = {
    kind: "lines",
    path: doc.path,
    side: "new",
    start: 2,
    end: 2,
    lines: ["line two"],
    before: ["line one"],
    after: [],
  };
  const body = {
    ...input,
    files,
    threads: input.threads.map((t) => ({ ...t, target })),
    placements: input.placements.map((p, i) => ({
      ...p,
      status: i ? "unplaced" : "placed",
      reason: i ? "file-gone" : null,
      location: i ? null : { kind: "lines", path: doc.path, side: "new", start: 2, end: 2 },
    })),
  };
  expect((await f.importRequest("/import", body)).status).toBe(201);
  const rows = await f.db.read((q) =>
    q
      .select()
      .from(tables.placements)
      .where(and(eq(tables.placements.ownerId, f.ownerId), eq(tables.placements.reviewId, input.review.id))),
  );
  expect(rows.find((p) => p.revisionId === doc.revisionId)?.location).toEqual({
    kind: "lines",
    path: doc.path,
    side: "new",
    start: 2,
    end: 2,
  });
});
test.each([false, true])("fix2: supplied placements cannot redirect or hide a thread (%s)", async (hidden) => {
  const input = await bundle(f);
  const doc = required(input.files[0]);
  const body = {
    ...input,
    files: [doc, { ...doc, id: randomUUID(), ord: 1, path: "other.html" }],
    threads: input.threads.map((t) => ({ ...t, target: { kind: "file", path: doc.path } })),
    placements: input.placements.map((p) => ({
      ...p,
      status: hidden ? "unplaced" : "placed",
      location: hidden ? null : { kind: "file", path: "other.html" },
      reason: hidden ? "file-gone" : null,
      carried: { path: null },
    })),
  };
  expect((await f.importRequest("/import", body)).status).toBe(201);
  const rows = await f.db.read((q) =>
    q
      .select()
      .from(tables.placements)
      .where(and(eq(tables.placements.ownerId, f.ownerId), eq(tables.placements.reviewId, input.review.id))),
  );
  expect(rows.find((p) => p.revisionId === doc.revisionId)).toMatchObject({
    status: "placed",
    location: { kind: "file", path: doc.path },
    carried: { path: doc.path },
  });
});
test("fix2: derived fields are stripped and changed blocks come from consecutive hub renderings", async () => {
  const input = await bundle(f);
  expect(ImportBundle.parse(input)).not.toHaveProperty("placements");
  expect(ImportBundle.parse(input)).not.toHaveProperty("changedBlocks");
  expect((await f.importRequest("/import", input)).status).toBe(201);
  const rows = await f.db.read((q) =>
    q.select().from(tables.changedBlocks).where(eq(tables.changedBlocks.ownerId, f.ownerId)),
  );
  expect(rows).toEqual([]);
});
test("import skips first-revision change work and stores exactly the second revision's new blocks", async () => {
  const input = await bundle(f);
  const jobs = vi.fn(required(f.deps.publishExecutor));
  f.deps.publishExecutor = jobs;
  const source = { overview: "Synthetic writeup\n\nNew paragraph", tldr: "", decisions: null, topics: {} };
  required(input.writeups[1]).sourceBlob = await f.deps.blobs.put(
    f.ownerId,
    Buffer.from(JSON.stringify(source)),
    "application/json",
  );
  expect((await f.importRequest("/import", input)).status).toBe(201);
  expect(jobs.mock.calls.filter(([work]) => work.kind === "changed")).toHaveLength(1);
  const expected = (await core.renderWriteup(source, [])).sections
    .flatMap((section) => section.blocks)
    .filter((block) => block.text === "New paragraph")
    .map((block) => ({ revisionId: required(input.revisions[1]).id, blockId: block.id }));
  expect(expected).toHaveLength(1);
  const rows = await f.db.read((q) =>
    q
      .select({ revisionId: tables.changedBlocks.revisionId, blockId: tables.changedBlocks.blockId })
      .from(tables.changedBlocks)
      .where(eq(tables.changedBlocks.ownerId, f.ownerId)),
  );
  expect(rows).toEqual(expected);
});
test("fix2: abort during blob size lookup stops before the next lookup", async () => {
  const input = await bundle(f);
  const abort = new AbortController();
  const read = f.db.read.bind(f.db);
  let lookups = 0;
  vi.spyOn(f.db, "read").mockImplementation((fn) =>
    read((q) => {
      const select = q.select.bind(q);
      vi.spyOn(q, "select").mockImplementation((...args: Parameters<typeof select>) => {
        const builder = select(...args);
        const from = builder.from.bind(builder);
        builder.from = ((table: unknown) => {
          if (table === tables.blobs) {
            lookups++;
            abort.abort();
          }
          return from(table as never);
        }) as typeof builder.from;
        return builder;
      });
      return fn(q);
    }),
  );
  const response = await f.importRequest("/import", input, abort.signal);
  expect(response.status).toBe(400);
  expect(lookups).toBe(1);
  expect(await response.json()).toMatchObject({ error: { message: "The import was cancelled." } });
});
test("fix2: final presence sweep does not read unused supplied rendered blobs", async () => {
  const input = await bundle(f);
  const unused = await f.deps.blobs.put(f.ownerId, Buffer.from("unused derived bytes"), "application/json");
  for (const w of input.writeups) w.renderedBlob = unused;
  const get = vi.spyOn(f.deps.blobs, "get");
  expect((await f.importRequest("/import", input)).status).toBe(201);
  expect(get.mock.calls.some(([, hash]) => hash === unused)).toBe(false);
});
test("fix2: generated placements over importRows fail before a writer transaction", async () => {
  expect(LIMITS.importRows).toBe(50000);
  const input = await bundle(f);
  const rev = required(input.revisions[0]),
    writeup = required(input.writeups[0]),
    thread = required(input.threads[0]);
  input.revisions = Array.from({ length: 51 }, (_, i) => ({ ...rev, id: randomUUID(), seq: i + 1 }));
  input.writeups = input.revisions.map((r) => ({ ...writeup, id: randomUUID(), revisionId: r.id }));
  input.threads = Array.from({ length: 1000 }, () => ({
    ...thread,
    id: randomUUID(),
    createdRevisionId: required(input.revisions[0]).id,
  }));
  input.files = [];
  input.topics = [];
  input.sends = [];
  input.comments = [];
  input.deliveries = [];
  const transaction = vi.spyOn(f.db, "transaction");
  const before = await snapshot(f);
  await error(
    await f.importRequest("/import", { ...input, placements: undefined, changedBlocks: undefined }),
    400,
    "invalid_request",
  );
  expect(transaction).not.toHaveBeenCalled();
  expect(await snapshot(f)).toEqual(before);
});
test("fix2: abort between insert batches rolls back and stops at the next batch", async () => {
  const input = await bundle(f);
  const thread = required(input.threads[0]);
  input.threads = Array.from({ length: 1000 }, () => ({ ...thread, id: randomUUID() }));
  input.sends = [];
  input.comments = [];
  input.deliveries = [];
  input.placements = input.threads.flatMap((t) => input.placements.map((p) => ({ ...p, threadId: t.id })));
  const abort = new AbortController(),
    batches: number[] = [];
  const transaction = f.db.transaction.bind(f.db);
  vi.spyOn(f.db, "transaction").mockImplementation((fn, options) =>
    transaction((q) => {
      const insert = q.insert.bind(q);
      vi.spyOn(q, "insert").mockImplementation((table) => {
        const builder = insert(table);
        const values = builder.values.bind(builder);
        builder.values = ((rows: unknown) => {
          if (table === tables.threads) {
            batches.push(Array.isArray(rows) ? rows.length : 1);
            abort.abort();
          }
          return values(rows as never);
        }) as typeof builder.values;
        return builder;
      });
      return fn(q);
    }, options),
  );
  const before = await snapshot(f);
  const response = await f.importRequest("/import", input, abort.signal);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { message: "The import was cancelled." } });
  expect(batches).toEqual([500]);
  expect(await snapshot(f)).toEqual(before);
});
test("fix2: total rendered output budget stops before staging excess bytes or writing rows", async () => {
  const input = await bundle(f);
  const original = Reflect.get(LIMITS, "importRenderedBytes");
  expect(original).toBe(1073741824);
  const before = await snapshot(f);
  const stage = vi.spyOn(f.deps.blobs, "stage");
  // Scale the same cumulative boundary down so the regression needs no GiB allocation.
  Object.assign(LIMITS, { importRenderedBytes: 1 });
  try {
    await error(await f.importRequest("/import", input), 413, "too_large");
    expect(stage).not.toHaveBeenCalled();
    expect(await snapshot(f)).toEqual(before);
  } finally {
    Object.assign(LIMITS, { importRenderedBytes: original });
  }
});

test("fix2: carries a rename through an unplaced revision using the last successful line anchor", async () => {
  const input = await bundle(f);
  const first = required(input.revisions[0]);
  input.revisions.push({ ...first, id: randomUUID(), seq: 3 });
  input.writeups.push({
    ...required(input.writeups[0]),
    id: randomUUID(),
    revisionId: required(input.revisions[2]).id,
  });
  const good = await f.deps.blobs.put(f.ownerId, Buffer.from("needle"), "text/plain");
  const bad = await f.deps.blobs.put(f.ownerId, Buffer.from("different"), "text/plain");
  const file = required(input.files[0]);
  const files = input.revisions.map((r, i) => ({
    ...file,
    id: randomUUID(),
    revisionId: r.id,
    role: "diff",
    status: i ? "renamed" : "added",
    path: i ? "moved.md" : "doc.md",
    oldPath: i ? "doc.md" : null,
    newBlob: i === 1 ? bad : good,
  }));
  const target = {
    kind: "lines",
    path: "doc.md",
    side: "new",
    start: 1,
    end: 1,
    lines: ["needle"],
    before: [],
    after: [],
  };
  const response = await f.importRequest("/import", {
    ...input,
    files,
    threads: input.threads.map((t) => ({ ...t, target })),
  });
  expect(response.status).toBe(201);
  const rows = await f.db.read((q) =>
    q
      .select()
      .from(tables.placements)
      .where(and(eq(tables.placements.ownerId, f.ownerId), eq(tables.placements.reviewId, input.review.id))),
  );
  const byRevision = new Map(rows.map((r) => [r.revisionId, r]));
  expect(byRevision.get(first.id)).toMatchObject({
    status: "placed",
    location: { path: "doc.md", start: 1 },
    carried: { path: "doc.md", side: "new" },
  });
  expect(byRevision.get(required(input.revisions[1]).id)).toMatchObject({
    status: "unplaced",
    carried: { path: "moved.md", side: "new" },
  });
  expect(byRevision.get(required(input.revisions[2]).id)).toMatchObject({
    status: "placed",
    location: { path: "moved.md", start: 1 },
    carried: { path: "moved.md", side: "new" },
  });
});

test("fix2: rendered-byte budget is cumulative across repeated revisions", async () => {
  const input = await bundle(f);
  input.files = []; // Isolate repeated writeup output from the separate doc metadata budget.
  const original = LIMITS.importRenderedBytes;
  const run = f.deps.publishExecutor;
  if (!run) throw new Error("Missing renderer");
  let rendered = 0;
  f.deps.publishExecutor = async (work) => {
    const result = await run(work);
    if (result.kind === "writeup" && ++rendered === 1)
      Object.assign(LIMITS, { importRenderedBytes: result.bytes.byteLength });
    return result;
  };
  const before = await snapshot(f);
  const stage = vi.spyOn(f.deps.blobs, "stage");
  try {
    await error(await f.importRequest("/import", input), 413, "too_large");
    expect(rendered).toBe(2);
    expect(stage).toHaveBeenCalledTimes(2); // Only the first writeup rendering and its source.
    expect(await snapshot(f)).toEqual(before);
  } finally {
    Object.assign(LIMITS, { importRenderedBytes: original });
  }
});

// Fix round 3: long paths amplify stored placements; HTML replay must reuse parsed text.
test("fix3: refuses 47 long-path file threads across 1000 revisions without database writes", async () => {
  const input = ImportBundle.parse(await bundle(f));
  const revision = required(input.revisions[0]),
    writeup = required(input.writeups[0]),
    thread = required(input.threads[0]);
  input.revisions = Array.from({ length: 1000 }, (_, i) => ({ ...revision, id: randomUUID(), seq: i + 1 }));
  input.writeups = input.revisions.map((r) => ({ ...writeup, id: randomUUID(), revisionId: r.id }));
  const path = longPath(".md");
  expect(path.length).toBe(4095);
  input.files = [
    {
      ...required(input.files[0]),
      revisionId: required(input.revisions[0]).id,
      path,
      newBlob: await f.deps.blobs.put(f.ownerId, Buffer.from("needle"), "text/markdown"),
    },
  ];
  input.threads = Array.from({ length: 47 }, () => ({
    ...thread,
    id: randomUUID(),
    createdRevisionId: required(input.revisions[0]).id,
    target: { kind: "file", path },
  }));
  input.topics = [];
  input.comments = [];
  input.sends = [];
  input.deliveries = [];
  const transaction = vi.spyOn(f.db, "transaction");
  const before = await snapshot(f);
  await error(await f.importRequest("/import", input), 413, "too_large");
  expect(transaction).not.toHaveBeenCalled();
  expect(await snapshot(f)).toEqual(before);
});
async function htmlReplay() {
  const input = ImportBundle.parse(await bundle(f));
  const doc = required(input.files[0]);
  input.files = input.revisions.map((r) => ({ ...doc, id: randomUUID(), revisionId: r.id }));
  for (const thread of input.threads)
    thread.target = { kind: "html-span", path: doc.path, quote: "Synthetic doc", prefix: "", suffix: "" };
  return input;
}
test("fix3: an unchanged HTML doc is parsed once across revisions", async () => {
  const input = await htmlReplay();
  const parse = vi.spyOn(core, "docText");
  expect((await f.importRequest("/import", input)).status).toBe(201);
  expect(parse).toHaveBeenCalledTimes(1);
});
test("fix3: placement byte overflow writes no rows", async () => {
  const input = await htmlReplay();
  // Measure the actual jobs: the refusal must depend on the cache hit's text
  // and encoded payload, rather than its metadata alone.
  let fullCost = 0,
    cachedCharges = 0;
  const place = importPlacements();
  for (const revision of indexImportBundle(ImportBundle.parse(input)).revisions.values())
    await place(
      revision,
      { renderedBlob: "unused", docBlobs: new Map() },
      async (hash) => Uint8Array.from(required((await f.deps.blobs.get(f.ownerId, hash)) ?? undefined)).buffer,
      async (work) => {
        chargePlacementMetadata(work, (bytes) => {
          fullCost += bytes;
        });
        if (work.kind === "placement-doc") fullCost += work.bytes.byteLength;
        if (work.kind === "place") {
          cachedCharges = 0;
          for (const doc of new Set(work.parsedDocs?.values())) cachedCharges += doc.encodedBytes;
          for (const thread of work.threads)
            if (thread.target.kind === "html-span")
              cachedCharges += required(work.parsedDocs?.get(thread.target.path)).textBytes;
          fullCost += cachedCharges;
        }
        return executeWork(work);
      },
    );
  const withoutCachedCharges = fullCost - cachedCharges;
  const budget = Math.floor((withoutCachedCharges + fullCost) / 2);
  console.info(`breaker cache-hit: ${JSON.stringify({ withoutCachedCharges, fullCost, cachedCharges, budget })}`);
  expect(budget).toBeGreaterThan(withoutCachedCharges);
  expect(budget).toBeLessThan(fullCost);
  const original = Reflect.get(LIMITS, "importPlacementBytes");
  const before = await snapshot(f);
  // The first parse, scan and job metadata fit; the second cached scan/job must
  // still be charged. Cached source bytes alone would fit indefinitely.
  const jobs = vi.fn(required(f.deps.publishExecutor));
  f.deps.publishExecutor = jobs;
  Object.assign(LIMITS, { importPlacementBytes: budget });
  try {
    await error(await f.importRequest("/import", input), 413, "too_large");
    expect(jobs.mock.calls.filter(([work]) => work.kind === "place")).toHaveLength(1);
    expect(jobs.mock.calls.filter(([work]) => work.kind === "placement-doc")).toHaveLength(1);
    expect(await snapshot(f)).toEqual(before);
  } finally {
    if (original === undefined) Reflect.deleteProperty(LIMITS, "importPlacementBytes");
    else Object.assign(LIMITS, { importPlacementBytes: original });
  }
});
test.each(["place", "placement-doc"])(
  "fix3: abort during %s preserves the import cancel message and writes no rows",
  async (phase) => {
    const input = await htmlReplay();
    const entered = Promise.withResolvers<void>(),
      resume = Promise.withResolvers<void>();
    const run = f.deps.publishExecutor;
    if (!run) throw new Error("Missing executor");
    f.deps.publishExecutor = async (work) => {
      if (work.kind === phase) {
        entered.resolve();
        await resume.promise;
      }
      return run(work);
    };
    const before = await snapshot(f);
    const abort = new AbortController();
    const pending = f.importRequest("/import", input, abort.signal);
    onTestFinished(async () => {
      abort.abort();
      resume.resolve();
      await pending;
    });
    await entered.promise;
    abort.abort();
    try {
      const response = await pending;
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { message: "The import was cancelled." } });
      expect(await snapshot(f)).toEqual(before);
    } finally {
      resume.resolve();
    }
  },
);

test("fix4: the multibyte caps fixture just under derivedBytes imports with the production writer", async () => {
  const { input, derivedBytes } = await multibyteCapsBundle(f);
  const before = await snapshot(f);
  const spy = vi.spyOn(f.db, "transaction");
  expect((await f.importRequest("/import", input)).status).toBe(201);
  expect(spy).toHaveBeenCalledTimes(1);
  const after = await snapshot(f);
  expect(after.reduce((sum, row, i) => sum + (row?.n ?? 0) - (before[i]?.n ?? 0), 0)).toBe(50000);
  expect(await storedDerivedBytes(input.review.id)).toBe(derivedBytes);
}, 90_000);

test("fix3: changed-block bytes are checked after rendering and before a writer transaction", async () => {
  const input = ImportBundle.parse(await bundle(f));
  input.threads = [];
  input.comments = [];
  input.sends = [];
  input.deliveries = [];
  required(input.writeups[1]).sourceBlob = await f.deps.blobs.put(
    f.ownerId,
    Buffer.from(JSON.stringify({ overview: "Updated writeup", tldr: "", decisions: null, topics: {} })),
    "application/json",
  );
  const original = LIMITS.importDerivedBytes;
  Object.assign(LIMITS, { importDerivedBytes: 128 }); // Less than even one changed-block row including its ids.
  const before = await snapshot(f);
  const transaction = vi.spyOn(f.db, "transaction");
  const stage = vi.spyOn(f.deps.blobs, "stage");
  try {
    await error(await f.importRequest("/import", input), 413, "too_large");
    expect(stage).toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(await snapshot(f)).toEqual(before);
  } finally {
    Object.assign(LIMITS, { importDerivedBytes: original });
  }
});
test("fix3: parsed documents are evicted after leaving the current/previous revisions", async () => {
  const input = await htmlReplay();
  const doc = required(input.files[0]),
    revision = required(input.revisions[0]),
    writeup = required(input.writeups[0]);
  for (const seq of [3, 4]) {
    const id = randomUUID();
    input.revisions.push({ ...revision, id, seq });
    input.writeups.push({ ...writeup, id: randomUUID(), revisionId: id });
  }
  input.files = [doc, { ...doc, id: randomUUID(), revisionId: required(input.revisions[3]).id }];
  const parse = vi.spyOn(core, "docText");
  expect((await f.importRequest("/import", input)).status).toBe(201);
  expect(parse).toHaveBeenCalledTimes(2);
});

test("fix3: production placement budget rejects repeated scans before placing the revision", async () => {
  const input = await htmlReplay();
  const hash = await f.deps.blobs.put(
    f.ownerId,
    Buffer.from(`<p>needle${"x".repeat(2 * 1024 * 1024)}</p>`),
    "text/html",
  );
  for (const doc of input.files) doc.newBlob = hash;
  const thread = required(input.threads[0]);
  input.threads = Array.from({ length: 1000 }, (_, i) => ({
    ...thread,
    id: i ? randomUUID() : thread.id,
    target: { kind: "html-span", path: "doc.html", quote: "needle", prefix: "", suffix: "" },
  }));
  const run = f.deps.publishExecutor;
  if (!run) throw new Error("Missing executor");
  const execute = vi.fn(run);
  f.deps.publishExecutor = execute;
  const before = await snapshot(f);
  expect(LIMITS.importPlacementBytes).toBe(1073741824);
  await error(await f.importRequest("/import", input), 413, "too_large");
  expect(execute.mock.calls.filter(([work]) => work.kind === "placement-doc")).toHaveLength(1);
  expect(execute.mock.calls.filter(([work]) => work.kind === "place")).toHaveLength(0);
  expect(await snapshot(f)).toEqual(before);
});

// Fix round 4 regressions. Read the stored SQLite values independently of the budget code.
async function storedDerivedBytes(reviewId: string) {
  return f.db.read(async (q) => {
    const placements = await q
      .select({
        bytes: sql<number>`coalesce(sum(64 +
      length(cast(${tables.placements.ownerId} as blob)) + length(cast(${tables.placements.reviewId} as blob)) +
      length(cast(${tables.placements.threadId} as blob)) + length(cast(${tables.placements.revisionId} as blob)) +
      length(cast(${tables.placements.status} as blob)) + coalesce(length(cast(${tables.placements.reason} as blob)), 0) +
      coalesce(length(cast(${tables.placements.location} as blob)), 0) +
      coalesce(length(cast(${tables.placements.carried} as blob)), 0)), 0)`,
      })
      .from(tables.placements)
      .where(and(eq(tables.placements.ownerId, f.ownerId), eq(tables.placements.reviewId, reviewId)))
      .get();
    const changed = await q
      .select({
        bytes: sql<number>`coalesce(sum(64 +
      length(cast(${tables.changedBlocks.id} as blob)) + length(cast(${tables.changedBlocks.ownerId} as blob)) +
      length(cast(${tables.changedBlocks.revisionId} as blob)) + length(cast(${tables.changedBlocks.blockId} as blob))), 0)`,
      })
      .from(tables.changedBlocks)
      .innerJoin(tables.revisions, eq(tables.changedBlocks.revisionId, tables.revisions.id))
      .where(
        and(
          eq(tables.changedBlocks.ownerId, f.ownerId),
          eq(tables.revisions.ownerId, f.ownerId),
          eq(tables.revisions.reviewId, reviewId),
        ),
      )
      .get();
    return required(placements).bytes + required(changed).bytes;
  });
}
async function refuseBeforeWriter(input: ImportBundle) {
  expect(ImportBundle.safeParse(input).success).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThanOrEqual(LIMITS.publishJsonBytes);
  expect(importRowCount(input)).toBeLessThan(LIMITS.importRows);
  const before = await snapshot(f);
  // A broken budget must fail the test without actually writing a gigabyte.
  const writer = vi.spyOn(f.db, "transaction").mockRejectedValue(new Error("Unexpected writer entry"));
  await error(await f.importRequest("/import", input), 413, "too_large");
  expect(writer).not.toHaveBeenCalled();
  expect(await snapshot(f)).toEqual(before);
}
test.each(["rename", "rename history", "quotes"] as const)(
  "fix4: exact derived bytes reject the %s amplification shape before the writer",
  async (shape) => {
    const renamed = shape !== "quotes";
    const input = await replayBundle(f, shape === "rename" ? 642 : 1000, shape === "rename" ? 74 : renamed ? 47 : 46);
    const path = renamed ? longPath(".md") : `${'"'.repeat(230)}/${'"'.repeat(230)}/${'"'.repeat(230)}.md`;
    const blob = await f.deps.blobs.put(f.ownerId, Buffer.from("needle"), "text/plain");
    const file = required(input.files[0]);
    input.files = input.revisions.slice(0, shape === "rename history" ? 560 : undefined).map((r, i) => ({
      ...file,
      id: randomUUID(),
      revisionId: r.id,
      role: "diff",
      path: renamed && i === 0 ? "a.md" : path,
      oldPath: renamed && i > 0 ? "a.md" : null,
      status: renamed && i > 0 ? "renamed" : "added",
      newBlob: blob,
    }));
    for (const thread of input.threads) thread.target = { kind: "file", path: renamed ? "a.md" : path };
    const jobs = vi.fn(required(f.deps.publishExecutor));
    f.deps.publishExecutor = jobs;
    await refuseBeforeWriter(input);
    expect(jobs.mock.calls.filter(([work]) => work.kind === "writeup").length).toBeLessThan(input.revisions.length);
  },
  90_000,
);

test.each([0, -1])(
  "fix4: a long-to-short rename counts the stored paths and every column (budget offset %i)",
  async (offset) => {
    const input = await replayBundle(f, 3, 1);
    const path = longPath(".md"),
      file = required(input.files[0]);
    const blob = await f.deps.blobs.put(f.ownerId, Buffer.from("needle"), "text/plain");
    input.files = input.revisions.map((r, i) => ({
      ...file,
      id: randomUUID(),
      revisionId: r.id,
      role: "diff",
      path: i ? "a" : path,
      oldPath: i ? path : null,
      status: i ? "renamed" : "added",
      newBlob: blob,
    }));
    required(input.threads[0]).target = { kind: "file", path };
    const bytes =
      placementStorage({ kind: "file", path }, { path }) +
      2 * placementStorage({ kind: "file", path: "a" }, { path: "a" });
    const original = LIMITS.importDerivedBytes;
    Object.assign(LIMITS, { importDerivedBytes: bytes + offset });
    try {
      if (offset) await refuseBeforeWriter(input);
      else {
        expect((await f.importRequest("/import", input)).status).toBe(201);
        expect(await storedDerivedBytes(input.review.id)).toBe(bytes);
      }
    } finally {
      Object.assign(LIMITS, { importDerivedBytes: original });
    }
  },
);

test.each(["writeup", "lines"] as const)(
  "fix4: production placement budget rejects repeated %s work without rows",
  async (kind) => {
    const input = await replayBundle(f, kind === "writeup" ? 25 : 14, kind === "writeup" ? 50 : 40);
    if (kind === "writeup") {
      const source = { overview: `needle${"x".repeat(1024 * 1024 - 6)}`, tldr: "", decisions: null, topics: {} };
      const rendered = await core.renderWriteup(source, []);
      const block = required(rendered.sections.flatMap((s) => s.blocks).find((b) => b.text.startsWith("needle")));
      const hash = await f.deps.blobs.put(f.ownerId, Buffer.from(JSON.stringify(source)), "application/json");
      for (const writeup of input.writeups) writeup.sourceBlob = hash;
      for (const thread of input.threads)
        thread.target = { kind: "writeup-span", blockId: block.id, quote: "needle", prefix: "", suffix: "" };
      input.files = [];
      // Reuse the deterministic renderer result; placement still receives the full real text.
      f.deps.publishExecutor = async (work) =>
        work.kind === "writeup" ? { kind: "writeup", ...serializeRendered(rendered) } : executeWork(work);
    } else {
      const hashes = await Promise.all(
        ["x", "y"].map((c) =>
          f.deps.blobs.put(f.ownerId, Buffer.from(`needle\n${c.repeat(LIMITS.diffSideBytes - 7)}`), "text/plain"),
        ),
      );
      const file = required(input.files[0]);
      input.files = input.revisions.map((r, i) => ({
        ...file,
        id: randomUUID(),
        revisionId: r.id,
        role: "diff",
        path: "a",
        status: "added",
        newBlob: required(hashes[i % 2]),
      }));
      for (const thread of input.threads)
        thread.target = {
          kind: "lines",
          path: "a",
          side: "new",
          start: 1,
          end: 1,
          lines: ["needle"],
          before: [],
          after: [],
        };
      // Avoid minutes of repeated lineMap work in a budget test. Validate one real job,
      // then replay its deterministic placements while retaining the actual side buffers.
      let placed: Awaited<ReturnType<typeof executeWork>> | undefined;
      f.deps.publishExecutor = async (work) => {
        if (work.kind !== "place") return executeWork(work);
        placed ??= await executeWork(work);
        return placed;
      };
    }
    const run = required(f.deps.publishExecutor);
    const jobs = vi.fn(run);
    f.deps.publishExecutor = jobs;
    expect(LIMITS.importPlacementBytes).toBe(1073741824);
    await refuseBeforeWriter(input);
    expect(jobs.mock.calls.filter(([work]) => work.kind === "place").length).toBeLessThan(input.revisions.length);
  },
  90_000,
);

test.each(["file metadata", "target metadata", "topic metadata", "decoded sides"] as const)(
  "fix4: placement charges %s before worker dispatch",
  async (kind) => {
    const input = await replayBundle(f, 1, kind === "decoded sides" ? 2 : 1);
    const file = required(input.files[0]);
    input.files = [];
    if (kind === "file metadata")
      input.files = [{ ...file, revisionId: required(input.revisions[0]).id, path: longPath(".html") }];
    if (kind === "topic metadata")
      input.topics = Array.from({ length: 200 }, (_, i) => ({
        id: randomUUID(),
        revisionId: required(input.revisions[0]).id,
        slug: `topic-${i}-${"a".repeat(50)}`,
        title: "Synthetic",
        importance: 1,
        summary: "Synthetic",
      }));
    if (kind === "target metadata" || kind === "decoded sides") {
      const bytes =
        kind === "decoded sides"
          ? Buffer.concat([Buffer.from("needle\n"), Buffer.alloc(1000, 255)])
          : Buffer.from(`needle\n${"x".repeat(2000)}`);
      const hash = await f.deps.blobs.put(f.ownerId, bytes, "text/plain");
      input.files = [
        {
          ...file,
          revisionId: required(input.revisions[0]).id,
          role: "diff",
          status: "added",
          path: "a",
          newBlob: hash,
        },
      ];
      for (const thread of input.threads)
        thread.target = {
          kind: "lines",
          path: "a",
          side: "new",
          start: 1,
          end: 1,
          lines: ["needle"],
          before: [],
          after: kind === "target metadata" ? ["x".repeat(2000)] : [],
        };
    }
    const original = LIMITS.importPlacementBytes;
    // Side buffers and next-side scans alone fit the metadata case; decoded replacements
    // exceed 8000 even though the raw buffers and raw-length scans would fit.
    Object.assign(LIMITS, {
      importPlacementBytes: kind === "decoded sides" ? 8000 : kind === "target metadata" ? 6000 : 5000,
    });
    const jobs = vi.fn(required(f.deps.publishExecutor));
    f.deps.publishExecutor = jobs;
    try {
      await refuseBeforeWriter(input);
      expect(jobs.mock.calls.filter(([work]) => work.kind === "place")).toHaveLength(0);
    } finally {
      Object.assign(LIMITS, { importPlacementBytes: original });
    }
  },
);

test("breaker: 10000 comments share one large target", async () => {
  const { input, thread } = await sharedTargetBundle(f);
  expect(ImportBundle.safeParse(input).success).toBe(true);
  const bodyBytes = Buffer.byteLength(JSON.stringify(input));
  expect(bodyBytes).toBeLessThan(LIMITS.publishJsonBytes);
  expect(payload.envelopeBytes + 100 * payload.commentReserve(thread.target, "x")).toBeLessThan(LIMITS.handoffBytes);
  const execute = workerExecutor();
  f.deps.publishExecutor = execute;
  const reserve = vi.spyOn(payload, "commentTargetReserve");
  try {
    const response = await f.importRequest("/import", input);
    expect(response.status).toBe(201);
    expect(reserve).toHaveBeenCalledTimes(1);
  } finally {
    await execute.close();
  }
}, 60_000);

test.each([
  { sequence: "aaaaaa", parsed: ["a"] },
  { sequence: "aabacca", parsed: ["a", "b", "c", "a"] },
])("breaker: source cache retains only current and previous revisions ($sequence)", async ({ sequence, parsed }) => {
  const input = await replayBundle(f, sequence.length, 0);
  input.files = [];
  const hashes = new Map<string, string>();
  for (const key of new Set(sequence))
    hashes.set(
      key,
      await f.deps.blobs.put(
        f.ownerId,
        Buffer.from(
          JSON.stringify({
            overview: key,
            tldr: "",
            decisions: null,
            topics: {},
            junk: [[[]]],
          }),
        ),
        "application/json",
      ),
    );
  for (const [i, row] of input.writeups.entries()) row.sourceBlob = required(hashes.get(required(sequence[i])));
  const run = required(f.deps.publishExecutor);
  const sources: string[] = [];
  f.deps.publishExecutor = async (work) => {
    const result = await run(work);
    if (result.kind === "writeup-source") {
      expect(result.source).not.toHaveProperty("junk");
      sources.push(result.source.overview);
    }
    return result;
  };
  expect((await f.importRequest("/import", input)).status).toBe(201);
  expect(sources).toEqual(parsed);
});

test.each(["malformed", "invalid", "timeout", "worker failure", "cancelled"])(
  "breaker: invalid writeup source leaves no rows (%s)",
  async (kind) => {
    const input = await replayBundle(f, 1, 0);
    input.files = [];
    if (kind === "malformed" || kind === "invalid")
      required(input.writeups[0]).sourceBlob = await f.deps.blobs.put(
        f.ownerId,
        Buffer.from(kind === "malformed" ? "{" : "{}"),
        "application/json",
      );
    const abort = new AbortController();
    const run = required(f.deps.publishExecutor);
    f.deps.publishExecutor = async (work) => {
      if (work.kind === "writeup-source") {
        if (kind === "cancelled") abort.abort();
        if (kind === "timeout") throw new WorkTimeout();
        if (kind === "worker failure" || kind === "cancelled") throw new Error("Worker failed");
      }
      return run(work);
    };
    const before = await snapshot(f);
    const writer = vi.spyOn(f.db, "transaction");
    const response = await f.importRequest("/import", input, abort.signal);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: "invalid_request",
        ...(kind === "cancelled" ? { message: "The import was cancelled." } : {}),
      },
    });
    expect(writer).not.toHaveBeenCalled();
    expect(await snapshot(f)).toEqual(before);
  },
);

test("breaker: repeated nested-array writeup source", async () => {
  const input = await nestedSourceBundle(f);
  const execute = workerExecutor();
  let parses = 0;
  f.deps.publishExecutor = (work) => {
    if (work.kind === "writeup-source") parses++;
    return execute(work);
  };
  const before = await snapshot(f);
  const writer = vi.spyOn(f.db, "transaction");
  try {
    const response = await f.importRequest("/import", input);
    expect([201, 400]).toContain(response.status);
    if (response.status === 400) {
      expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
      expect(writer).not.toHaveBeenCalled();
      expect(await snapshot(f)).toEqual(before);
    }
    expect(parses).toBe(1);
  } finally {
    await execute.close();
  }
}, 60_000);

test("breaker: cancellation between payload copies stops before copying or dispatching more", async () => {
  const input = await escapedHtmlBundle(f, 2, 10);
  const abort = new AbortController();
  const cached = new Set<ArrayBuffer>();
  const run = required(f.deps.publishExecutor);
  const jobs = vi.fn(async (work: Parameters<typeof run>[0]) => {
    const result = await run(work);
    if (result.kind === "placement-doc") cached.add(result.bytes);
    return result;
  });
  f.deps.publishExecutor = jobs;
  const slice = ArrayBuffer.prototype.slice;
  let copies = 0;
  vi.spyOn(ArrayBuffer.prototype, "slice").mockImplementation(function (this: ArrayBuffer, ...args) {
    const copied = slice.apply(this, args);
    if (cached.has(this) && ++copies === 1) setImmediate(() => abort.abort());
    return copied;
  });
  const before = await snapshot(f);
  const writer = vi.spyOn(f.db, "transaction");
  const response = await f.importRequest("/import", input, abort.signal);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { message: "The import was cancelled." } });
  expect(copies).toBe(1);
  expect(jobs.mock.calls.filter(([work]) => work.kind === "place")).toHaveLength(0);
  expect(writer).not.toHaveBeenCalled();
  expect(await snapshot(f)).toEqual(before);
});

test("breaker: 26 escaped-control HTML docs yield between payload copies", async () => {
  const input = await escapedHtmlBundle(f, 26, 5_000_000);
  const execute = workerExecutor();
  const cached = new Set<ArrayBuffer>();
  f.deps.publishExecutor = async (work) => {
    const result = await execute(work);
    if (result.kind === "placement-doc") cached.add(result.bytes);
    return result;
  };
  const slice = ArrayBuffer.prototype.slice;
  let copies = 0,
    awaitingYield = false;
  vi.spyOn(ArrayBuffer.prototype, "slice").mockImplementation(function (this: ArrayBuffer, ...args) {
    if (cached.has(this)) {
      expect(awaitingYield, "each payload copy must yield before the next copy").toBe(false);
      copies++;
      awaitingYield = true;
      setImmediate(() => {
        awaitingYield = false;
      });
    }
    return slice.apply(this, args);
  });
  try {
    const response = await f.importRequest("/import", input);
    expect(response.status).toBe(201);
    expect(copies).toBe(26);
    expect(awaitingYield).toBe(false);
  } finally {
    await execute.close();
  }
}, 120_000);

// Round 5: these histories used to expand a shared deletion map once per thread.
test.each(metadataShapes)(
  "fix5: shared metadata imports $label",
  async (shape) => {
    const input = await metadataBundle(f, shape);
    expect(ImportBundle.safeParse(input).success).toBe(true);
    const bodyBytes = Buffer.byteLength(JSON.stringify(input));
    expect(bodyBytes).toBeLessThanOrEqual(LIMITS.publishJsonBytes);
    const execute = workerExecutor();
    let metadataBytes = 0;
    f.deps.publishExecutor = (work) => {
      if (work.kind === "place")
        chargePlacementMetadata(work, (bytes) => {
          metadataBytes += bytes;
        });
      return execute(work);
    };
    const original = LIMITS.importPlacementBytes;
    try {
      // Far below the old per-thread expansion, comfortably above two shared maps.
      Object.assign(LIMITS, { importPlacementBytes: 32 * 1024 * 1024 });
      const response = await f.importRequest("/import", input);
      expect(response.status).toBe(201);
      expect(metadataBytes).toBeLessThan(32 * 1024 * 1024);
      // The very same shape must fail before entering the writer if its shared metadata cannot fit.
      input.review.id = randomUUID();
      input.review.reviewKey = "d".repeat(64);
      for (const row of [...input.revisions, ...input.threads]) row.reviewId = input.review.id;
      Object.assign(LIMITS, { importPlacementBytes: 100 });
      await refuseBeforeWriter(input);
    } finally {
      Object.assign(LIMITS, { importPlacementBytes: original });
      await execute.close();
    }
  },
  60_000,
);

test.each(unchangedSideShapes)(
  "fix5: unchanged sides import 40 revisions with $threads threads on ten $sideBytes-byte files",
  async (shape) => {
    const input = await unchangedSidesBundle(f, shape);
    const execute = workerExecutor();
    f.deps.publishExecutor = execute;
    try {
      const response = await f.importRequest("/import", input);
      expect(response.status).toBe(201);
    } finally {
      await execute.close();
    }
  },
  60_000,
);

test.each([8, 6])(
  "fix5: shared parsed payloads pay once per job, including cache hits (%i MiB budget)",
  async (mib) => {
    const input = await replayBundle(f, 2, 2);
    const hash = await f.deps.blobs.put(
      f.ownerId,
      Buffer.from(`<p>needle${"x".repeat(1024 * 1024 - 6)}</p>`),
      "text/html",
    );
    const file = required(input.files[0]);
    input.files = input.revisions.flatMap((r) =>
      ["a.html", "b.html"].map((path, ord) => ({
        ...file,
        id: randomUUID(),
        revisionId: r.id,
        path,
        ord,
        newBlob: hash,
      })),
    );
    for (const [i, thread] of input.threads.entries())
      thread.target = {
        kind: "html-span",
        path: i ? "b.html" : "a.html",
        quote: "needle",
        prefix: "",
        suffix: "",
      };
    const execute = workerExecutor();
    let parses = 0,
      places = 0;
    f.deps.publishExecutor = async (work) => {
      if (work.kind === "placement-doc") parses++;
      if (work.kind === "place") {
        places++;
        const docs = [...(work.parsedDocs?.values() ?? [])];
        expect(docs).toHaveLength(2);
        expect(docs[0]).toBe(docs[1]);
        expect(docs[0]).toMatchObject({
          bytes: expect.any(ArrayBuffer),
          encodedBytes: expect.any(Number),
          textBytes: 1024 * 1024,
        });
        expect(docs[0]).not.toHaveProperty("doc");
      }
      return execute(work);
    };
    const original = LIMITS.importPlacementBytes;
    Object.assign(LIMITS, { importPlacementBytes: mib * 1024 * 1024 });
    try {
      if (mib === 8) expect((await f.importRequest("/import", input)).status).toBe(201);
      else await refuseBeforeWriter(input);
      expect(parses).toBe(1);
      expect(places).toBe(mib === 8 ? 2 : 1);
    } finally {
      Object.assign(LIMITS, { importPlacementBytes: original });
      await execute.close();
    }
  },
);

test("a repeated import of a review deleted on the hub is skipped as deleted and brings nothing back", async () => {
  const input = await bundle(f);
  expect((await f.importRequest("/import", input)).status).toBe(201);
  expect((await f.request(`/reviews/${input.review.id}`, "DELETE")).status).toBe(204);
  const before = await snapshot(f);
  const retry = await f.importRequest("/import", input);
  expect(retry.status).toBe(200);
  expect(await retry.json()).toEqual({ skipped: true, deleted: true });
  expect(await snapshot(f)).toEqual(before);
  await error(await f.request(`/reviews/${input.review.id}`, "GET"), 404, "unknown_review");
});

test("import carries cleaned doc titles and derives headings from source instead of copied declarations", async () => {
  const input = await bundle(f);
  const doc = required(input.files[0]);
  const newBlob = await f.deps.blobs.put(f.ownerId, Buffer.from("<h1>Own title</h1><h2>Real part</h2>"), "text/html");
  const row = {
    ...doc,
    newBlob,
    title: " Named\u200b\u202e\u0007 doc ",
    headings: [{ level: 9, text: "Forged", id: "thread-foreign" }],
  };
  const response = await f.importRequest("/import", { ...input, files: [row] });
  expect(response.status).toBe(201);
  const stored = await f.db.read((q) =>
    q
      .select()
      .from(tables.files)
      .where(and(eq(tables.files.ownerId, f.ownerId), eq(tables.files.id, doc.id)))
      .get(),
  );
  expect(stored).toMatchObject({ title: "Named doc", headings: [{ level: 2, text: "Real part" }] });
  const view = RevisionView.parse(await (await f.request(`/reviews/${input.review.id}/revisions/1`, "GET")).json());
  expect(view.docs[0]).toMatchObject({ title: "Named doc", headings: [{ level: 2, text: "Real part" }] });
});

test.each([new Uint8Array([255]), new Uint8Array([97, 0])])("import refuses non-text source blobs", async (bytes) => {
  const input = await bundle(f);
  const hash = await f.deps.blobs.put(f.ownerId, Buffer.from(bytes), "text/plain");
  const response = await f.importRequest("/import", {
    ...input,
    files: input.files.map((file) => ({
      ...file,
      path: "sample.ts",
      view: "source",
      mediaType: "text/plain",
      newBlob: hash,
    })),
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: { code: "invalid_request", message: "The request is invalid." } });
});
