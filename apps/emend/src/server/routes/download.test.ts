import { randomUUID } from "node:crypto";
import { crc32, inflateRawSync } from "node:zlib";
import { LIMITS, type PublishRequest, PublishResponse, RevisionView, reviewDownloadPath } from "@emend/contract";
import { buildOmittedDownload, buildWriteupDownload, DOWNLOAD_FILE_CSP } from "@emend/core";
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

test("queues two downloads per owner and refuses a fourth while HEAD never waits", async () => {
  const { reviewId } = await mediaReview();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const read = f.deps.blobs.get.bind(f.deps.blobs);
  const reads = vi.spyOn(f.deps.blobs, "get").mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return read(...args);
  });
  const first = Promise.resolve(get(reviewId));
  const pending = [first];
  try {
    await entered.promise;
    pending.push(Promise.resolve(get(reviewId)), Promise.resolve(get(reviewId)));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const fourth = await get(reviewId);
    expect(fourth.status).toBe(429);
    expect(await fourth.json()).toEqual({
      error: { code: "rate_limited", message: "A download is already building. Try again when it finishes." },
    });
    const head = await f.request(`/reviews/${reviewId}/revisions/1/download`, "HEAD");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(reads).toHaveBeenCalledTimes(1);
    await error(await get(reviewId, 1, "foreign"), 404, "unknown_review");
  } finally {
    release.resolve();
    await Promise.all(pending);
  }
  expect((await Promise.all(pending)).map((response) => response.status)).toEqual([200, 200, 200]);
  expect((await get(reviewId)).status).toBe(200);
});

test.each([false, true])("hands the slot to a waiting download after the first build fails: %s", async (fail) => {
  const { reviewId } = await publish();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const read = f.deps.blobs.get.bind(f.deps.blobs);
  vi.spyOn(f.deps.blobs, "get").mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return fail ? null : read(...args);
  });
  const first = Promise.resolve(get(reviewId));
  let second: Promise<Response> | undefined;
  let secondFinished = false;
  try {
    await entered.promise;
    second = Promise.resolve(get(reviewId)).then((response) => {
      secondFinished = true;
      return response;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(secondFinished).toBe(false);
  } finally {
    release.resolve();
    await first;
    await second;
  }
  expect((await first).status).toBe(fail ? 404 : 200);
  expect((await second)?.status).toBe(200);
  expect((await get(reviewId)).status).toBe(200);
});

test("yields to queued event-loop callbacks before a large download completes", async () => {
  const content = Buffer.from(`<style>/*${"x".repeat(2 * 1024 * 1024)}*/</style><p>Large publication</p>`);
  const hash = await f.deps.blobs.put(f.ownerId, content, "text/html");
  const { reviewId } = await publish({
    writeup: blank,
    files: [{ path: "doc.html", role: "doc", assets: [], oldPath: null, oldBlob: null, newBlob: hash, flag: null }],
  });
  const events: string[] = [];
  let duringBuild: Promise<void> | undefined;
  // Keep blob I/O out of the scheduling assertion: the builder must yield on its own.
  vi.spyOn(f.deps.blobs, "get").mockImplementation(async () => {
    duringBuild = new Promise<void>((resolve) => {
      setImmediate(() => {
        events.push("during build");
        resolve();
      });
    });
    return content;
  });
  const beforeRequest = new Promise<void>((resolve) => {
    setImmediate(() => {
      events.push("before request");
      resolve();
    });
  });
  try {
    const response = await get(reviewId);
    events.push("response");
    expect(response.status).toBe(200);
    expect(events).toEqual(["before request", "during build", "response"]);
    expect(await response.text()).toContain("Large publication");
  } finally {
    await beforeRequest;
    await duringBuild;
  }
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
  expect(html.match(/Some content was left out/g)).toHaveLength(1);
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
  expect(html).toContain("Some content was left out");
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

test.each([null, "a".repeat(40)])(
  "downloads an empty writeup's attached doc only without a diff base: %s",
  async (base) => {
    const hash = await f.deps.blobs.put(f.ownerId, Buffer.from("Attached publication"), "text/markdown");
    const { reviewId } = await publish({
      base,
      head: base === null ? null : "b".repeat(40),
      writeup: blank,
      files: [{ path: "doc.md", role: "doc", oldPath: null, oldBlob: null, newBlob: hash, flag: null }],
    });
    const response = await get(reviewId);
    expect(response.status).toBe(200);
    const html = await response.text();
    if (base === null) expect(html).toContain("Attached publication");
    else {
      expect(html).not.toContain("Attached publication");
      expect(html).toContain("<h1>Export example</h1>");
    }
  },
);

test("refuses an asset from its stored size before reading its blob", async () => {
  const { reviewId, hash } = await mediaReview();
  const reads = vi.spyOn(f.deps.blobs, "get");
  const response = await budgetApp(png.byteLength - 1).request(reviewDownloadPath(reviewId, 1));
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("Some content was left out");
  expect(reads.mock.calls.some(([, sha]) => sha === hash)).toBe(false);
});

async function selectedDownload(reviewId: string, ids: readonly string[], method = "GET") {
  return f.request(reviewDownloadPath(reviewId, 1, ids).slice("/api/v1".length), method);
}
async function revisionView(reviewId: string, seq = 1) {
  return RevisionView.parse(await (await f.request(`/reviews/${reviewId}/revisions/${seq}`, "GET")).json());
}
async function zipEntries(response: Response) {
  expect(response.status).toBe(200);
  const bytes = Buffer.from(await response.arrayBuffer());
  const end = bytes.length - 22;
  expect(bytes.readUInt32LE(end)).toBe(0x06054b50);
  let offset = bytes.readUInt32LE(end + 16);
  const entries: { name: string; data: Buffer; html: string }[] = [];
  for (let n = 0; n < bytes.readUInt16LE(end + 10); n++) {
    expect(bytes.readUInt32LE(offset)).toBe(0x02014b50);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const local = bytes.readUInt32LE(offset + 42);
    const start = local + 30 + bytes.readUInt16LE(local + 26);
    const payload = bytes.subarray(start, start + bytes.readUInt32LE(offset + 20));
    const data = bytes.readUInt16LE(offset + 10) === 8 ? inflateRawSync(payload) : payload;
    expect(crc32(data)).toBe(bytes.readUInt32LE(offset + 16));
    expect(data.byteLength).toBe(bytes.readUInt32LE(offset + 24));
    entries.push({
      name: bytes.toString("ascii", offset + 46, offset + 46 + nameLength),
      data,
      html: data.toString("utf8"),
    });
    offset += 46 + nameLength;
  }
  expect(offset).toBe(end);
  return entries;
}
async function docsReview(input: Partial<PublishRequest> = {}) {
  const specs = [
    {
      path: "guide/plan.md",
      text: "# Plan title\n\nA **Markdown** doc. [Visual](visual.html)",
      role: "doc" as const,
    },
    {
      path: "guide/visual.html",
      text: '<title>Visual title</title><style>p{color:green}</style><link rel="stylesheet" href="https://example.com/remote.css"><p>HTML doc</p><img src="shot.png"><script>alert(1)</script><script src="app.js"></script><img src=x onerror=alert(1)><a href="javascript:alert(1)">Bad link</a><img src="https://example.com/remote.png"><a href="plan.md">Plan</a>',
      role: "doc" as const,
      assets: ["guide/shot.png", "guide/app.js"],
    },
    { path: "guide/shot.png", bytes: png, role: "asset" as const, parent: "guide/visual.html" },
    { path: "guide/app.js", text: "scriptAssetAttack()", role: "asset" as const, parent: "guide/visual.html" },
    { path: "shared.png", bytes: png, role: "asset" as const },
  ];
  const inputs: PublishRequest["files"] = [];
  for (const { text, bytes, ...file } of specs) {
    inputs.push({
      ...file,
      oldPath: null,
      oldBlob: null,
      newBlob: await f.deps.blobs.put(f.ownerId, bytes ?? Buffer.from(text ?? ""), "application/octet-stream"),
      flag: null,
    });
  }
  const published = await publish({
    writeup: { ...blank, overview: "First revision text\n\n[Plan](guide/plan.md)\n\n![Writeup image](shared.png)" },
    links: [{ url: "https://example.com/review", label: "Publish link" }],
    files: inputs,
    ...input,
  });
  const view = await revisionView(published.reviewId);
  const [first, second] = view.files.filter((file) => file.role === "doc").map((file) => file.id);
  if (!first || !second) throw new Error("Missing doc ids");
  return { ...published, view, ids: [first, second] as const };
}

test("no selected docs preserves the single HTML status, headers and exact builder bytes", async () => {
  const { reviewId, view } = await docsReview();
  const row = await f.db.read((q) =>
    q
      .select()
      .from(revisions)
      .where(and(eq(revisions.ownerId, f.ownerId), eq(revisions.reviewId, reviewId)))
      .get(),
  );
  if (!row) throw new Error("Missing revision");
  const expected = await buildWriteupDownload({
    title: "Export example",
    details: {
      project: null,
      branch: "feature",
      seq: 1,
      publishedAt: new Date(row.createdAt).toISOString(),
      links: view.links,
    },
    writeup: view.writeup,
    topics: view.topics,
    resolveMedia: async () => ({ bytes: png, mediaType: "image/png" }),
    inlineBudget: LIMITS.downloadInlineBytes,
  });
  const response = await selectedDownload(reviewId, []);
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="export-example-r1.html"');
  expect(response.headers.get("Content-Security-Policy")).toBe(DOWNLOAD_CSP);
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
  expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(expected));
});

test("ZIP keeps the unchanged base and selected offline Markdown and safe HTML in revision order", async () => {
  const { reviewId, ids } = await docsReview();
  const base = await get(reviewId);
  const response = await selectedDownload(reviewId, [...ids].reverse());
  expect(response.headers.get("Content-Type")).toBe("application/zip");
  expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="export-example-r1.zip"');
  for (const name of [
    "Content-Security-Policy",
    "X-Content-Type-Options",
    "Cache-Control",
    "Cross-Origin-Resource-Policy",
  ]) {
    expect(response.headers.get(name)).toBe(base.headers.get(name));
  }
  const entries = await zipEntries(response);
  expect(entries.map(({ name }) => name)).toEqual([
    "export-example-r1.html",
    "docs/guide/plan.md.html",
    "docs/guide/visual.html",
  ]);
  expect(entries[0]?.data).toEqual(Buffer.from(await base.arrayBuffer()));
  expect(entries[0]?.html).toContain("Publish link");
  expect(entries[1]?.html).toContain("<h1>Plan title</h1>");
  expect(entries[1]?.html).toContain("<strong>Markdown</strong>");
  expect(entries[1]?.html).toContain("feature · Revision 1");
  expect(entries[2]?.html).toContain("<title>Visual title</title>");
  expect(entries[2]?.html).toContain("p{color:green}");
  expect(entries[2]?.html).toContain(`data:image/png;base64,${png.toString("base64")}`);
  for (const { html } of entries.slice(1)) {
    expect(html).not.toContain("Publish link");
    for (const forbidden of [
      "<script",
      "onerror",
      "javascript:",
      "remote.css",
      "remote.png",
      "scriptAssetAttack",
      'href="plan.md"',
      'href="visual.html"',
    ])
      expect(html).not.toContain(forbidden);
  }
  for (const { html, data } of entries) {
    expect(data.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(html).toContain(DOWNLOAD_FILE_CSP.replaceAll("'", "&#x27;"));
    for (const forbidden of ["127.0.0.1", "localhost", "/api/v1", "/content/", "em_"])
      expect(html).not.toContain(forbidden);
  }
});

test.each(["missing", "malformed", "invalid"])(
  "exports stored source tokens and tolerates %s source and Markdown rendering",
  async (kind) => {
    const source = await f.deps.blobs.put(f.ownerId, Buffer.from('const value = "<script>";'), "text/plain");
    const markdown = await f.deps.blobs.put(
      f.ownerId,
      Buffer.from("# Original doc\n\nOriginal paragraph"),
      "text/markdown",
    );
    const { reviewId } = await publish({
      files: ["source.ts", "unrendered.ts", "unrendered.md"].map((path) => ({
        path,
        role: "doc",
        oldPath: null,
        oldBlob: null,
        newBlob: path.endsWith(".md") ? markdown : source,
        flag: null,
      })),
    });
    const view = await revisionView(reviewId);
    const hash =
      kind === "missing"
        ? null
        : await f.deps.blobs.put(
            f.ownerId,
            Buffer.from(kind === "malformed" ? "not JSON" : '{"lines":42}'),
            "application/json",
          );
    for (const file of view.files.filter((file) => file.path.startsWith("unrendered"))) {
      await f.db.query((q) =>
        q
          .update(files)
          .set({ renderedBlob: hash })
          .where(and(eq(files.ownerId, f.ownerId), eq(files.id, file.id))),
      );
    }
    const entries = await zipEntries(
      await selectedDownload(
        reviewId,
        view.files.map((file) => file.id),
      ),
    );
    expect(entries).toHaveLength(4);
    expect(entries[1]?.html).toContain('class="shiki em-source"');
    expect(entries[1]?.html).toContain("--shiki-light:");
    expect(entries[1]?.html).toContain("&#x3C;script>");
    expect(entries[1]?.html).not.toContain("<script>");
    expect(entries[2]?.html).toContain("<p>This file could not be shown.</p>");
    expect(entries[2]?.html).not.toContain("<pre");
    expect(entries[3]?.html).not.toContain("Original paragraph");
  },
);

test.each(["guide/visual.html", null])("a pub's ZIP starts with its main or first doc: %s", async (main) => {
  const { reviewId, ids } = await docsReview({ writeup: blank, main: main ?? undefined });
  const base = Buffer.from(await (await get(reviewId)).arrayBuffer());
  const [entry] = await zipEntries(await selectedDownload(reviewId, ids));
  expect(entry?.name).toBe("export-example-r1.html");
  expect(entry?.data).toEqual(base);
  expect(entry?.html).toContain(main ? "HTML doc" : "Markdown");
  expect(entry?.html).not.toContain("First revision text");
});

test("invalid doc query values fail before building or waiting for the download slot", async () => {
  const { reviewId, ids } = await docsReview();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const read = f.deps.blobs.get.bind(f.deps.blobs);
  vi.spyOn(f.deps.blobs, "get").mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return read(...args);
  });
  const building = Promise.resolve(get(reviewId));
  try {
    await entered.promise;
    for (const invalid of [["not-uuid"], Array.from({ length: 51 }, () => randomUUID()), [ids[0], ids[0]]]) {
      await error(await selectedDownload(reviewId, invalid), 400, "invalid_request");
      expect((await selectedDownload(reviewId, invalid, "HEAD")).status).toBe(400);
    }
  } finally {
    release.resolve();
    await building;
  }
});

test("missing, non-doc, other-revision and foreign-owner doc ids are all not_found", async () => {
  const { reviewId, ids } = await docsReview();
  await publish({ reviewId });
  const older = await f.db.read((q) =>
    q
      .select()
      .from(files)
      .where(and(eq(files.ownerId, f.ownerId), eq(files.id, ids[0])))
      .get(),
  );
  if (!older) throw new Error("Missing doc row");
  const foreignId = randomUUID();
  const foreignBlob = await f.deps.blobs.put(f.otherOwnerId, Buffer.from("Foreign synthetic doc"), "text/markdown");
  const foreignReview = randomUUID();
  const foreignRevision = randomUUID();
  await f.db.query((q) =>
    q.insert(reviews).values({
      id: foreignReview,
      ownerId: f.otherOwnerId,
      originInstanceId: f.instanceId,
      reviewKey: "f".repeat(64),
      title: "Foreign synthetic review",
      createdAt: f.deps.now(),
    }),
  );
  await f.db.query((q) =>
    q.insert(revisions).values({
      id: foreignRevision,
      ownerId: f.otherOwnerId,
      reviewId: foreignReview,
      seq: 1,
      contentKey: randomUUID(),
      createdAt: f.deps.now(),
    }),
  );
  await f.db.query((q) =>
    q.insert(files).values({
      ...older,
      id: foreignId,
      revisionId: foreignRevision,
      ownerId: f.otherOwnerId,
      path: "foreign.md",
      newBlob: foreignBlob,
      renderedBlob: null,
    }),
  );
  const asset = await f.db.read((q) =>
    q
      .select({ id: files.id })
      .from(files)
      .where(and(eq(files.ownerId, f.ownerId), eq(files.revisionId, older.revisionId), eq(files.role, "asset")))
      .get(),
  );
  const assetId = asset?.id;
  if (!assetId) throw new Error("Missing asset");
  for (const invalid of [randomUUID(), assetId, foreignId]) {
    await error(await selectedDownload(reviewId, [ids[0], invalid]), 404, "not_found");
    expect((await selectedDownload(reviewId, [invalid], "HEAD")).status).toBe(404);
  }
  const path = reviewDownloadPath(reviewId, 2, [ids[0]]).slice("/api/v1".length);
  await error(await f.request(path, "GET"), 404, "not_found");
  expect((await f.request(path, "HEAD")).status).toBe(404);
});

test("HEAD validates selected docs and returns ZIP headers without blobs or a body", async () => {
  const { reviewId, ids } = await docsReview();
  const getResponse = await selectedDownload(reviewId, ids);
  const reads = vi.spyOn(f.deps.blobs, "get");
  const head = await selectedDownload(reviewId, ids, "HEAD");
  expect(head.status).toBe(200);
  for (const name of [
    "Content-Type",
    "Content-Disposition",
    "Content-Security-Policy",
    "X-Content-Type-Options",
    "Cache-Control",
    "Cross-Origin-Resource-Policy",
  ])
    expect(head.headers.get(name)).toBe(getResponse.headers.get(name));
  expect(await head.text()).toBe("");
  expect(reads).not.toHaveBeenCalled();
});

test("ZIP files share emitted and read budgets, leaving later images out with a note", async () => {
  const { reviewId, ids } = await docsReview();
  const imageHash = await f.db.read((q) =>
    q
      .select({ hash: files.newBlob })
      .from(files)
      .where(and(eq(files.ownerId, f.ownerId), eq(files.path, "shared.png")))
      .get(),
  );
  const complete = await zipEntries(await selectedDownload(reviewId, ids));
  const [base, markdown] = complete;
  if (!base || !markdown) throw new Error("Missing built files");
  const budget = base.data.byteLength + markdown.data.byteLength;
  const reads = vi.spyOn(f.deps.blobs, "get");
  const entries = await zipEntries(await budgetApp(budget).request(reviewDownloadPath(reviewId, 1, ids)));
  expect(entries[0]?.html).toContain("data:image/png");
  expect(entries[2]?.html).not.toContain("data:image/png");
  expect(entries[2]?.html).toContain("Some content was left out of this download");
  expect(reads.mock.calls.filter(([, hash]) => hash === imageHash?.hash)).toHaveLength(1);
});

test("a missing selected HTML blob is not_found, while HEAD still checks only the id", async () => {
  const { reviewId, ids } = await docsReview();
  await f.db.query((q) =>
    q
      .update(files)
      .set({ newBlob: null })
      .where(and(eq(files.ownerId, f.ownerId), eq(files.id, ids[1]))),
  );
  await error(await selectedDownload(reviewId, [ids[1]]), 404, "not_found");
  expect((await selectedDownload(reviewId, [ids[1]], "HEAD")).status).toBe(200);
});

test("selected-doc downloads still reject bearer tokens and missing credentials", async () => {
  const { reviewId, ids } = await docsReview();
  const path = reviewDownloadPath(reviewId, 1, ids);
  await error(await f.request(path.slice("/api/v1".length), "GET", undefined, "agent"), 403, "forbidden");
  await error(
    await f.app.request(`${f.deps.config.baseUrl}${path}`, { headers: { Host: "127.0.0.1:3636" } }),
    401,
    "unauthorized",
  );
});

async function bodyBudgetReview(kind: "html" | "markdown" | "source", bodySize = 16000) {
  const path = kind === "html" ? "budget.html" : kind === "source" ? "budget.txt" : "budget.md";
  const text =
    kind === "html" ? `<p>Budget body</p><!--${"x".repeat(bodySize)}-->` : `Budget body ${"x".repeat(bodySize)}`;
  const hash = await f.deps.blobs.put(f.ownerId, Buffer.from(text), "text/plain");
  const { reviewId } = await publish({
    files: [
      {
        path,
        role: "doc",
        title: "Budget doc",
        oldPath: null,
        oldBlob: null,
        newBlob: hash,
        flag: null,
        ...(kind === "html" ? { assets: [] } : {}),
      },
    ],
  });
  const view = await revisionView(reviewId);
  const id = view.files[0]?.id;
  if (!id) throw new Error("Missing budget doc");
  const row = await f.db.read((q) =>
    q
      .select()
      .from(files)
      .where(and(eq(files.ownerId, f.ownerId), eq(files.id, id)))
      .get(),
  );
  const bodyHash = kind === "html" ? row?.newBlob : row?.renderedBlob;
  if (!bodyHash) throw new Error("Missing doc body");
  const base = Buffer.from(await (await get(reviewId)).arrayBuffer());
  return { reviewId, id, bodyHash, base };
}

test.each(["html", "markdown", "source"] as const)(
  "checks a selected %s doc's stored size before reading its body",
  async (kind) => {
    const { reviewId, id, bodyHash, base } = await bodyBudgetReview(kind);
    const budget = base.byteLength + 32;
    const reads = vi.spyOn(f.deps.blobs, "get");
    const entries = await zipEntries(await budgetApp(budget).request(reviewDownloadPath(reviewId, 1, [id])));
    expect(entries).toHaveLength(2);
    expect(entries[0]?.data).toEqual(base);
    expect(entries[1]?.html).toBe(await buildOmittedDownload({ title: "Budget doc" }));
    expect(reads.mock.calls.some(([, hash]) => hash === bodyHash)).toBe(false);
  },
);

test.each(["html", "markdown", "source"] as const)(
  "does not read a selected %s doc after the emitted budget is spent",
  async (kind) => {
    const { reviewId, id, bodyHash, base } = await bodyBudgetReview(kind, 16);
    const reads = vi.spyOn(f.deps.blobs, "get");
    const entries = await zipEntries(await budgetApp(base.byteLength).request(reviewDownloadPath(reviewId, 1, [id])));
    expect(entries[0]?.data).toEqual(base);
    expect(entries[1]?.html).toBe(await buildOmittedDownload({ title: "Budget doc" }));
    expect(reads.mock.calls.some(([, hash]) => hash === bodyHash)).toBe(false);
  },
);

test("selected doc bodies and assets spend the same read budget even when emitted space remains", async () => {
  const { reviewId, ids } = await docsReview();
  const complete = await zipEntries(await selectedDownload(reviewId, ids));
  const budget = complete.reduce((sum, file) => sum + file.data.byteLength, 0) + 1024;
  const rows = await f.db.read((q) =>
    q
      .select()
      .from(files)
      .where(and(eq(files.ownerId, f.ownerId), eq(files.id, ids[0])))
      .all(),
  );
  const markdown = rows[0];
  const html = await f.db.read((q) =>
    q
      .select()
      .from(files)
      .where(and(eq(files.ownerId, f.ownerId), eq(files.id, ids[1])))
      .get(),
  );
  if (!markdown?.renderedBlob || !html?.newBlob) throw new Error("Missing doc bodies");
  const markdownBytes = await f.deps.blobs.get(f.ownerId, markdown.renderedBlob);
  const htmlBytes = await f.deps.blobs.get(f.ownerId, html.newBlob);
  if (!markdownBytes || !htmlBytes) throw new Error("Missing stored bodies");
  // Base image + first doc leave one byte less than the second body needs.
  const paddedSize = budget - png.byteLength - htmlBytes.byteLength + 1;
  const padded = Buffer.concat([markdownBytes, Buffer.alloc(paddedSize - markdownBytes.byteLength, " ")]);
  const paddedHash = await f.deps.blobs.put(f.ownerId, padded, "application/json");
  await f.db.query((q) =>
    q
      .update(files)
      .set({ renderedBlob: paddedHash })
      .where(and(eq(files.ownerId, f.ownerId), eq(files.id, ids[0]))),
  );
  const reads = vi.spyOn(f.deps.blobs, "get");
  const entries = await zipEntries(await budgetApp(budget).request(reviewDownloadPath(reviewId, 1, ids)));
  expect(entries[1]?.data).toEqual(complete[1]?.data);
  expect(entries[2]?.html).toBe(await buildOmittedDownload({ title: html.title ?? html.path }));
  expect(reads.mock.calls.filter(([, hash]) => hash === paddedHash)).toHaveLength(1);
  expect(reads.mock.calls.some(([, hash]) => hash === html.newBlob)).toBe(false);
});

test.each([false, true])(
  "pub doc order and base selection include both views of a path, source first: %s",
  async (sourceFirst) => {
    const hash = await f.deps.blobs.put(f.ownerId, Buffer.from("# Dual view\n\nOne document"), "text/markdown");
    const input: PublishRequest["files"] = [false, true].map((source) => ({
      path: "plan.md",
      role: "doc",
      oldPath: null,
      oldBlob: null,
      newBlob: hash,
      flag: null,
      ...(source ? { view: "source" } : {}),
    }));
    if (sourceFirst) input.reverse();
    const { reviewId } = await publish({ writeup: blank, main: "plan.md", files: input });
    const view = await revisionView(reviewId);
    expect(view.docs.map((doc) => doc.kind)).toEqual(sourceFirst ? ["source", "markdown"] : ["markdown", "source"]);
    expect(view.files.map((file) => file.view === "source")).toEqual([sourceFirst, !sourceFirst]);
    const entries = await zipEntries(
      await selectedDownload(
        reviewId,
        view.files.map((file) => file.id),
      ),
    );
    expect(entries[0]?.data).toEqual(Buffer.from(await (await get(reviewId)).arrayBuffer()));
    expect(entries[0]?.html.includes('class="shiki em-source"')).toBe(sourceFirst);
    expect(entries).toHaveLength(3);
  },
);

// Comments and replies.
const commentsPath = (reviewId: string, ids: readonly string[] = [], comments = true) =>
  reviewDownloadPath(reviewId, 1, ids, { comments }).slice("/api/v1".length);
async function postThread(reviewId: string, target: unknown, body: string, revision = 1) {
  const response = await f.request(`/reviews/${reviewId}/threads`, "POST", { revision, target, body });
  expect(response.status).toBe(201);
  return (await response.json()) as { threadId: string; commentId: string };
}
async function commentedReview(options: { send?: boolean } = {}) {
  const put = (text: string) => f.deps.blobs.put(f.ownerId, Buffer.from(text), "text/plain");
  const inputs: PublishRequest["files"] = [];
  for (const [path, role, text] of [
    ["docs/plan.md", "doc", "Plan paragraph text"],
    ["docs/other.md", "doc", "Other paragraph text"],
    ["src/a.ts", "diff", "one\ntwo\nthree\n"],
  ] as const)
    inputs.push({ path, role, oldPath: null, oldBlob: null, newBlob: await put(text), flag: null });
  const published = await publish({
    topics: [{ slug: "auth", title: "Auth flow", importance: 10, summary: "Sign-in" }],
    writeup: { ...blank, overview: "Writeup paragraph text" },
    files: inputs,
  });
  const view = await revisionView(published.reviewId);
  const docId = (path: string) => view.files.find((file) => file.path === path && file.role === "doc")?.id ?? "";
  const blockOf = (path: string) => {
    const doc = view.docs.find((candidate) => candidate.path === path);
    const found = doc && "blocks" in doc ? doc.blocks[0]?.id : undefined;
    if (!found) throw new Error(`Missing block for ${path}`);
    return found;
  };
  const id = published.reviewId;
  const threadsMade = {
    review: await postThread(id, { kind: "review" }, "Whole review remark"),
    writeup: await postThread(
      id,
      {
        kind: "writeup-span",
        blockId: view.writeup.sections[0]?.blocks[0]?.id,
        quote: "Writeup paragraph text",
        prefix: "",
        suffix: "",
      },
      "Writeup remark",
    ),
    ticked: await postThread(
      id,
      {
        kind: "doc-span",
        path: "docs/plan.md",
        blockId: blockOf("docs/plan.md"),
        quote: "Plan paragraph text",
        prefix: "",
        suffix: "",
      },
      "Ticked doc remark",
    ),
    unticked: await postThread(
      id,
      {
        kind: "doc-span",
        path: "docs/other.md",
        blockId: blockOf("docs/other.md"),
        quote: "Other paragraph text",
        prefix: "",
        suffix: "",
      },
      "Unticked doc remark",
    ),
    diff: await postThread(
      id,
      {
        kind: "lines",
        path: "src/a.ts",
        side: "new",
        start: 2,
        end: 2,
        lines: ["two"],
        before: ["one"],
        after: ["three"],
      },
      "Diff line remark",
    ),
  };
  if (options.send !== false) {
    const sent = await f.request(`/reviews/${id}/sends`, "POST", { revision: 1, kind: "go" });
    expect(sent.status).toBe(201);
  }
  return { ...published, ids: { plan: docId("docs/plan.md"), other: docId("docs/other.md") }, threadsMade };
}
const reply = async (commentId: string, body: string) => {
  const response = await f.request(`/comments/${commentId}/reply`, "POST", { outcome: "fixed", body }, "agent");
  expect(response.status).toBe(201);
};
const at = (html: string, needle: string) => {
  const found = html.indexOf(needle);
  expect(found, needle).toBeGreaterThan(-1);
  return found;
};

test("comments off keeps the bytes of a request without the parameter, also with threads present", async () => {
  const { reviewId, ids } = await commentedReview();
  const plain = Buffer.from(await (await get(reviewId)).arrayBuffer());
  const off = await f.request(commentsPath(reviewId, [], false), "GET");
  expect(Buffer.from(await off.arrayBuffer())).toEqual(plain);
  expect(plain.toString("utf8")).not.toContain("Whole review remark");
  const zipPlain = await (await selectedDownload(reviewId, [ids.plan])).arrayBuffer();
  const zipOff = await (await f.request(commentsPath(reviewId, [ids.plan], false), "GET")).arrayBuffer();
  expect(Buffer.from(zipOff)).toEqual(Buffer.from(zipPlain));
});

test("comments on shows each thread at its place with replies, labels and state", async () => {
  const { reviewId, ids, threadsMade } = await commentedReview();
  await reply(threadsMade.writeup.commentId, "Writeup reply");
  await reply(threadsMade.ticked.commentId, "Ticked doc reply");
  expect((await f.request(`/threads/${threadsMade.review.threadId}/resolve`, "POST")).status).toBe(204);
  const single = await (await f.request(commentsPath(reviewId), "GET")).text();
  expect(single).toContain("<h2>Comments on the whole review</h2>");
  // Whole review thread: before the writeup, resolved.
  expect(at(single, "Whole review remark")).toBeLessThan(at(single, "Writeup paragraph text"));
  expect(single).toContain('data-state="resolved"');
  expect(single).toContain('<span class="em-thread-state">Resolved</span>');
  // Writeup thread: right after its block, with the agent reply.
  expect(at(single, "Writeup remark")).toBeGreaterThan(at(single, "Writeup paragraph text"));
  expect(at(single, "Writeup reply")).toBeGreaterThan(at(single, "Writeup remark"));
  expect(single).toContain("<strong>Reviewer</strong>");
  expect(single).toContain("<strong>Agent</strong> · Fixed");
  // Everything else lands in Other comments with its path and line.
  const other = at(single, "Other comments");
  expect(at(single, "Diff line remark")).toBeGreaterThan(other);
  expect(at(single, "src/a.ts · line 2")).toBeGreaterThan(other);
  expect(at(single, "Ticked doc remark")).toBeGreaterThan(other);
  expect(at(single, "Unticked doc remark")).toBeGreaterThan(other);
  expect(at(single, "docs/other.md")).toBeGreaterThan(other);

  const entries = await zipEntries(await f.request(commentsPath(reviewId, [ids.plan]), "GET"));
  const [base, plan] = entries.map(({ html }) => html);
  expect(base).toContain("Writeup remark");
  expect(plan).toContain("Ticked doc remark");
  expect(at(plan ?? "", "Ticked doc remark")).toBeGreaterThan(at(plan ?? "", "Plan paragraph text"));
  expect(plan).toContain("Ticked doc reply");
  expect(plan).not.toContain("Unticked doc remark");
  expect(plan).not.toContain("Whole review remark");
  // The unticked doc's thread is still listed in the base file; the ticked doc's is not.
  expect(base).toContain("Unticked doc remark");
  expect(base).not.toContain("Ticked doc remark");
});

test("comments=1 without docs keeps the single HTML response and headers", async () => {
  const { reviewId } = await commentedReview();
  const response = await f.request(commentsPath(reviewId), "GET");
  expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="export-example-r1.html"');
  const head = await f.request(commentsPath(reviewId), "HEAD");
  expect(head.headers.get("Content-Disposition")).toBe(response.headers.get("Content-Disposition"));
  expect(await head.text()).toBe("");
});

test("unsent comments stay out of the file", async () => {
  const { reviewId, threadsMade } = await commentedReview({ send: false });
  const first = await (await f.request(commentsPath(reviewId), "GET")).text();
  expect(first).not.toContain("Whole review remark");
  expect(first).not.toContain("Other comments");
  const sent = await f.request(`/reviews/${reviewId}/sends`, "POST", { revision: 1, kind: "go" });
  expect(sent.status).toBe(201);
  const comment = await f.request(`/threads/${threadsMade.review.threadId}/comments`, "POST", {
    body: "Draft follow-up",
  });
  expect(comment.status).toBe(201);
  const after = await (await f.request(commentsPath(reviewId), "GET")).text();
  expect(after).toContain("Whole review remark");
  expect(after).not.toContain("Draft follow-up");
});

test("hostile comment bodies run nothing in the file", async () => {
  const { reviewId, threadsMade } = await commentedReview();
  const hostile = await f.request(`/threads/${threadsMade.review.threadId}/comments`, "POST", {
    body: "<script>alert(1)</script> <img src=x onerror=alert(1)> [x](javascript:alert(1))",
  });
  expect(hostile.status).toBe(201);
  expect((await f.request(`/reviews/${reviewId}/sends`, "POST", { revision: 1, kind: "go" })).status).toBe(201);
  const html = await (await f.request(commentsPath(reviewId), "GET")).text();
  expect(html).toContain("Whole review remark");
  for (const forbidden of ["<script", "onerror"]) expect(html).not.toContain(forbidden);
  // The renderer drops the unsafe link and leaves its Markdown source as inert text.
  expect(html).not.toMatch(/(?:href|src|action)=["']?\s*javascript:/i);
  expect(html).not.toContain("<a href=");
});

test("a bad comments parameter is refused before the slot, for GET and HEAD", async () => {
  const { reviewId } = await commentedReview();
  for (const query of ["comments=0", "comments=true", "comments=1&comments=1", "comments="])
    for (const method of ["GET", "HEAD"])
      expect(
        (await f.request(`/reviews/${reviewId}/revisions/1/download?${query}`, method)).status,
        `${method} ${query}`,
      ).toBe(400);
  const response = await f.request(`/reviews/${reviewId}/revisions/1/download?comments=0`, "GET");
  expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
});

test("another owner's comments never appear, and the file holds no thread or comment id", async () => {
  const { reviewId, threadsMade } = await commentedReview();
  await reply(threadsMade.writeup.commentId, "Writeup reply");
  // A foreign owner cannot download this review at all.
  expect((await f.request(commentsPath(reviewId), "GET", undefined, "foreign")).status).toBe(404);
  const single = await (await f.request(commentsPath(reviewId), "GET")).text();
  const ids = Object.values(threadsMade).flatMap((made) => [made.threadId, made.commentId]);
  for (const id of ids) expect(single).not.toContain(id);
  expect(single).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
});

async function sendComments(reviewId: string, revision = 1) {
  expect((await f.request(`/reviews/${reviewId}/sends`, "POST", { revision, kind: "go" })).status).toBe(201);
}
async function commentDocReview(kind: "markdown" | "source" | "html", pub: boolean, html?: string) {
  const path = kind === "markdown" ? "plan.md" : kind === "source" ? "source.txt" : "doc.html";
  const body = kind === "html" ? (html ?? "<p>Doc paragraph</p>") : "Doc paragraph\n\nNext paragraph";
  const hash = await f.deps.blobs.put(f.ownerId, Buffer.from(body), "text/plain");
  const { reviewId } = await publish({
    writeup: pub ? blank : { ...blank, overview: "Review overview" },
    files: [
      {
        path,
        role: "doc",
        oldPath: null,
        oldBlob: null,
        newBlob: hash,
        flag: null,
        ...(kind === "source" ? { view: "source" } : {}),
        ...(kind === "html" ? { assets: [] } : {}),
      },
    ],
  });
  const view = await revisionView(reviewId);
  const doc = view.docs[0];
  if (!doc) throw new Error("Missing doc");
  const target =
    kind === "source"
      ? {
          kind: "source-lines",
          path,
          start: 1,
          end: 1,
          lines: ["Doc paragraph"],
          before: [],
          after: ["", "Next paragraph"],
        }
      : kind === "html"
        ? { kind: "html-span", path, quote: "Doc paragraph", prefix: "", suffix: "" }
        : {
            kind: "doc-span",
            path,
            blockId: "blocks" in doc ? doc.blocks[0]?.id : undefined,
            quote: "Doc paragraph",
            prefix: "",
            suffix: "",
          };
  await postThread(reviewId, target, "Doc remark");
  await sendComments(reviewId);
  const id = view.files[0]?.id;
  if (!id) throw new Error("Missing file id");
  return { reviewId, id };
}

test.each(["markdown", "source"] as const)(
  "a %s pub places its base doc thread after the block or line",
  async (kind) => {
    const { reviewId } = await commentDocReview(kind, true);
    const response = await f.request(commentsPath(reviewId), "GET");
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const html = await response.text();
    expect(at(html, "Doc remark")).toBeGreaterThan(at(html, "Doc paragraph"));
    expect(at(html, "Doc remark")).toBeLessThan(at(html, "Next paragraph"));
    expect(html.match(/class="em-thread"/g)).toHaveLength(1);
    expect(html).not.toContain("Other comments");
  },
);

test("a selected source doc holds its line thread in its ZIP entry", async () => {
  const { reviewId, id } = await commentDocReview("source", false);
  const entries = await zipEntries(await f.request(commentsPath(reviewId, [id]), "GET"));
  expect(entries).toHaveLength(2);
  expect(entries[0]?.html).not.toContain("Doc remark");
  expect(entries[1]?.name).toBe("docs/source.txt.html");
  const html = entries[1]?.html ?? "";
  expect(at(html, "Doc remark")).toBeGreaterThan(at(html, "Doc paragraph"));
  expect(at(html, "Doc remark")).toBeLessThan(at(html, "Next paragraph"));
});

test.each([
  '<style>.em-comment[data-author=user] .em-comment-body{display:none}.em-comment::after{content:"Approved"}</style><p>Doc paragraph</p>',
  "<p>Doc paragraph</p><plaintext>agent text",
])("an HTML pub isolates comments from agent markup: %s", async (markup) => {
  const { reviewId } = await commentDocReview("html", true, markup);
  await postThread(reviewId, { kind: "review" }, "Whole publication remark");
  await sendComments(reviewId);
  const plain = Buffer.from(await (await get(reviewId)).arrayBuffer());
  const response = await f.request(commentsPath(reviewId), "GET");
  expect(response.headers.get("Content-Type")).toBe("application/zip");
  expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="export-example-r1.zip"');
  const entries = await zipEntries(response);
  expect(entries.map((entry) => entry.name)).toEqual(["export-example-r1.html", "comments.html"]);
  expect(entries[0]?.data).toEqual(plain);
  expect(entries[0]?.html).not.toContain('class="em-thread"');
  const comments = entries[1]?.html ?? "";
  expect(comments).toContain("<h1>Export example — comments</h1>");
  expect(at(comments, "Whole publication remark")).toBeGreaterThan(at(comments, "Comments on the whole review"));
  expect(at(comments, "Doc remark")).toBeGreaterThan(at(comments, "Other comments"));
  expect(comments).toContain('<span class="em-thread-where">doc.html</span>');
  expect(comments).toContain('<blockquote class="em-thread-quote"><p>Doc paragraph</p></blockquote>');
  expect(comments).not.toContain("Approved");
  expect(comments).not.toContain("<plaintext");
});

test("selected HTML doc threads stay in the base file's Other comments", async () => {
  const { reviewId, id } = await commentDocReview("html", false);
  const entries = await zipEntries(await f.request(commentsPath(reviewId, [id]), "GET"));
  expect(entries).toHaveLength(2);
  const base = entries[0]?.html ?? "";
  expect(at(base, "Doc remark")).toBeGreaterThan(at(base, "Other comments"));
  expect(base).toContain('<span class="em-thread-where">doc.html</span>');
  expect(entries[1]?.html).not.toContain("em-thread");
  expect(entries[1]?.html).not.toContain("Doc remark");
});

test("HEAD with comments identifies an HTML pub from metadata without reading blobs or waiting", async () => {
  const { reviewId } = await commentDocReview("html", true);
  const download = await f.request(commentsPath(reviewId), "GET");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const read = f.deps.blobs.get.bind(f.deps.blobs);
  const reads = vi.spyOn(f.deps.blobs, "get").mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return read(...args);
  });
  const pending = Promise.resolve(f.request(commentsPath(reviewId), "GET"));
  try {
    await entered.promise;
    reads.mockClear();
    const head = await f.request(commentsPath(reviewId), "HEAD");
    expect(head.status).toBe(200);
    expect(Object.fromEntries(head.headers)).toEqual(Object.fromEntries(download.headers));
    expect(head.headers.get("Content-Type")).toBe("application/zip");
    expect(await head.text()).toBe("");
    expect(reads).not.toHaveBeenCalled();
    const off = await f.request(commentsPath(reviewId, [], false), "HEAD");
    expect(off.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(reads).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await pending;
  }
});

test("an HTML pub without sent threads still has a comments page before the selected docs", async () => {
  const { reviewId, ids } = await docsReview({ writeup: blank, main: "guide/visual.html" });
  const entries = await zipEntries(await f.request(commentsPath(reviewId, [ids[0]]), "GET"));
  expect(entries.map((entry) => entry.name)).toEqual([
    "export-example-r1.html",
    "comments.html",
    "docs/guide/plan.md.html",
  ]);
  expect(entries[1]?.html).toContain("<p>No sent comments.</p>");
});

test("a selected Markdown doc replaced by the left-out page retains its threads within budget", async () => {
  const { reviewId, id, bodyHash } = await bodyBudgetReview("markdown", 32000);
  const view = await revisionView(reviewId);
  const doc = view.docs[0];
  if (!doc || !("blocks" in doc)) throw new Error("Missing Markdown doc");
  await postThread(
    reviewId,
    { kind: "doc-span", path: "budget.md", blockId: doc.blocks[0]?.id, quote: "Budget body", prefix: "", suffix: "" },
    "Kept doc remark",
  );
  await sendComments(reviewId);
  const complete = await zipEntries(await f.request(commentsPath(reviewId, [id]), "GET"));
  const baseBytes = complete[0]?.data.byteLength ?? 0;
  const reads = vi.spyOn(f.deps.blobs, "get");
  const entries = await zipEntries(
    await budgetApp(baseBytes + 1024).request(reviewDownloadPath(reviewId, 1, [id], { comments: true })),
  );
  expect(entries[0]?.data).toEqual(complete[0]?.data);
  const omitted = entries[1]?.html ?? "";
  expect(at(omitted, "Comments on this doc")).toBeGreaterThan(at(omitted, "Some content was left out"));
  expect(at(omitted, "Kept doc remark")).toBeGreaterThan(at(omitted, "Comments on this doc"));
  expect(omitted).toContain('<span class="em-thread-where">budget.md</span>');
  expect(reads.mock.calls.some(([, hash]) => hash === bodyHash)).toBe(false);
  const exhausted = await zipEntries(
    await budgetApp(baseBytes).request(reviewDownloadPath(reviewId, 1, [id], { comments: true })),
  );
  expect(exhausted[1]?.html).toContain("Some content was left out");
  expect(exhausted[1]?.html).not.toContain("Kept doc remark");
});

test("older revisions exclude later threads while keeping later replies on their own threads", async () => {
  const { reviewId } = await publish();
  const first = await postThread(reviewId, { kind: "review" }, "Revision one remark");
  await sendComments(reviewId);
  await publish({ reviewId, writeup: { ...blank, overview: "Revision two" } });
  await postThread(reviewId, { kind: "review" }, "Revision two remark", 2);
  await sendComments(reviewId, 2);
  await reply(first.commentId, "Later reply on revision one");
  const one = await (await f.request(commentsPath(reviewId), "GET")).text();
  const two = await (await f.request(`/reviews/${reviewId}/revisions/2/download?comments=1`, "GET")).text();
  expect(one).toContain("Revision one remark");
  expect(one).toContain("Later reply on revision one");
  expect(one).not.toContain("Revision two remark");
  expect(two).toContain("Revision one remark");
  expect(two).toContain("Revision two remark");
});

test("a sent script-only comment survives as escaped text", async () => {
  const { reviewId } = await publish();
  await postThread(reviewId, { kind: "review" }, "<script>alert(1)</script>");
  await sendComments(reviewId);
  const html = await (await f.request(commentsPath(reviewId), "GET")).text();
  expect(html).toContain('<p class="em-comment-text">&#x3C;script>alert(1)&#x3C;/script></p>');
  expect(html).not.toContain("<script");
});
