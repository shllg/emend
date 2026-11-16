import { RevisionView } from "@emend/contract";
import { expect, onTestFinished, test } from "vitest";
import { bundle, importFixture } from "./import-test-support.ts";

test("imports previously published writeups with unlisted images unchanged", async () => {
  const f = await importFixture();
  onTestFinished(() => f.cleanup());
  const input = await bundle(f);
  const sourceBlob = await f.deps.blobs.put(
    f.ownerId,
    Buffer.from(
      JSON.stringify({
        overview: "Screenshot: ![Before](media/missing.png)",
        tldr: "",
        decisions: null,
        topics: {},
      }),
    ),
    "application/json",
  );
  for (const writeup of input.writeups) writeup.sourceBlob = sourceBlob;
  expect((await f.importRequest("/import", input)).status).toBe(201);
  for (const { seq } of input.revisions) {
    const response = await f.request(`/reviews/${input.review.id}/revisions/${seq}`, "GET");
    expect(response.status).toBe(200);
    const view = RevisionView.parse(await response.json());
    expect(view.writeup.sections.find((section) => section.key === "overview")?.blocks[0]?.html).toBe(
      '<p>Screenshot: <img alt="Before"></p>',
    );
  }
});
