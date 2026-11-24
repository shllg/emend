import { PublishResponse, RevisionView } from "@recense/contract";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { files } from "../../db/schema.ts";
import { mailboxFixture } from "../mailbox/test-support.ts";

const glossary =
  "# Guide\n\nThe budget is spent.\n\n## Glossary\n\n- **Budget** (also: quota):\n  Attempts a worker may spend.\n";

test("publish stores a Markdown doc's glossary terms and the revision view returns them", async () => {
  const f = await mailboxFixture();
  try {
    const sources = [
      { path: "a/guide.md", source: glossary },
      // The same source in another folder reuses the render through a resection: its block ids change.
      { path: "b/guide.md", source: glossary },
      { path: "plain.md", source: "# Plain\n\nThe budget is spent.\n" },
      { path: "shown.md", source: glossary, view: "source" },
    ];
    const input = {
      reviewKey: "e".repeat(64),
      repo: null,
      branch: null,
      title: "Synthetic terms",
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
        })),
      ),
    };
    const response = await f.request("/publish", "POST", input, "agent");
    expect(response.status).toBe(200);
    const published = PublishResponse.parse(await response.json());
    const rows = await f.db.read((q) => q.select().from(files).where(eq(files.ownerId, f.ownerId)).all());
    expect(rows.find((file) => file.path === "plain.md")?.terms).toBeNull();
    expect(rows.find((file) => file.path === "shown.md")?.terms).toBeNull();
    const view = RevisionView.parse(
      await (await f.request(`/reviews/${published.reviewId}/revisions/1`, "GET")).json(),
    );
    const markdown = (path: string) => view.docs.find((doc) => doc.path === path && doc.kind === "markdown");
    const ids = new Set<string>();
    for (const path of ["a/guide.md", "b/guide.md"]) {
      const doc = markdown(path);
      if (doc?.kind !== "markdown") throw new Error("expected a Markdown doc");
      expect(doc.terms).toHaveLength(1);
      expect(doc.terms?.[0]).toMatchObject({ term: "Budget", definition: "Attempts a worker may spend." });
      const blockId = doc.terms?.[0]?.blockId ?? "";
      // The term follows its block into the resectioned render.
      expect(doc.blocks.find((block) => block.id === blockId)?.text).toContain("Budget (also: quota)");
      expect(doc.blocks.some((block) => block.html.includes('data-recense-term="0"'))).toBe(true);
      ids.add(blockId);
    }
    expect(ids.size).toBe(2);
    expect(markdown("plain.md")).not.toHaveProperty("terms");
    expect(view.docs.find((doc) => doc.path === "shown.md")).not.toHaveProperty("terms");
    // A re-publish adds rows and keeps the earlier revision's terms.
    const again = await f.request("/publish", "POST", { ...input, reviewId: published.reviewId }, "agent");
    expect(again.status).toBe(200);
    const second = RevisionView.parse(
      await (await f.request(`/reviews/${published.reviewId}/revisions/2`, "GET")).json(),
    );
    expect(second.docs.find((doc) => doc.path === "a/guide.md")).toHaveProperty("terms");
    const first = RevisionView.parse(
      await (await f.request(`/reviews/${published.reviewId}/revisions/1`, "GET")).json(),
    );
    expect(first.docs.find((doc) => doc.path === "a/guide.md")).toHaveProperty("terms");
  } finally {
    await f.cleanup();
  }
});
