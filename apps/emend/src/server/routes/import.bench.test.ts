import { randomUUID } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { type ImportBundle, LIMITS } from "@emend/contract";
import * as core from "@emend/core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { emitBench } from "../bench-support.ts";
import { workerExecutor } from "../publish/executor.ts";
import {
  capsBundle,
  escapedHtmlBundle,
  importFixture,
  metadataBundle,
  metadataShapes,
  multibyteCapsBundle,
  nestedSourceBundle,
  replayBundle,
  required,
  sharedTargetBundle,
  snapshot,
  unchangedSideShapes,
  unchangedSidesBundle,
} from "./import-test-support.ts";

let f: Awaited<ReturnType<typeof importFixture>>;
beforeEach(async () => {
  f = await importFixture();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await f.cleanup();
});

async function measureImport(bench: string, input: ImportBundle, details: Record<string, unknown> = {}) {
  const loop = monitorEventLoopDelay({ resolution: 1 });
  const transaction = f.db.transaction.bind(f.db);
  let writerMs = 0;
  const writer = vi.spyOn(f.db, "transaction").mockImplementation(async (fn, options) => {
    let entered = 0;
    const result = await transaction((q) => {
      entered = performance.now();
      return fn(q);
    }, options);
    writerMs += performance.now() - entered;
    return result;
  });
  try {
    loop.enable();
    await delay(5);
    const start = performance.now();
    const response = await f.importRequest("/import", input);
    const elapsedMs = performance.now() - start;
    await delay(5);
    loop.disable();
    emitBench({
      bench,
      ...details,
      status: response.status,
      elapsedMs,
      eventLoopMaxMs: loop.max / 1e6,
      writerMs,
    });
    return response;
  } finally {
    loop.disable();
    writer.mockRestore();
  }
}

test("import at all five count ceilings", async () => {
  const { input } = await capsBundle(f);
  const before = await snapshot(f);
  const response = await measureImport("import-count-caps", input, {
    rows: LIMITS.importRows,
    bodyBytes: Buffer.byteLength(JSON.stringify(input)),
  });
  expect(response.status).toBe(201);
  const after = await snapshot(f);
  expect(after.reduce((sum, row, i) => sum + (row?.n ?? 0) - (before[i]?.n ?? 0), 0)).toBe(LIMITS.importRows);
});

test("import multibyte caps with the production writer", async () => {
  const { input, derivedBytes } = await multibyteCapsBundle(f);
  const response = await measureImport("import-multibyte-caps", input, {
    derivedBytes,
    bodyBytes: Buffer.byteLength(JSON.stringify(input)),
  });
  expect(response.status).toBe(201);
});

test("import 10000 comments sharing a large target", async () => {
  const { input } = await sharedTargetBundle(f);
  const execute = workerExecutor();
  f.deps.publishExecutor = execute;
  try {
    expect((await measureImport("import-shared-target", input)).status).toBe(201);
  } finally {
    await execute.close();
  }
});

test("import repeated nested-array writeup source", async () => {
  const input = await nestedSourceBundle(f);
  const execute = workerExecutor();
  f.deps.publishExecutor = execute;
  try {
    const response = await measureImport("import-nested-source", input);
    expect([201, 400]).toContain(response.status);
    if (response.status === 400) {
      expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
    }
  } finally {
    await execute.close();
  }
});

test("import 26 escaped-control HTML docs", async () => {
  const input = await escapedHtmlBundle(f, 26, 5_000_000);
  const execute = workerExecutor();
  f.deps.publishExecutor = execute;
  try {
    expect((await measureImport("import-escaped-html", input, { docs: 26, controls: 5_000_000 })).status).toBe(201);
  } finally {
    await execute.close();
  }
});

test.each(metadataShapes)("import shared metadata: $label", async (shape) => {
  const input = await metadataBundle(f, shape);
  const execute = workerExecutor();
  f.deps.publishExecutor = execute;
  const original = LIMITS.importPlacementBytes;
  try {
    Object.assign(LIMITS, { importPlacementBytes: 32 * 1024 * 1024 });
    expect((await measureImport("import-shared-metadata", input, { shape: shape.label })).status).toBe(201);
  } finally {
    Object.assign(LIMITS, { importPlacementBytes: original });
    await execute.close();
  }
});

test.each(unchangedSideShapes)("import unchanged sides: $threads threads, $sideBytes bytes", async (shape) => {
  const input = await unchangedSidesBundle(f, shape);
  const execute = workerExecutor();
  f.deps.publishExecutor = execute;
  try {
    expect((await measureImport("import-unchanged-sides", input, shape)).status).toBe(201);
  } finally {
    await execute.close();
  }
});

// Real rendering, storage, worker transfers, placement and insertion.
// Fill renderedBytesPerRevision, with a maximum writeup and HTML doc alongside Markdown docs.
test("maximum content import responsiveness", async () => {
  const input = await replayBundle(f, 1, 1);
  const revisionId = required(input.revisions[0]).id;
  const template = required(input.files[0]);
  const thread = required(input.threads[0]);
  input.files = [];
  input.threads = [];
  const source = {
    overview: `needle${"w".repeat(LIMITS.writeupSectionBytes - 6)}`,
    tldr: "t".repeat(LIMITS.writeupSectionBytes),
    decisions: null,
    topics: {},
  };
  // Multibyte text fills the same encoded byte cap with fewer worker string code units.
  const content = (size: number) => `needle${"界".repeat(Math.floor((size - 6) / 3))}${"x".repeat((size - 6) % 3)}`;
  const markdown = content(LIMITS.markdownDocBytes);
  const html = `<p>${content(LIMITS.htmlDocBytes - 7)}</p>`;
  expect(Buffer.byteLength(html)).toBe(LIMITS.htmlDocBytes);
  const worker = workerExecutor();
  const loop = monitorEventLoopDelay({ resolution: 1 });
  let monitoring = false;
  let monitor: Promise<void> | undefined;
  let phase = "idle";
  let worstTick = { ms: 0, before: "", after: "" };
  let copyStart = 0,
    copyEnd = 0,
    copyMs = 0,
    copiedBytes = 0;
  const synchronous: Record<string, number> = {};
  const failures: { kind: string; format?: string; message: string }[] = [];
  try {
    // Calibration uses the same worker renderer outside the measured request.
    const writeup = await worker({ kind: "writeup", source, topics: [], media: [] });
    const doc = await worker({ kind: "doc", path: "0.md", source: new TextEncoder().encode(markdown).buffer });
    if (writeup.kind !== "writeup" || doc.kind !== "doc") throw new Error("Missing calibration");
    const hash = await f.deps.blobs.put(f.ownerId, Buffer.from(markdown), "text/markdown");
    const sourceHash = await f.deps.blobs.put(f.ownerId, Buffer.from(JSON.stringify(source)), "application/json");
    for (const row of input.writeups) row.sourceBlob = sourceHash;
    input.threads.push({
      ...thread,
      id: randomUUID(),
      target: {
        kind: "writeup-span",
        blockId: `overview-${await core.blockHash(source.overview)}`,
        quote: "needle",
        prefix: "",
        suffix: "",
      },
    });
    // These paragraphs have no headings or inferred titles, so each doc's metadata
    // uses its filename. It shares the render budget with the writeup and doc blocks;
    // omitting it leaves the final doc unrendered and its new thread invalid on import.
    const metadataSize = (path: string) => Buffer.byteLength(JSON.stringify({ title: path, headings: [] }));
    let metadataBytes = metadataSize("doc.html");
    let remaining = LIMITS.renderedBytesPerRevision - writeup.bytes.byteLength - metadataBytes;
    const overhead = doc.bytes.byteLength - 2 * Buffer.byteLength(markdown);
    for (let i = 0; ; i++) {
      const path = `${i}.md`;
      const ownMetadataBytes = metadataSize(path);
      if (remaining <= overhead + ownMetadataBytes + 12) break;
      const size = Math.min(LIMITS.markdownDocBytes, Math.floor((remaining - overhead - ownMetadataBytes) / 2));
      const text = content(size);
      const newBlob =
        size === LIMITS.markdownDocBytes ? hash : await f.deps.blobs.put(f.ownerId, Buffer.from(text), "text/markdown");
      input.files.push({ ...template, id: randomUUID(), revisionId, ord: i, path, newBlob });
      input.threads.push({
        ...thread,
        id: randomUUID(),
        target: {
          kind: "doc-span",
          path,
          blockId: `doc-${await core.blockHash(path)}-${await core.blockHash(text)}`,
          quote: "needle",
          prefix: "",
          suffix: "",
        },
      });
      metadataBytes += ownMetadataBytes;
      remaining -= 2 * size + overhead + ownMetadataBytes;
    }
    expect(remaining).toBeLessThanOrEqual(1);
    const htmlHash = await f.deps.blobs.put(f.ownerId, Buffer.from(html), "text/html");
    input.files.push({
      ...template,
      id: randomUUID(),
      revisionId,
      ord: input.files.length,
      path: "doc.html",
      newBlob: htmlHash,
    });
    input.threads.push({
      ...thread,
      id: randomUUID(),
      target: { kind: "html-span", path: "doc.html", quote: "needle", prefix: "", suffix: "" },
    });
    const stage = f.deps.blobs.stage.bind(f.deps.blobs);
    vi.spyOn(f.deps.blobs, "stage").mockImplementation((...args) => {
      const start = performance.now();
      phase = "blob-stage";
      try {
        return stage(...args);
      } finally {
        synchronous["blob-stage"] = Math.max(synchronous["blob-stage"] ?? 0, performance.now() - start);
        phase = "prepare";
      }
    });
    const slice = ArrayBuffer.prototype.slice;
    vi.spyOn(ArrayBuffer.prototype, "slice").mockImplementation(function (this: ArrayBuffer, ...args) {
      const start = performance.now();
      copyStart ||= start;
      const result = slice.apply(this, args);
      copyEnd = performance.now();
      copyMs += copyEnd - start;
      copiedBytes += result.byteLength;
      return result;
    });
    f.deps.publishExecutor = async (work) => {
      phase = work.kind;
      const start = performance.now();
      const pending = worker(work);
      synchronous[`${work.kind}-dispatch`] = Math.max(
        synchronous[`${work.kind}-dispatch`] ?? 0,
        performance.now() - start,
      );
      try {
        return await pending;
      } catch (error) {
        failures.push({
          kind: work.kind,
          ...(work.kind === "placement-doc" ? { format: work.format } : {}),
          message: String(error),
        });
        throw error;
      } finally {
        phase = "prepare";
      }
    };
    loop.enable();
    monitoring = true;
    monitor = (async () => {
      while (monitoring) {
        const start = performance.now(),
          before = phase;
        await delay(1);
        const ms = performance.now() - start;
        if (ms > worstTick.ms) worstTick = { ms, before, after: phase };
      }
    })();
    await delay(5);
    phase = "request";
    const start = performance.now();
    const response = await f.importRequest("/import", input);
    const elapsedMs = performance.now() - start;
    await delay(5);
    loop.disable();
    monitoring = false;
    await monitor;
    emitBench({
      bench: "import-maximum-content",
      status: response.status,
      elapsedMs,
      eventLoopMaxMs: loop.max / 1e6,
      worstTick,
      synchronous,
      failures,
      copyMs,
      copyBatchMs: copyEnd - copyStart,
      copiedBytes,
      writeupSourceBytes: LIMITS.writeupBytes,
      htmlBytes: LIMITS.htmlDocBytes,
      markdownDocs: input.files.length - 1,
      metadataBytes,
      renderedBytes: LIMITS.renderedBytesPerRevision - remaining,
    });
    expect(response.status, await response.text()).toBe(201);
  } finally {
    loop.disable();
    monitoring = false;
    try {
      await monitor;
    } finally {
      await worker.close();
    }
  }
});
