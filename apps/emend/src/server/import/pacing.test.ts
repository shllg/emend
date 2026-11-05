import { randomUUID } from "node:crypto";
import { ImportBundle, indexImportBundle } from "@emend/contract";
import { afterEach, beforeEach, expect, test } from "vitest";
import { devices } from "../../db/schema.ts";
import type { Principal } from "../auth/principal.ts";
import { createToken } from "../auth/tokens.ts";
import { mailboxFixture } from "../mailbox/test-support.ts";
import { checkedIds, expectPaced, insertedRows, observePacing, unitsOf } from "../pacing-test-support.ts";
import { importReview } from "./ingest.ts";
import { importPlacements } from "./placements.ts";

let f: Awaited<ReturnType<typeof mailboxFixture>>;
let log: ReturnType<typeof observePacing> | undefined;
beforeEach(async () => {
  f = await mailboxFixture();
});
afterEach(async () => {
  log?.restore();
  log = undefined;
  await f.cleanup();
});

async function bundle(fileCount: number): Promise<ImportBundle> {
  const reviewId = randomUUID();
  const revisionId = randomUUID();
  const now = new Date(f.deps.now()).toISOString();
  const source = await f.deps.blobs.put(
    f.ownerId,
    Buffer.from(JSON.stringify({ overview: "Synthetic", tldr: "", decisions: null, topics: {} })),
    "application/json",
  );
  return ImportBundle.parse({
    review: {
      id: reviewId,
      originInstanceId: f.instanceId,
      reviewKey: "b".repeat(64),
      repo: null,
      branch: null,
      title: "Synthetic import",
      state: "open",
      approvedRevision: null,
      createdAt: now,
      updatedAt: now,
    },
    revisions: [
      { id: revisionId, reviewId, seq: 1, base: null, head: null, main: null, writeupEmpty: false, createdAt: now },
    ],
    files: Array.from({ length: fileCount }, (_, ord) => ({
      id: randomUUID(),
      revisionId,
      path: `${ord}.bin`,
      role: "diff",
      oldPath: null,
      status: null,
      topicSlug: null,
      ord,
      oldBlob: null,
      newBlob: null,
      renderedBlob: null,
      flag: "binary",
      parentDocId: null,
    })),
    writeups: [{ id: randomUUID(), revisionId, sourceBlob: source, renderedBlob: source }],
    topics: [],
    docAssets: [],
    threads: [],
    comments: [],
    sends: [],
    deliveries: [],
  });
}
async function machine(): Promise<Principal> {
  const deviceId = randomUUID();
  await f.db.query((q) =>
    q.insert(devices).values({
      id: deviceId,
      ownerId: f.ownerId,
      kind: "machine",
      name: "Synthetic",
      instanceId: f.instanceId,
    }),
  );
  const token = await createToken(f.db, f.ownerId, "agent", { deviceId, instanceId: f.instanceId });
  return { ownerId: f.ownerId, tokenId: token.id, kind: "agent", instanceId: f.instanceId, scopes: [] };
}

test("import-insert: at most 500 inserted rows between yields, including off-thread bulk statements", async () => {
  const input = await bundle(1001);
  const principal = await machine();
  log = observePacing(f.deps);
  expect(await importReview(principal, input, f.deps)).toEqual({ skipped: false });
  expectPaced(log.events, "import-insert", insertedRows(), 500);
  expect(log.events.reduce((n, event) => n + insertedRows("files")(event), 0)).toBe(1001);
});

test("import-check-ids: at most 500 collision-checked ids between yields", async () => {
  const input = await bundle(1001);
  const principal = await machine();
  log = observePacing(f.deps);
  expect(await importReview(principal, input, f.deps)).toEqual({ skipped: false });
  // Files plus the review, revision and writeup; one unit per id, not per SQL statement or table probe.
  expect(expectPaced(log.events, "import-check-ids", checkedIds, 500)).toBe(1004);
});

test("import-placement-copy: each distinct payload copy yields before the next", async () => {
  const input = await bundle(2);
  for (const [i, file] of input.files.entries()) {
    file.role = "doc";
    file.flag = null;
    file.path = `${i}.html`;
    file.newBlob = await f.deps.blobs.put(f.ownerId, Buffer.from(`<p>Synthetic ${i}</p>`), "text/html");
    input.threads.push({
      id: randomUUID(),
      reviewId: input.review.id,
      createdRevisionId: file.revisionId,
      state: "open",
      createdAt: input.review.createdAt,
      updatedAt: input.review.updatedAt,
      target: { kind: "html-span", path: file.path, quote: `Synthetic ${i}`, prefix: "", suffix: "" },
    });
  }
  const revision = indexImportBundle(ImportBundle.parse(input)).revisions.values().next().value;
  if (!revision) throw new Error("Missing synthetic revision");
  log = observePacing(f.deps);
  const execute = f.deps.publishExecutor;
  if (!execute) throw new Error("Missing executor");
  const writeup = input.writeups[0];
  if (!writeup) throw new Error("Missing synthetic writeup");
  const rows = await importPlacements()(
    revision,
    { renderedBlob: writeup.renderedBlob, docBlobs: new Map() },
    async (hash) => {
      const bytes = await f.deps.blobs.get(f.ownerId, hash);
      if (!bytes) throw new Error("Missing synthetic blob");
      return Uint8Array.from(bytes).buffer;
    },
    execute,
  );
  expect(rows).toHaveLength(2);
  expect(rows.every((row) => row.status === "placed")).toBe(true);
  expect(expectPaced(log.events, "import-placement-copy", unitsOf("payload-copy"), 1)).toBe(2);
});
