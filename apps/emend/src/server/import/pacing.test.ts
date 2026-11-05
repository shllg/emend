import { randomUUID } from "node:crypto";
import { ImportBundle, indexImportBundle } from "@emend/contract";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { devices } from "../../db/schema.ts";
import type { Principal } from "../auth/principal.ts";
import { createToken } from "../auth/tokens.ts";
import { mailboxFixture } from "../mailbox/test-support.ts";
import {
  checkedIds,
  expectPaced,
  insertedRows,
  observePacing,
  type PacingEvent,
  type PacingUnit,
  unitsOf,
} from "../pacing-test-support.ts";
import { importReview } from "./ingest.ts";
import { importPlacements } from "./placements.ts";
import { prepareImport } from "./prepare.ts";

const observed = vi.hoisted(() => ({ record: undefined as ((unit: PacingUnit) => void) | undefined }));
vi.mock("../mailbox/payload.ts", async (original) => {
  const actual = await original<typeof import("../mailbox/payload.ts")>();
  return {
    ...actual,
    jsonBytes: (...args: Parameters<typeof actual.jsonBytes>) => {
      observed.record?.("comment-bytes");
      return actual.jsonBytes(...args);
    },
  };
});
vi.mock("./bytes.ts", async (original) => {
  const actual = await original<typeof import("./bytes.ts")>();
  const { changedBlocks } = await import("../../db/schema.ts");
  return {
    ...actual,
    derivedRowBytes: (...args: Parameters<typeof actual.derivedRowBytes>) => {
      if (args[0] === changedBlocks) observed.record?.("changed-block-bytes");
      return actual.derivedRowBytes(...args);
    },
  };
});

let f: Awaited<ReturnType<typeof mailboxFixture>>;
let log: ReturnType<typeof observePacing> | undefined;
beforeEach(async () => {
  f = await mailboxFixture();
});
afterEach(async () => {
  observed.record = undefined;
  log?.restore();
  log = undefined;
  vi.restoreAllMocks();
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
  input.review.repo = { key: "c".repeat(64), name: "Synthetic repo" };
  const principal = await machine();
  log = observePacing(f.deps);
  expect(await importReview(principal, input, f.deps)).toEqual({ skipped: false });
  expectPaced(log.events, "import-insert", insertedRows(), 500);
  const statements = (event: PacingEvent) => Number(event.kind === "statement" && event.table !== undefined);
  expectPaced(log.events, "import-insert", statements, 1);
  expect(log.events.reduce((n, event) => n + insertedRows("repos")(event), 0)).toBe(1);
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

async function commentsBundle(perSend: number[]): Promise<ImportBundle> {
  const input = await bundle(0);
  const revision = input.revisions[0];
  if (!revision) throw new Error("Missing synthetic revision");
  const threadId = randomUUID();
  const dates = { createdAt: input.review.createdAt, updatedAt: input.review.updatedAt };
  input.threads.push({
    id: threadId,
    reviewId: input.review.id,
    createdRevisionId: revision.id,
    target: { kind: "review" },
    state: "sent",
    ...dates,
  });
  for (const count of perSend) {
    const sendId = randomUUID();
    input.sends.push({
      id: sendId,
      reviewId: input.review.id,
      revisionId: revision.id,
      kind: "go",
      mode: "fix-clear",
      instruction: null,
      deliveryId: null,
      setAsideAt: null,
      createdAt: input.review.createdAt,
    });
    for (let i = 0; i < count; i++)
      input.comments.push({
        id: randomUUID(),
        reviewId: input.review.id,
        threadId,
        author: "user",
        body: `Synthetic comment ${i}`,
        outcome: null,
        sendId,
        ...dates,
      });
  }
  return ImportBundle.parse(input);
}

test.each([
  { label: "one send", perSend: [1001] },
  { label: "three sends with fewer than 500 comments each", perSend: [334, 334, 333] },
])("import-prepare-comments: at most 500 comment byte counts between yields ($label)", async ({ perSend }) => {
  const input = await commentsBundle(perSend);
  log = observePacing(f.deps);
  observed.record = log.record;
  const prepared = await prepareImport(f.ownerId, input, f.deps);
  f.deps.blobs.release(prepared.holds);
  // No instructions: every external jsonBytes call here measures exactly one comment body.
  expect(expectPaced(log.events, "import-prepare-comments", unitsOf("comment-bytes"), 500)).toBe(1001);
});

test("import-prepare-changed: at most 500 changed-block byte counts between yields", async () => {
  const input = await bundle(0);
  const first = input.revisions[0];
  if (!first) throw new Error("Missing synthetic revision");
  const second = { ...first, id: randomUUID(), seq: 2 };
  const source = await f.deps.blobs.put(
    f.ownerId,
    Buffer.from(
      JSON.stringify({
        overview: Array.from({ length: 1001 }, (_, i) => `Changed paragraph ${i}.`).join("\n\n"),
        tldr: "",
        decisions: null,
        topics: {},
      }),
    ),
    "application/json",
  );
  input.revisions.push(second);
  input.writeups.push({ id: randomUUID(), revisionId: second.id, sourceBlob: source, renderedBlob: source });
  const validated = ImportBundle.parse(input);
  log = observePacing(f.deps);
  observed.record = log.record;
  const prepared = await prepareImport(f.ownerId, validated, f.deps);
  f.deps.blobs.release(prepared.holds);
  expect(prepared.changedBlocks).toHaveLength(1001);
  expect(expectPaced(log.events, "import-prepare-changed", unitsOf("changed-block-bytes"), 500)).toBe(1001);
});

test("import-insert: maps at most 500 comment rows between yields", async () => {
  const input = await commentsBundle([1001]);
  const commentDate = new Date(f.deps.now() - 1000).toISOString();
  for (const comment of input.comments) comment.createdAt = comment.updatedAt = commentDate;
  const principal = await machine();
  log = observePacing(f.deps);
  const record = log.record;
  const parseDate = Date.parse;
  const parse = vi.spyOn(Date, "parse").mockImplementation((value) => {
    record("row-date");
    return parseDate(value);
  });
  expect(await importReview(principal, input, f.deps)).toEqual({ skipped: false });
  const metadataDates = [
    input.review.createdAt,
    input.review.updatedAt,
    ...input.revisions.map((row) => row.createdAt),
    ...input.threads.flatMap((row) => [row.createdAt, row.updatedAt]),
    ...input.sends.map((row) => row.createdAt),
  ];
  // Account for every parse: only comments use commentDate; the other six calls map metadata rows.
  expect(parse.mock.calls.filter(([value]) => value !== commentDate).map(([value]) => value)).toEqual(metadataDates);
  expect(parse.mock.calls.filter(([value]) => value === commentDate)).toHaveLength(2 * input.comments.length);
  expect(expectPaced(log.events, "import-insert", unitsOf("row-date"), 2 * 500)).toBe(
    2 * input.comments.length + metadataDates.length,
  );
});
