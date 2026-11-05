import { LIMITS, type PublishRequest } from "@emend/contract";
import { afterEach, beforeEach, expect, test } from "vitest";
import { threads } from "../../db/schema.ts";
import { mailboxFixture } from "../mailbox/test-support.ts";
import { expectPaced, insertedRows, observePacing, type PacingEvent, renderUnits } from "../pacing-test-support.ts";
import { insertChangedBlocks } from "./changed.ts";
import { ingest } from "./ingest.ts";

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
const input = (): PublishRequest => ({
  reviewKey: "b".repeat(64),
  repo: null,
  branch: null,
  title: "Synthetic pacing",
  base: null,
  head: null,
  topics: [],
  files: [],
  writeup: { overview: "Synthetic", tldr: "", decisions: null, topics: {} },
});
const file = (path: string): PublishRequest["files"][number] => ({
  path,
  role: "diff",
  oldPath: null,
  oldBlob: null,
  newBlob: null,
  flag: "binary",
});
const publish = (body: PublishRequest) =>
  ingest(f.ownerId, f.instanceId, body, {
    db: f.deps.db,
    blobs: f.deps.blobs,
    baseUrl: f.deps.config.baseUrl,
    executor: f.deps.publishExecutor,
  });

// The loop yields every 100 files, and a revision caps notes at agentNotesPerRevision.
const fileRowBound = 100 + LIMITS.agentNotesPerRevision;
test(`publish-files: at most ${fileRowBound} file and agent-note rows between yields`, async () => {
  const FILES_PER_YIELD = 100;
  const hash = await f.deps.blobs.put(f.ownerId, Buffer.from("Synthetic\n"), "text/plain");
  const notedFiles = Math.floor(LIMITS.agentNotesPerRevision / LIMITS.agentNotesPerFile);
  const noteCount = notedFiles * LIMITS.agentNotesPerFile;
  // Two full batches and a tail exercise at least two yields.
  const fileCount = 2 * FILES_PER_YIELD + 1;
  const body = input();
  body.files = Array.from({ length: fileCount }, (_, i) => ({
    ...file(`${i}.ts`),
    newBlob: hash,
    flag: null,
    // Some files carry the maximum notes; every note insert contributes a work unit.
    notes:
      i < notedFiles
        ? Array.from({ length: LIMITS.agentNotesPerFile }, () => ({
            side: "new" as const,
            start: 1,
            end: 1,
            summary: "Synthetic note",
          }))
        : [],
  }));
  log = observePacing(f.deps);
  await publish(body);
  const fileAndNoteRows = (event: PacingEvent) => insertedRows("files")(event) + insertedRows("agent_notes")(event);
  expect(expectPaced(log.events, "publish-files", fileAndNoteRows, fileRowBound)).toBe(fileCount + noteCount);
  expect(log.events.reduce((n, e) => n + insertedRows("agent_notes")(e), 0)).toBe(noteCount);
});

test("publish-placements: at most 100 placement rows between yields", async () => {
  await f.db.query((q) =>
    q.insert(threads).values(
      Array.from({ length: 201 }, () => ({
        ownerId: f.ownerId,
        reviewId: f.reviewId,
        createdRevisionId: f.revisionId,
        target: { kind: "review" as const },
      })),
    ),
  );
  log = observePacing(f.deps);
  const result = await publish({ ...input(), reviewId: f.reviewId, files: [file("one.bin")] });
  expect(result.placed).toBe(201);
  // One file also exercises the shared insertion counter's offset.
  expect(expectPaced(log.events, "publish-placements", insertedRows("placements"), 100)).toBe(201);
});

test("publish-doc-assets: at most 500 association rows between yields", async () => {
  const html = await f.deps.blobs.put(f.ownerId, Buffer.from("<p>Synthetic</p>"), "text/html");
  const asset = await f.deps.blobs.put(f.ownerId, Buffer.from("x"), "text/css");
  const assets = Array.from({ length: 501 }, (_, i) => `${i}.css`);
  const body = input();
  body.files = [
    ...["a.html", "b.html"].map((path) => ({
      ...file(path),
      role: "doc" as const,
      newBlob: html,
      flag: null,
      assets,
    })),
    ...assets.map((path) => ({ ...file(path), role: "asset" as const, newBlob: asset, flag: null })),
  ];
  log = observePacing(f.deps);
  await publish(body);
  expect(expectPaced(log.events, "publish-doc-assets", insertedRows("doc_assets"), 500)).toBe(1002);
});

test("publish-changed: at most 500 packed changed-block ids between yields", async () => {
  const ids = Array.from({ length: 1001 }, (_, i) => `overview-${i.toString(16).padStart(8, "0")}`);
  const packed = new TextEncoder().encode(ids.map((id) => JSON.stringify(id)).join("\n")).buffer;
  log = observePacing(f.deps);
  await f.db.transaction((q) => insertChangedBlocks(q, f.ownerId, f.revisionId, packed), { offThread: true });
  expect(expectPaced(log.events, "publish-changed", insertedRows("changed_blocks"), 500)).toBe(1001);
});

test("publish-render: HTML metadata, writeup and Markdown docs do at most two executor calls or blob puts between yields", async () => {
  const html = await Promise.all(
    ["First", "Second"].map((text) => f.deps.blobs.put(f.ownerId, Buffer.from(`<p>${text}</p>`), "text/html")),
  );
  const markdown = await Promise.all(
    ["First", "Second", "Third"].map((text) =>
      f.deps.blobs.put(f.ownerId, Buffer.from(`# ${text}\n\nSynthetic doc.`), "text/markdown"),
    ),
  );
  const body = input();
  body.files = [
    ...html.map((hash, i) => ({ ...file(`${i}.html`), role: "doc" as const, newBlob: hash, flag: null })),
    ...markdown.map((hash, i) => ({ ...file(`${i}.md`), role: "doc" as const, newBlob: hash, flag: null })),
  ];
  log = observePacing(f.deps);
  expect(await publish(body)).toMatchObject({ unrendered: [] });
  // Each rendered Markdown doc costs one executor call plus one blob put: a two-unit bound.
  expect(expectPaced(log.events, "publish-render", renderUnits, 2)).toBe(14);
  expect(log.events.flatMap((event) => (event.kind === "executor" ? [event.work] : []))).toEqual([
    ...Array.from({ length: 5 }, () => "doc-metadata"),
    "writeup",
    "doc",
    "doc",
    "doc",
  ]);
  const writeup = log.events.findIndex((event) => event.kind === "executor" && event.work === "writeup");
  expect(writeup).toBeGreaterThanOrEqual(0);
  const renderedPut = log.events.findIndex((event, index) => index > writeup && event.kind === "blob-put");
  expect(renderedPut).toBeGreaterThan(writeup);
  const sourcePut = log.events.findIndex((event, index) => index > renderedPut && event.kind === "blob-put");
  expect(sourcePut).toBeGreaterThan(renderedPut);
  expect(
    log.events.slice(writeup + 1, renderedPut),
    "writeup executor must yield before rendered blob put",
  ).toContainEqual({
    kind: "yield",
    phase: "publish-render",
  });
  expect(
    log.events.slice(renderedPut + 1, sourcePut),
    "rendered blob must yield before source blob put",
  ).toContainEqual({
    kind: "yield",
    phase: "publish-render",
  });
});

test("publish-finalize: each publish yields after its final review update", async () => {
  log = observePacing(f.deps);
  await publish(input());
  await publish(input());
  const updates = (event: PacingEvent | undefined) =>
    Number(event?.kind === "statement" && /^update "reviews"/.test(event.sql));
  expect(expectPaced(log.events, "publish-finalize", updates, 1)).toBe(2);
  const finalYields = log.events.flatMap((event, index) =>
    event.kind === "yield" && event.phase === "publish-finalize" ? [index] : [],
  );
  for (const index of finalYields) expect(updates(log.events[index - 1])).toBe(1);
});
