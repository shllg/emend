import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { repos, reviews } from "../../db/schema.ts";
import { directFixture } from "../direct-test-support.ts";
import { snapshot } from "./bundle.ts";

test.each(["Orchard", ".git", null])(
  "export preserves the review's project %s separately from its repo",
  async (project) => {
    const fixture = await directFixture();
    const { result } = await fixture.publish();
    const server = await fixture.reviewer();
    await server.db.query(async (q) => {
      const repo = await q
        .insert(repos)
        .values({ ownerId: server.ownerId, key: "b".repeat(64), name: "Original" })
        .returning()
        .get();
      if (!repo) throw new Error("missing repo");
      await q
        .update(reviews)
        .set({ project, repoId: repo.id })
        .where(and(eq(reviews.ownerId, server.ownerId), eq(reviews.id, result.reviewId)));
    });
    const exported = await server.db.transaction((q) =>
      snapshot(
        q,
        server.ownerId,
        server.instance.id,
        result.reviewId,
        `https://hub.example/r/${result.reviewId}`,
        Date.now(),
      ),
    );
    if (exported.kind !== "bundle") throw new Error("missing bundle");
    expect(exported.bundle.review).toMatchObject({ project, repo: { name: "Original" } });
    expect(JSON.parse(exported.json).review.project).toBe(project);
  },
);

test("export rows keep doc titles but omit recomputable headings", async () => {
  const fixture = await directFixture();
  await writeFile(join(fixture.source, "plan.md"), "# Named\n\n## Part");
  const { result } = await fixture.publish();
  const server = await fixture.reviewer();
  expect(
    (await server.request(`/reviews/${result.reviewId}/sends`, { kind: "approve", revision: result.revision })).status,
  ).toBe(201);
  const exported = await server.db.transaction((q) =>
    snapshot(
      q,
      server.ownerId,
      server.instance.id,
      result.reviewId,
      `https://hub.example/r/${result.reviewId}`,
      Date.now(),
    ),
  );
  if (exported.kind !== "bundle") throw new Error("missing bundle");
  expect(exported.bundle.review).not.toHaveProperty("approvedAt");
  expect(JSON.parse(exported.json).review).not.toHaveProperty("approvedAt");
  expect(exported.bundle.files[0]?.title).toBe("Named");
  expect(exported.bundle.files[0]).not.toHaveProperty("headings");
  expect(JSON.parse(exported.json).files[0]).not.toHaveProperty("headings");
});

test.each([
  [false, null],
  [true, "2026-11-04T10:00:00.000Z"],
])("export carries binnedAt of a binned review (binned: %s)", async (binned, expected) => {
  const fixture = await directFixture();
  const { result } = await fixture.publish();
  const server = await fixture.reviewer();
  if (binned)
    await server.db.query((q) =>
      q
        .update(reviews)
        .set({ binnedAt: Date.parse("2026-11-04T10:00:00.000Z") })
        .where(and(eq(reviews.ownerId, server.ownerId), eq(reviews.id, result.reviewId))),
    );
  const exported = await server.db.transaction((q) =>
    snapshot(
      q,
      server.ownerId,
      server.instance.id,
      result.reviewId,
      `https://hub.example/r/${result.reviewId}`,
      Date.now(),
    ),
  );
  if (exported.kind !== "bundle") throw new Error("missing bundle");
  expect(exported.bundle.review.binnedAt).toBe(expected);
  expect(JSON.parse(exported.json).review.binnedAt).toBe(expected);
});
