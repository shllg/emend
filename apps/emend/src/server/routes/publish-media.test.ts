import { PublishResponse, RevisionView } from "@emend/contract";
import { afterEach, beforeEach, expect, test } from "vitest";
import { mailboxFixture } from "../mailbox/test-support.ts";

let f: Awaited<ReturnType<typeof mailboxFixture>>;
beforeEach(async () => {
  f = await mailboxFixture();
});
afterEach(async () => {
  await f.cleanup();
});

// Synthetic PNG headers that differ in one trailing byte.
const png = (tail: string) =>
  Buffer.from(`89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489${tail}`, "hex");

async function publish(bytes: Buffer, reviewId?: string) {
  const newBlob = await f.deps.blobs.put(f.ownerId, bytes, "image/png");
  const response = await f.request(
    "/publish",
    "POST",
    {
      reviewId,
      reviewKey: "b".repeat(64),
      repo: null,
      branch: null,
      title: "Synthetic",
      base: null,
      head: null,
      topics: [],
      writeup: { overview: "![Before](media/a.png)", tldr: "Unchanged summary.", decisions: null, topics: {} },
      files: [{ path: "media/a.png", role: "asset", oldPath: null, oldBlob: null, newBlob, flag: null }],
    },
    "agent",
  );
  expect(response.status).toBe(200);
  const published = PublishResponse.parse(await response.json());
  return { reviewId: published.reviewId, newBlob };
}
async function view(reviewId: string, seq: number) {
  return RevisionView.parse(await (await f.request(`/reviews/${reviewId}/revisions/${seq}`, "GET")).json());
}
const imageBlock = (revision: RevisionView) => {
  const block = revision.writeup.sections.flatMap((s) => s.blocks).find((b) => b.html.includes("emend-media"));
  if (!block) throw new Error("Missing image block");
  return block;
};

test("a re-shot image at the same path gets a new block id and is listed as changed", async () => {
  const first = await publish(png("00"));
  await publish(png("01"), first.reviewId);
  const [one, two] = [await view(first.reviewId, 1), await view(first.reviewId, 2)];
  expect(imageBlock(one).html).toContain(`/api/v1/media/${first.newBlob}`);
  expect(imageBlock(two).id).not.toBe(imageBlock(one).id);
  expect(two.changedBlocks).toContainEqual({ blockId: imageBlock(two).id, revision: 2 });
});

test("the same bytes at the same path keep the block id and list nothing as changed", async () => {
  const first = await publish(png("00"));
  await publish(png("00"), first.reviewId);
  const [one, two] = [await view(first.reviewId, 1), await view(first.reviewId, 2)];
  expect(imageBlock(two).id).toBe(imageBlock(one).id);
  expect(two.changedBlocks.map((c) => c.blockId)).not.toContain(imageBlock(two).id);
});

test("a span comment on the caption survives a re-shot image with the same caption", async () => {
  const first = await publish(png("00"));
  const one = await view(first.reviewId, 1);
  const before = imageBlock(one);
  const created = await f.request(`/reviews/${first.reviewId}/threads`, "POST", {
    revision: 1,
    target: { kind: "writeup-span", blockId: before.id, quote: "Before", prefix: "", suffix: "" },
    body: "Which shot is this?",
  });
  expect(created.status).toBe(201);
  await publish(png("01"), first.reviewId);
  const two = await view(first.reviewId, 2);
  const after = imageBlock(two);
  expect(after.id).not.toBe(before.id);
  expect(two.threads).toHaveLength(1);
  // The placement is recorded as it is for any changed block with the same quote text.
  expect(two.threads[0]?.placement).toMatchObject({ status: "placed" });
  expect(JSON.stringify(two.threads[0]?.placement)).toContain(after.id);
});

test("a published image's block carries the pixel size read from its bytes", async () => {
  const first = await publish(png("00"));
  const html = imageBlock(await view(first.reviewId, 1)).html;
  expect(html).toContain('width="1" height="1"');
});

test("bytes that are not a readable image render without a size", async () => {
  const first = await publish(Buffer.from("not an image"));
  const html = imageBlock(await view(first.reviewId, 1)).html;
  expect(html).toContain(`/api/v1/media/${first.newBlob}`);
  expect(html).not.toMatch(/width=|height=/);
});
