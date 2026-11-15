import { randomUUID } from "node:crypto";
import { ImportBundle, LIMITS, PublishResponse, RevisionView } from "@emend/contract";
import { and, eq } from "drizzle-orm";
import { expect, test, vi } from "vitest";
import { blobs } from "../../db/schema.ts";
import { error, mailboxFixture } from "../mailbox/test-support.ts";
import * as mediaHeads from "../publish/media-head.ts";
import { bundle, importFixture } from "./import-test-support.ts";

vi.mock("../publish/media-head.ts", async (original) => ({
  ...(await original<typeof import("../publish/media-head.ts")>()),
}));

const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");

test("import preserves Markdown associations and rebuilds their images and sizes", async () => {
  const f = await importFixture();
  try {
    const kept: string[][] = [];
    const memoize = mediaHeads.memoizedHeads;
    vi.spyOn(mediaHeads, "memoizedHeads").mockImplementation((load) => {
      const memo = memoize(load);
      return {
        read: memo.read,
        keep: (hashes) => {
          const list = [...hashes];
          kept.push(list);
          memo.keep(list);
        },
      };
    });
    const input = ImportBundle.parse(await bundle(f));
    const doc = input.files[0];
    if (!doc) throw new Error("Missing fixture doc");
    doc.path = "plan.md";
    doc.newBlob = await f.deps.blobs.put(f.ownerId, Buffer.from("![Shot](a.png)"), "text/markdown");
    const hash = await f.deps.blobs.put(f.ownerId, png, "image/png");
    const asset = {
      ...doc,
      id: randomUUID(),
      path: "a.png",
      role: "asset" as const,
      ord: 1,
      parentDocId: doc.id,
      newBlob: hash,
    };
    input.files.push(asset);
    input.docAssets.push({ revisionId: doc.revisionId, docId: doc.id, assetId: asset.id });
    const imported = await f.importRequest("/import", input);
    expect(imported.status, await imported.text()).toBe(201);
    expect(kept).not.toEqual([]);
    expect(kept.flat()).not.toContain(hash);
    const revision = RevisionView.parse(
      await (await f.request(`/reviews/${input.review.id}/revisions/1`, "GET")).json(),
    );
    const rendered = revision.docs[0];
    if (rendered?.kind !== "markdown") throw new Error("Missing Markdown doc");
    expect(rendered.blocks[0]?.html).toContain(`/api/v1/media/${hash}`);
    expect(rendered.blocks[0]?.html).toContain('width="1" height="1"');
    const media = await f.request(`/media/${hash}`, "GET");
    expect(media.status).toBe(200);
    expect(Buffer.from(await media.arrayBuffer())).toEqual(png);
  } finally {
    vi.restoreAllMocks();
    await f.cleanup();
  }
});

test("server enforces a Markdown doc's combined asset limit before reading blobs", async () => {
  const f = await mailboxFixture();
  try {
    const doc = await f.deps.blobs.put(f.ownerId, Buffer.from("![A](a.png) ![B](b.png)"), "text/markdown");
    const hash = await f.deps.blobs.put(f.ownerId, png, "image/png");
    // Metadata sizes are enough to reject the sum before any content is read.
    await f.db.query((q) =>
      q
        .update(blobs)
        .set({ size: LIMITS.assetBytes })
        .where(and(eq(blobs.ownerId, f.ownerId), eq(blobs.sha256, hash))),
    );
    const get = vi.spyOn(f.deps.blobs, "get");
    const response = await f.request(
      "/publish",
      "POST",
      {
        reviewKey: "b".repeat(64),
        repo: null,
        branch: null,
        title: "Synthetic",
        base: null,
        head: null,
        topics: [],
        writeup: { overview: "", tldr: "", decisions: null, topics: {} },
        files: [
          {
            path: "plan.md",
            role: "doc",
            oldPath: null,
            oldBlob: null,
            newBlob: doc,
            flag: null,
            assets: ["a.png", "b.png"],
          },
          ...["a.png", "b.png"].map((path) => ({
            path,
            role: "asset",
            oldPath: null,
            oldBlob: null,
            newBlob: hash,
            flag: null,
            parent: "plan.md",
          })),
        ],
      },
      "agent",
    );
    await error(response, 413, "too_large");
    expect(get).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    await f.cleanup();
  }
});

test("a Markdown doc can share writeup media while HTML-only assets stay out of downloads", async () => {
  const f = await mailboxFixture();
  try {
    const shot = await f.deps.blobs.put(f.ownerId, png, "image/png");
    const htmlOnly = await f.deps.blobs.put(f.ownerId, Buffer.concat([png, Buffer.from("html")]), "image/png");
    const markdown = await f.deps.blobs.put(
      f.ownerId,
      Buffer.from("![Shot](shot.png) ![Unlisted](html.png)"),
      "text/markdown",
    );
    const html = await f.deps.blobs.put(f.ownerId, Buffer.from('<img src="html.png">'), "text/html");
    const base = { oldPath: null, oldBlob: null, flag: null };
    const response = await f.request(
      "/publish",
      "POST",
      {
        reviewKey: "b".repeat(64),
        repo: null,
        branch: null,
        title: "Synthetic",
        base: null,
        head: null,
        topics: [],
        main: "plan.md",
        writeup: { overview: "", tldr: "", decisions: null, topics: {} },
        files: [
          { ...base, path: "plan.md", role: "doc", newBlob: markdown, assets: ["shot.png"] },
          { ...base, path: "plan.html", role: "doc", newBlob: html, assets: ["html.png"] },
          { ...base, path: "shot.png", role: "asset", newBlob: shot },
          { ...base, path: "html.png", role: "asset", parent: "plan.html", newBlob: htmlOnly },
        ],
      },
      "agent",
    );
    expect(response.status).toBe(200);
    const pub = PublishResponse.parse(await response.json());
    const download = await f.request(`/reviews/${pub.reviewId}/revisions/1/download`, "GET");
    expect(download.status).toBe(200);
    const body = await download.text();
    expect(body).toContain(`data:image/png;base64,${png.toString("base64")}`);
    expect(body).not.toContain(Buffer.concat([png, Buffer.from("html")]).toString("base64"));
    await error(await f.request(`/media/${htmlOnly}`, "GET"), 404, "not_found");
  } finally {
    vi.restoreAllMocks();
    await f.cleanup();
  }
});
