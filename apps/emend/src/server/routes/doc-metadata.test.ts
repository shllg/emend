import { PublishResponse, RevisionView } from "@emend/contract";
import { and, eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { files } from "../../db/schema.ts";
import { mailboxFixture } from "../mailbox/test-support.ts";

test("publish stores and serves doc metadata, cleans manifest titles, and resolves forward links", async () => {
  const f = await mailboxFixture();
  try {
    const sources = [
      {
        path: "docs/a.md",
        title: "\u200b",
        source:
          '<script>\n# Hidden\n</script>\n\n# Visible\n\n[forward](b.html?rev=9#unknown)\n\n<h2 id="section">Section</h2>',
      },
      {
        path: "docs/b.html",
        title: "  Named\u202e  doc ",
        source: "<svg><title>Wrong</title></svg><h1>HTML</h1><h2>Part</h2><h3>Child</h3>",
      },
      { path: "docs/plain.md", source: "No heading" },
      { path: "docs/fallback.html", source: "<svg><title>Wrong</title></svg><h1>Own HTML title</h1>" },
    ];
    const publishedFiles = await Promise.all(
      sources.map(async (doc) => ({
        path: doc.path,
        title: doc.title,
        role: "doc",
        oldPath: null,
        oldBlob: null,
        newBlob: await f.deps.blobs.put(f.ownerId, Buffer.from(doc.source), "text/plain"),
        flag: null,
        ...(doc.path.endsWith(".html") ? { assets: [] } : {}),
      })),
    );
    const response = await f.request(
      "/publish",
      "POST",
      {
        reviewKey: "e".repeat(64),
        repo: null,
        branch: null,
        title: "Synthetic",
        base: null,
        head: null,
        topics: [],
        writeup: { overview: "[doc](docs/a.md#section)", tldr: "", decisions: null, topics: {} },
        files: publishedFiles,
      },
      "agent",
    );
    expect(response.status).toBe(200);
    const published = PublishResponse.parse(await response.json());
    const viewResponse = await f.request(`/reviews/${published.reviewId}/revisions/1`, "GET");
    expect(viewResponse.status).toBe(200);
    const view = RevisionView.parse(await viewResponse.json());
    expect(view.docs.map((d) => d.title)).toEqual(["Visible", "Named doc", "plain.md", "Own HTML title"]);
    expect(view.docs[1] && "headings" in view.docs[1] ? view.docs[1].headings : undefined).toEqual([
      { level: 2, text: "Part" },
      { level: 3, text: "Child" },
    ]);
    const md = view.docs[0];
    if (md?.kind !== "markdown") throw new Error("missing markdown");
    expect(md.headings).toEqual([{ level: 2, text: "Section", id: expect.any(String) }]);
    if (md?.kind !== "markdown") throw new Error("missing markdown");
    expect(md.blocks.some((b) => b.html.includes(`id="${md.headings?.[0]?.id}"`))).toBe(true);
    expect(md.blocks.map((b) => b.html).join("")).toContain('href="?tab=docs&#x26;doc=docs%2Fb.html"');
    expect(
      view.writeup.sections
        .flatMap((s) => s.blocks)
        .map((b) => b.html)
        .join(""),
    ).toContain('href="?tab=docs&#x26;doc=docs%2Fa.md#h-user-content-section"');
    const rows = await f.db.read((q) =>
      q
        .select()
        .from(files)
        .where(and(eq(files.ownerId, f.ownerId), eq(files.path, "docs/a.md")))
        .all(),
    );
    expect(rows[0]).toMatchObject({ title: "Visible", headings: md.headings });
    expect((await f.request(`/reviews/${published.reviewId}/revisions/1`, "GET", undefined, "foreign")).status).toBe(
      404,
    );
  } finally {
    await f.cleanup();
  }
}, 15000);
