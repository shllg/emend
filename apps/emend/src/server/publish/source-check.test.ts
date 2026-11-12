import type { PublishRequest } from "@emend/contract";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { snapshot } from "../../cli/attach/bundle.ts";
import { prepareImport } from "../import/prepare.ts";
import { mailboxFixture } from "../mailbox/test-support.ts";
import { ingest } from "./ingest.ts";
import { type Executor, executeWork } from "./work.ts";

let f: Awaited<ReturnType<typeof mailboxFixture>>;
beforeEach(async () => {
  f = await mailboxFixture();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await f.cleanup();
});

test.each(["publish", "import"])("%s validates shared source bytes once across aliases", async (mode) => {
  const hash = await f.deps.blobs.put(f.ownerId, Buffer.from("Synthetic source\n"), "text/plain");
  const body: PublishRequest = {
    reviewKey: "b".repeat(64),
    repo: null,
    branch: null,
    title: "Synthetic",
    base: null,
    head: null,
    topics: [],
    writeup: { overview: "", tldr: "", decisions: null, topics: {} },
    files: Array.from({ length: 24 }, (_, i) => ({
      path: `alias-${i}.txt`,
      role: "doc",
      oldPath: null,
      oldBlob: null,
      newBlob: hash,
      flag: null,
    })),
  };
  const get = vi.spyOn(f.deps.blobs, "get");
  const validationReads: number[] = [];
  const execute: Executor = async (work) => {
    // Rendering starts after validation; its own bounded read is not the text check.
    if (work.kind === "writeup") validationReads.push(get.mock.calls.filter(([, sha]) => sha === hash).length);
    return executeWork(work);
  };
  const publish = (executor: Executor) =>
    ingest(f.ownerId, f.instanceId, body, {
      db: f.db,
      blobs: f.deps.blobs,
      baseUrl: "http://127.0.0.1:3636",
      executor,
    });
  if (mode === "publish") {
    await publish(execute);
    expect(validationReads).toEqual([1]);
  } else {
    const first = await publish(executeWork);
    await publish(executeWork);
    const exported = await f.db.query((q) =>
      snapshot(q, f.ownerId, f.instanceId, first.reviewId, "https://hub.example", 1800000000000, false),
    );
    if (exported.kind !== "bundle") throw new Error("missing bundle");
    get.mockClear();
    const prepared = await prepareImport(f.ownerId, exported.bundle, { ...f.deps, publishExecutor: execute });
    try {
      // The second revision only adds the first revision's render read: validation
      // stays deduplicated across the entire import, including aliases in later revisions.
      expect(validationReads).toEqual([1, 2]);
      expect(prepared.rendered.size).toBe(2);
    } finally {
      f.deps.blobs.release(prepared.holds);
    }
  }
});
