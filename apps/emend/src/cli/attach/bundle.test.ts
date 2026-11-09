import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { directFixture } from "../direct-test-support.ts";
import { snapshot } from "./bundle.ts";

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
