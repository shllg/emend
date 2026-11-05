import { expect, onTestFinished, test } from "vitest";
import { files } from "../../db/schema.ts";
import { mailboxFixture } from "../mailbox/test-support.ts";
import { expectPaced, observePacing, unitsOf } from "../pacing-test-support.ts";
import { CLEANUP_BATCH } from "./lifecycle.ts";

test(`lifecycle-blob-cleanup: at most ${CLEANUP_BATCH} blob removals between yields after review deletion`, async () => {
  const f = await mailboxFixture();
  onTestFinished(() => f.cleanup());
  onTestFinished(() => f.blobCleanup());
  // Two CLEANUP_BATCH batches and a tail, with no shared hashes or retained references.
  const hashes: string[] = [];
  const count = 2 * CLEANUP_BATCH + 1;
  for (let i = 0; i < count; i++)
    hashes.push(await f.deps.blobs.put(f.ownerId, Buffer.from(`Synthetic ${i}`), "text/plain"));
  await f.db.query((q) =>
    q.insert(files).values(
      hashes.map((hash, ord) => ({
        ownerId: f.ownerId,
        revisionId: f.revisionId,
        path: `${ord}.txt`,
        role: "diff" as const,
        mediaType: "text/plain",
        ord,
        newBlob: hash,
      })),
    ),
  );
  const log = observePacing(f.deps);
  onTestFinished(() => log.restore());
  expect((await f.request(`/reviews/${f.reviewId}`, "DELETE")).status).toBe(204);
  await f.blobCleanup();
  expect(expectPaced(log.events, "lifecycle-blob-cleanup", unitsOf("blob-removal"), CLEANUP_BATCH)).toBe(count);
});
