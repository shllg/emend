import { PublishResponse, RevisionView } from "@emend/contract";
import { and, eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { files, revisions } from "../../db/schema.ts";
import { mailboxFixture } from "../mailbox/test-support.ts";
import { WorkTimeout } from "../publish/executor.ts";
import { executeWork } from "../publish/work.ts";

test("publish records HTML look, leaves other and failed metadata null, and omits legacy looks from views", async () => {
  const f = await mailboxFixture();
  try {
    const sources = [
      { path: "structure.html", source: "<h1>Plan</h1><h2>Part</h2>", look: "emend" },
      { path: "styled.html", source: "<style>p{color:red}</style><p>Plan</p>", look: "emend" },
      { path: "plan.md", source: "# Plan", look: null },
      { path: "source.html", source: "<h1>Source</h1>", view: "source", look: null },
      { path: "deep.html", source: "<div>".repeat(2000), look: null },
      { path: "failed.html", source: "<h1>Metadata fails</h1>", look: null },
    ];
    const execute = f.deps.publishExecutor ?? executeWork;
    f.deps.publishExecutor = async (work) => {
      if (work.kind === "doc-metadata" && Buffer.from(work.bytes).toString() === "<h1>Metadata fails</h1>")
        throw new Error("Synthetic metadata failure");
      return execute(work);
    };
    const input = {
      reviewKey: "e".repeat(64),
      repo: null,
      branch: null,
      title: "Synthetic looks",
      base: null,
      head: null,
      topics: [],
      writeup: { overview: "", tldr: "", decisions: null, topics: {} },
      files: await Promise.all(
        sources.map(async ({ path, source, view }) => ({
          path,
          view,
          role: "doc",
          oldPath: null,
          oldBlob: null,
          newBlob: await f.deps.blobs.put(f.ownerId, Buffer.from(source), "text/plain"),
          flag: null,
          ...(path.endsWith(".html") && !view ? { assets: [] } : {}),
        })),
      ),
    };
    const response = await f.request("/publish", "POST", input, "agent");
    expect(response.status).toBe(200);
    const published = PublishResponse.parse(await response.json());
    expect(published.unrendered).toEqual(["failed.html"]);
    expect(published.htmlLooks).toEqual([
      { path: "structure.html", look: "emend" },
      { path: "styled.html", look: "emend", colorScheme: "light" },
      { path: "deep.html", look: "custom" },
    ]);
    const rows = await f.db.read((q) => q.select().from(files).where(eq(files.ownerId, f.ownerId)).all());
    for (const { path, look } of sources) {
      expect(rows.find((file) => file.path === path)).toMatchObject({
        look,
        colorScheme: path === "styled.html" ? "light" : null,
      });
    }
    const viewPath = `/reviews/${published.reviewId}/revisions/1`;
    const view = RevisionView.parse(await (await f.request(viewPath, "GET")).json());
    expect(view.docs[0]).toMatchObject({ kind: "html", look: "emend", headings: [{ level: 2, text: "Part" }] });
    expect(view.docs[1]).toMatchObject({ kind: "html", look: "emend", colorScheme: "light" });
    for (const doc of view.docs.slice(2)) expect(doc).not.toHaveProperty("look");
    const repeated = await f.request("/publish", "POST", { ...input, reviewId: published.reviewId }, "agent");
    expect(repeated.status).toBe(200);
    expect(PublishResponse.parse(await repeated.json())).toMatchObject({
      revision: 2,
      unrendered: ["failed.html"],
      htmlLooks: published.htmlLooks,
    });
    const repeatedView = RevisionView.parse(
      await (await f.request(`/reviews/${published.reviewId}/revisions/2`, "GET")).json(),
    );
    expect(repeatedView.docs[0]).toMatchObject({ path: "structure.html", kind: "html", look: "emend" });
    expect(repeatedView.docs[1]).toMatchObject({
      path: "styled.html",
      kind: "html",
      look: "emend",
      colorScheme: "light",
    });
    for (const doc of repeatedView.docs.slice(2)) expect(doc).not.toHaveProperty("look");
    const repeatedRows = await f.db.read((q) => q.select().from(files).where(eq(files.ownerId, f.ownerId)).all());
    for (const { path, look } of sources) {
      const matches = repeatedRows.filter((file) => file.path === path);
      expect(matches).toHaveLength(2);
      expect(new Set(matches.map((file) => file.revisionId)).size).toBe(2);
      for (const file of matches)
        expect(file).toMatchObject({ look, colorScheme: path === "styled.html" ? "light" : null });
    }
    await f.db.query((q) =>
      q
        .update(files)
        .set({ look: null })
        .where(and(eq(files.ownerId, f.ownerId), eq(files.path, "structure.html"))),
    );
    const legacy = RevisionView.parse(await (await f.request(viewPath, "GET")).json());
    expect(legacy.docs[0]).not.toHaveProperty("look");

    for (const [index, error] of [new Error("Synthetic metadata failure"), new WorkTimeout()].entries()) {
      f.deps.publishExecutor = async (work) => {
        if (work.kind === "doc-metadata") throw error;
        return executeWork(work);
      };
      const failed = await f.request("/publish", "POST", { ...input, reviewId: published.reviewId }, "agent");
      expect(failed.status).toBe(200);
      expect(PublishResponse.parse(await failed.json())).toMatchObject({
        revision: index + 3,
        unrendered: ["structure.html", "styled.html", "deep.html", "failed.html"],
        htmlLooks: [],
      });
      const failedView = RevisionView.parse(
        await (await f.request(`/reviews/${published.reviewId}/revisions/${index + 3}`, "GET")).json(),
      );
      for (const doc of failedView.docs) {
        expect(doc).not.toHaveProperty("look");
        expect(doc).not.toHaveProperty("colorScheme");
      }
      const failedRows = await f.db.read((q) =>
        q
          .select({ look: files.look, colorScheme: files.colorScheme })
          .from(files)
          .innerJoin(revisions, and(eq(revisions.ownerId, f.ownerId), eq(revisions.id, files.revisionId)))
          .where(
            and(eq(files.ownerId, f.ownerId), eq(revisions.reviewId, published.reviewId), eq(revisions.seq, index + 3)),
          )
          .all(),
      );
      expect(failedRows).toHaveLength(sources.length);
      for (const file of failedRows) expect(file).toEqual({ look: null, colorScheme: null });
    }
  } finally {
    await f.cleanup();
  }
}, 15000);

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
