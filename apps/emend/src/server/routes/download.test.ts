import { randomUUID } from "node:crypto";
import { LIMITS, type PublishRequest, PublishResponse, RevisionView, reviewDownloadPath } from "@emend/contract";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { files, reviews, revisions, writeups } from "../../db/schema.ts";
import type { AppEnv } from "../auth/principal.ts";
import { DOWNLOAD_CSP } from "../http/headers.ts";
import { publishReview } from "../mailbox/lifecycle-support.ts";
import { error, mailboxFixture } from "../mailbox/test-support.ts";
import { downloadRoutes } from "./download.ts";

let f: Awaited<ReturnType<typeof mailboxFixture>>;
beforeEach(async () => {
  f = await mailboxFixture();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await f.cleanup();
});
const blank = { overview: "", tldr: "", decisions: null, topics: {} };
const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");
const get = (reviewId: string, seq: string | number = 1, who: "reviewer" | "foreign" | "agent" = "reviewer") =>
  f.request(`/reviews/${reviewId}/revisions/${seq}/download`, "GET", undefined, who);
async function publish(input: Partial<PublishRequest> = {}) {
  const response = await f.request(
    "/publish",
    "POST",
    {
      reviewKey: "b".repeat(64),
      repo: null,
      branch: "feature",
      title: "Export example",
      base: null,
      head: null,
      topics: [],
      files: [],
      writeup: { ...blank, overview: "First revision text" },
      ...input,
    },
    "agent",
  );
  expect(response.status).toBe(200);
  return PublishResponse.parse(await response.json());
}
async function mediaReview() {
  const hash = await f.deps.blobs.put(f.ownerId, png, "image/png");
  const published = await publish({
    writeup: { ...blank, overview: "![Small image](media/a.png)\n\n![Again](media/a.png)" },
    files: [{ path: "media/a.png", role: "asset", oldPath: null, oldBlob: null, newBlob: hash, flag: null }],
  });
  return { ...published, hash };
}
function budgetApp(budget: number) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("principal", {
      ownerId: f.ownerId,
      tokenId: randomUUID(),
      kind: "reviewer",
      instanceId: null,
      scopes: ["read"],
    });
    await next();
  });
  downloadRoutes(app, f.deps, budget);
  return app;
}

test("downloads an attachment with all offline response headers for a reviewer", async () => {
  const { reviewId } = await publish();
  const response = await get(reviewId);
  expect(response.status).toBe(200);
  for (const [name, value] of Object.entries({
    "Content-Type": "text/html; charset=utf-8",
    "Content-Disposition": 'attachment; filename="export-example-r1.html"',
    "Content-Security-Policy": DOWNLOAD_CSP,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    "Cross-Origin-Resource-Policy": "same-origin",
  }))
    expect(response.headers.get(name)).toBe(value);
  expect(await response.text()).toContain("First revision text");
});

test("returns HEAD download headers without building or reading blobs", async () => {
  const { reviewId } = await mediaReview();
  const download = await get(reviewId);
  expect(download.status).toBe(200);
  const reads = vi.spyOn(f.deps.blobs, "get");
  const response = await f.request(`/reviews/${reviewId}/revisions/1/download`, "HEAD");
  expect(response.status).toBe(200);
  for (const name of [
    "Content-Type",
    "Content-Disposition",
    "Content-Security-Policy",
    "X-Content-Type-Options",
    "Cache-Control",
    "Cross-Origin-Resource-Policy",
  ])
    expect(response.headers.get(name)).toBe(download.headers.get(name));
  expect(await response.text()).toBe("");
  expect(reads).not.toHaveBeenCalled();
});

test("checks reviewer access ownership revision and bin state for HEAD downloads", async () => {
  const { reviewId } = await publish();
  const path = `/reviews/${reviewId}/revisions/1/download`;
  const reads = vi.spyOn(f.deps.blobs, "get");
  expect((await f.request(path, "HEAD", undefined, "agent")).status).toBe(403);
  expect((await f.request(path, "HEAD", undefined, "foreign")).status).toBe(404);
  for (const seq of [0, 2, "abc"])
    expect((await f.request(`/reviews/${reviewId}/revisions/${seq}/download`, "HEAD")).status).toBe(404);
  expect((await f.request(`/reviews/${reviewId}/bin`, "POST")).status).toBe(204);
  expect((await f.request(path, "HEAD")).status).toBe(409);
  expect(reads).not.toHaveBeenCalled();
});

test("limits concurrent downloads per owner and releases the slot when a build finishes", async () => {
  const { reviewId } = await mediaReview();
  const other = await publish({ reviewKey: "c".repeat(64) });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const read = f.deps.blobs.get.bind(f.deps.blobs);
  const reads = vi.spyOn(f.deps.blobs, "get").mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return read(...args);
  });
  const first = Promise.resolve(get(reviewId));
  try {
    await Promise.race([
      entered.promise,
      first.then(() => {
        throw new Error("Download finished before reaching the blob read");
      }),
    ]);
    const second = await get(other.reviewId);
    expect(second.status).toBe(429);
    expect(await second.json()).toEqual({
      error: { code: "rate_limited", message: "A download is already building. Try again when it finishes." },
    });
    const head = await f.request(`/reviews/${reviewId}/revisions/1/download`, "HEAD");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(reads).toHaveBeenCalledTimes(1);
    await error(await get(reviewId, 1, "foreign"), 404, "unknown_review");
  } finally {
    release.resolve();
    await first;
  }
  expect((await first).status).toBe(200);
  expect((await get(other.reviewId)).status).toBe(200);
});

test("releases the owner download slot after a failed build", async () => {
  const { reviewId } = await publish();
  vi.spyOn(f.deps.blobs, "get").mockResolvedValueOnce(null);
  await error(await get(reviewId), 404, "not_found");
  expect((await get(reviewId)).status).toBe(200);
});

test("refuses agent bearers unauthenticated requests and foreign reviews", async () => {
  const { reviewId } = await publish();
  await error(await get(reviewId, 1, "agent"), 403, "forbidden");
  await error(await get(reviewId, 1, "foreign"), 404, "unknown_review");
  await error(await get(randomUUID()), 404, "unknown_review");
  await error(
    await f.app.request(`${f.deps.config.baseUrl}${reviewDownloadPath(reviewId, 1)}`, {
      headers: { Host: "127.0.0.1:3636" },
    }),
    401,
    "unauthorized",
  );
});

test("refuses missing and malformed revision numbers", async () => {
  const { reviewId } = await publish();
  for (const seq of [2, 0, "abc", "01", "9007199254740992"]) await error(await get(reviewId, seq), 404, "not_found");
});

test("refuses a binned review but allows a moved copy", async () => {
  const { reviewId } = await publish();
  expect((await f.request(`/reviews/${reviewId}/bin`, "POST")).status).toBe(204);
  await error(await get(reviewId), 409, "review_in_bin");
  await f.db.query((q) =>
    q
      .update(reviews)
      .set({ movedToUrl: "https://example.com/moved" })
      .where(and(eq(reviews.ownerId, f.ownerId), eq(reviews.id, reviewId))),
  );
  expect((await get(reviewId)).status).toBe(200);
});

test("embeds writeup images without server paths host instance or credentials", async () => {
  const { reviewId } = await mediaReview();
  const html = await (await get(reviewId)).text();
  expect(html).toContain(`data:image/png;base64,${png.toString("base64")}`);
  expect(html).toContain("Small image");
  for (const forbidden of ["/api/v1/", "/content/", new URL(f.deps.config.baseUrl).host, f.deps.instance.name, "em_"])
    expect(html).not.toContain(forbidden);
});

test("downloads the requested revision rather than the newest one", async () => {
  const first = await publish();
  await publish({ reviewId: first.reviewId, writeup: { ...blank, overview: "Second revision text" } });
  const html = await (await get(first.reviewId, 1)).text();
  expect(html).toContain("First revision text");
  expect(html).not.toContain("Second revision text");
});

test("a Markdown pub downloads the main doc or the first doc in file order", async () => {
  const hashes = await Promise.all(
    ["First doc content", "Main doc content"].map((text) =>
      f.deps.blobs.put(f.ownerId, Buffer.from(text), "text/markdown"),
    ),
  );
  const { reviewId } = await publish({
    writeup: blank,
    main: "main.md",
    files: hashes.map((hash, index) => ({
      path: index ? "main.md" : "first.md",
      role: "doc",
      oldPath: null,
      oldBlob: null,
      newBlob: hash,
      flag: null,
    })),
  });
  let html = await (await get(reviewId)).text();
  expect(html).toContain("Main doc content");
  expect(html).not.toContain("First doc content");
  expect(html).not.toContain("Decisions and drift: not written");
  await f.db.query((q) =>
    q
      .update(revisions)
      .set({ main: "writeup" })
      .where(and(eq(revisions.ownerId, f.ownerId), eq(revisions.reviewId, reviewId))),
  );
  html = await (await get(reviewId)).text();
  expect(html).toContain("First doc content");
  expect(html).not.toContain("Main doc content");
});

test("a source pub downloads stored highlighted tokens as escaped text", async () => {
  const hash = await f.deps.blobs.put(f.ownerId, Buffer.from('const tag = "<script>";'), "text/plain");
  const { reviewId } = await publish({
    writeup: blank,
    files: [
      { path: "example.ts", role: "doc", view: "source", oldPath: null, oldBlob: null, newBlob: hash, flag: null },
    ],
  });
  const html = await (await get(reviewId)).text();
  expect(html).toContain('class="shiki em-source"');
  expect(html).toContain("--shiki-light:");
  expect(html).not.toContain("<script>");
});

test("a code review downloads its writeup without its attached doc", async () => {
  const { reviewId } = await publishReview(f, {
    docs: { "plan.md": "Private-to-review doc text" },
    writeup: { ...blank, overview: "The writeup" },
  });
  const html = await (await get(reviewId)).text();
  expect(html).toContain("The writeup");
  expect(html).not.toContain("Private-to-review doc text");
});

test("an HTML pub inlines listed CSS and images while omitting script assets", async () => {
  const entries = [
    {
      path: "doc/index.html",
      role: "doc" as const,
      bytes: Buffer.from(
        '<link rel="stylesheet" href="site.css"><p>HTML publication</p><img src="shot.png"><script src="app.js"></script><script>inlineAttack()</script>',
      ),
    },
    {
      path: "doc/site.css",
      role: "asset" as const,
      bytes: Buffer.from("p{color:green}body{background:url(shot.png)}"),
    },
    { path: "doc/shot.png", role: "asset" as const, bytes: png },
    { path: "doc/app.js", role: "asset" as const, bytes: Buffer.from("scriptAssetAttack()") },
  ];
  const inputs = [];
  for (const entry of entries)
    inputs.push({
      path: entry.path,
      role: entry.role,
      oldPath: null,
      oldBlob: null,
      newBlob: await f.deps.blobs.put(f.ownerId, entry.bytes, "application/octet-stream"),
      flag: null,
      ...(entry.role === "doc"
        ? { assets: entries.slice(1).map((entry) => entry.path) }
        : { parent: "doc/index.html" }),
    });
  const { reviewId } = await publish({ writeup: blank, files: inputs });
  const html = await (await get(reviewId)).text();
  expect(html).toContain("HTML publication");
  expect(html).toContain("p{color:green}");
  expect(html).toContain(`data:image/png;base64,${png.toString("base64")}`);
  for (const forbidden of ["<script", "scriptAssetAttack", "inlineAttack", "site.css", "app.js"])
    expect(html).not.toContain(forbidden);
});

test("leaves an over-budget image out and shows one note", async () => {
  const { reviewId } = await mediaReview();
  const response = await budgetApp(1).request(reviewDownloadPath(reviewId, 1));
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).not.toContain("data:image/png");
  expect(html.match(/Some images or files were left out/g)).toHaveLength(1);
  expect(html).toContain("Small image");
});

test("counts each emitted image copy while reading shared blobs only once", async () => {
  const hash = await f.deps.blobs.put(f.ownerId, png, "image/png");
  const { reviewId } = await publish({
    writeup: { ...blank, overview: "![One](one.png) ![Two](two.png)" },
    files: ["one.png", "two.png"].map((path) => ({
      path,
      role: "asset",
      oldPath: null,
      oldBlob: null,
      newBlob: hash,
      flag: null,
    })),
  });
  const reads = vi.spyOn(f.deps.blobs, "get");
  const inlineBudget = `data:image/png;base64,${png.toString("base64")}`.length;
  const html = await (await budgetApp(inlineBudget).request(reviewDownloadPath(reviewId, 1))).text();
  expect(html.match(/data:image\/png/g)).toHaveLength(1);
  expect(html).toContain("Some images or files were left out");
  expect(reads.mock.calls.filter((call) => call[1] === hash)).toHaveLength(1);
});

test("does not use another revision's media or a parented doc asset", async () => {
  const { reviewId, hash } = await mediaReview();
  await publish({ reviewId, writeup: { ...blank, overview: "Second revision" } });
  const rows = await f.db.read((q) =>
    q
      .select()
      .from(revisions)
      .where(and(eq(revisions.ownerId, f.ownerId), eq(revisions.reviewId, reviewId), eq(revisions.seq, 2)))
      .all(),
  );
  const revisionId = rows[0]?.id;
  if (!revisionId) throw new Error("Missing revision");
  const rendered = {
    sections: [
      {
        key: "overview",
        topic: null,
        label: "Overview",
        blocks: [
          {
            id: "overview-12345678",
            section: "overview",
            kind: "paragraph",
            text: "image",
            html: `<img src="/api/v1/media/${hash}">`,
          },
        ],
      },
    ],
  };
  const renderedBlob = await f.deps.blobs.put(f.ownerId, Buffer.from(JSON.stringify(rendered)), "application/json");
  await f.db.query((q) =>
    q
      .update(writeups)
      .set({ renderedBlob })
      .where(and(eq(writeups.ownerId, f.ownerId), eq(writeups.revisionId, revisionId))),
  );
  expect(await (await get(reviewId, 2)).text()).not.toContain("data:image/png");
  const docId = randomUUID();
  await f.db.query((q) =>
    q.insert(files).values({
      id: docId,
      ownerId: f.ownerId,
      revisionId,
      path: "doc.html",
      role: "doc",
      mediaType: "text/html",
      ord: 0,
    }),
  );
  await f.db.query((q) =>
    q.insert(files).values({
      ownerId: f.ownerId,
      revisionId,
      path: "parented.png",
      role: "asset",
      mediaType: "image/png",
      parentDocId: docId,
      newBlob: hash,
      ord: 1,
    }),
  );
  expect(await (await get(reviewId, 2)).text()).not.toContain("data:image/png");
});

test.each(["not JSON", '{"sections":"invalid"}'])("refuses malformed stored writeup %s", async (content) => {
  const { reviewId } = await publish();
  const hash = await f.deps.blobs.put(f.ownerId, Buffer.from(content), "application/json");
  const revision = await f.db.read((q) =>
    q
      .select()
      .from(revisions)
      .where(and(eq(revisions.ownerId, f.ownerId), eq(revisions.reviewId, reviewId)))
      .get(),
  );
  if (!revision) throw new Error("Missing revision");
  await f.db.query((q) =>
    q
      .update(writeups)
      .set({ renderedBlob: hash })
      .where(and(eq(writeups.ownerId, f.ownerId), eq(writeups.revisionId, revision.id))),
  );
  await error(await get(reviewId), 404, "not_found");
});

test.each([
  ["A title / with: punctuation!", "a-title-with-punctuation"],
  ["日本語", "emend"],
  [`${"a".repeat(59)}-more`, "a".repeat(59)],
])("uses an ASCII filename slug for %s", async (title, slug) => {
  const { reviewId } = await publish({ title });
  const response = await get(reviewId);
  expect(response.headers.get("Content-Disposition")).toBe(`attachment; filename="${slug}-r1.html"`);
});

test.each(
  ["html", "md", "txt"].flatMap((kind) =>
    ["missing", "malformed", "invalid sections"].map((stored) => ({ kind, stored })),
  ),
)("downloads a $kind pub without publish links when its stored writeup is $stored", async ({ kind, stored }) => {
  const hash = await f.deps.blobs.put(
    f.ownerId,
    Buffer.from(kind === "html" ? "<p>Publication content</p>" : "Publication content"),
    kind === "html" ? "text/html" : kind === "txt" ? "text/plain" : "text/markdown",
  );
  const { reviewId } = await publish({
    writeup: blank,
    links: [{ url: "https://example.com/publication", label: "Publication link" }],
    files: [
      {
        path: `doc.${kind}`,
        role: "doc",
        ...(kind === "html" ? { assets: [] } : {}),
        ...(kind === "txt" ? { view: "source" as const } : {}),
        oldPath: null,
        oldBlob: null,
        newBlob: hash,
        flag: null,
      },
    ],
  });
  if (kind !== "html") expect(await (await get(reviewId)).text()).toContain("Publication link");
  const revision = await f.db.read((q) =>
    q
      .select()
      .from(revisions)
      .where(and(eq(revisions.ownerId, f.ownerId), eq(revisions.reviewId, reviewId)))
      .get(),
  );
  if (!revision) throw new Error("Missing revision");
  const owned = and(eq(writeups.ownerId, f.ownerId), eq(writeups.revisionId, revision.id));
  if (stored === "missing") await f.db.query((q) => q.delete(writeups).where(owned));
  else {
    const blob = await f.deps.blobs.put(
      f.ownerId,
      Buffer.from(stored === "malformed" ? "not JSON" : '{"sections":false}'),
      "application/json",
    );
    await f.db.query((q) => q.update(writeups).set({ renderedBlob: blob }).where(owned));
  }
  const response = await get(reviewId);
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain("Publication content");
  expect(html).not.toContain("Publication link");
  expect(html).not.toContain("https://example.com/publication");
  expect(html).not.toContain('class="em-links"');
});

test("downloads an HTML pub without reading an unavailable stored writeup blob", async () => {
  const hash = await f.deps.blobs.put(f.ownerId, Buffer.from("<p>HTML publication content</p>"), "text/html");
  const { reviewId } = await publish({
    writeup: blank,
    links: [{ url: "https://example.com/publication", label: "Publication link" }],
    files: [{ path: "doc.html", role: "doc", assets: [], oldPath: null, oldBlob: null, newBlob: hash, flag: null }],
  });
  const writeup = await f.db.read((q) =>
    q
      .select({ hash: writeups.renderedBlob })
      .from(writeups)
      .innerJoin(revisions, and(eq(revisions.ownerId, f.ownerId), eq(revisions.id, writeups.revisionId)))
      .where(and(eq(writeups.ownerId, f.ownerId), eq(revisions.reviewId, reviewId)))
      .get(),
  );
  if (!writeup) throw new Error("Missing writeup row");
  const read = f.deps.blobs.get.bind(f.deps.blobs);
  const reads = vi.spyOn(f.deps.blobs, "get").mockImplementation(async (ownerId, sha, q) => {
    if (sha === writeup.hash) return null;
    return read(ownerId, sha, q);
  });
  const response = await get(reviewId);
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain("HTML publication content");
  expect(html).not.toContain("Publication link");
  expect(reads.mock.calls.map(([, sha]) => sha)).toEqual([hash]);
});

test("adds an emend header to Markdown and source pubs while preserving an HTML pub's own header", async () => {
  for (const [index, path] of ["doc.html", "doc.md", "doc.txt"].entries()) {
    const hash = await f.deps.blobs.put(
      f.ownerId,
      Buffer.from(
        path.endsWith("html") ? "<header>Author header</header><p>Publication content</p>" : "Publication content",
      ),
      "text/plain",
    );
    const { reviewId } = await publish({
      reviewKey: String(index + 1).repeat(64),
      title: "Publication title",
      writeup: blank,
      links: [{ url: "https://example.com", label: "Publication link" }],
      files: [
        {
          path,
          role: "doc",
          ...(path.endsWith("html") ? { assets: [] } : {}),
          oldPath: null,
          oldBlob: null,
          newBlob: hash,
          flag: null,
        },
      ],
    });
    const html = await (await get(reviewId)).text();
    if (path.endsWith("html")) {
      expect(html).toContain("<header>Author header</header>");
      expect(html).not.toContain('class="em-meta"');
      expect(html).not.toContain("Publication link");
      expect(html).not.toContain("<h1>Publication title</h1>");
    } else {
      expect(html).toContain("<h1>Publication title</h1>");
      expect(html).toContain('class="em-meta"');
      expect(html).toContain("Publication link");
    }
  }
});

test("downloads a review with the maximum declared topics plus the reserved Other topic", async () => {
  const topics = Array.from({ length: LIMITS.topicsPerReview }, (_, index) => ({
    slug: `topic-${index}`,
    title: `Topic ${index}`,
    importance: index % 100,
    summary: "Synthetic topic",
  }));
  const hash = await f.deps.blobs.put(f.ownerId, Buffer.from("synthetic diff"), "text/plain");
  const { reviewId } = await publish({
    topics: [...topics, { slug: "other", title: "Other changes", importance: 100, summary: "Unassigned files" }],
    files: [
      { path: "unassigned.txt", topic: "other", role: "diff", oldPath: null, oldBlob: null, newBlob: hash, flag: null },
    ],
  });
  const view = RevisionView.parse(await (await f.request(`/reviews/${reviewId}/revisions/1`, "GET")).json());
  expect(view.topics).toHaveLength(LIMITS.topicsPerReview + 1);
  const response = await get(reviewId);
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain(`Topic ${LIMITS.topicsPerReview - 1}`);
});
