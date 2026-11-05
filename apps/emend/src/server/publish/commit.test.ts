import { LIMITS, PublishResponse } from "@emend/contract";
import { eq } from "drizzle-orm";
import { expect, test, vi } from "vitest";
import { changedBlocks } from "../../db/schema.ts";
import { commitFixture, publishPhases } from "./commit-test-support.ts";

vi.mock("node:worker_threads", async (original) => {
  const module = await original<typeof import("node:worker_threads")>();
  return {
    ...module,
    Worker: class extends module.Worker {
      constructor(...args: ConstructorParameters<typeof module.Worker>) {
        super(args[1]?.eval ? args[0] : new URL("./commit-worker.fixture.ts", import.meta.url), args[1]);
      }
    },
  };
});

test("publishing at the block cap over a cap-sized previous revision serves bearer GET and HEAD in every phase", async () => {
  let probing = false;
  const preparations: Promise<void>[] = [];
  const samples = new Set<string>();
  const probe = async (phase: string) => {
    const [get, head] = await Promise.all([f.get(), f.head()]);
    expect(get.status, `${phase} GET`).toBe(200);
    expect(head.status, `${phase} HEAD`).toBe(204);
    samples.add(phase);
  };
  const f = await commitFixture(async (phase, run) => {
    if (!probing) return run();
    const pending = probe(phase);
    try {
      return await run();
    } finally {
      await pending;
      preparations.push(probe("prepare"));
    }
  });
  try {
    probing = true;
    const response = await f.publish(true);
    probing = false;
    await Promise.all(preparations);
    expect(response.status).toBe(200);
    expect(PublishResponse.parse(await response.json()).unrendered).toEqual([]);
    const changed = await f.db.query((q) =>
      q.select({ revision: changedBlocks.revisionId }).from(changedBlocks).where(eq(changedBlocks.ownerId, f.ownerId)),
    );
    const counts = new Map<string, number>();
    for (const row of changed) counts.set(row.revision, (counts.get(row.revision) ?? 0) + 1);
    expect(counts.has(f.previous.id)).toBe(false);
    expect([...counts.values()]).toEqual([LIMITS.blocksPerRevision]);
    for (const phase of publishPhases) expect(samples.has(phase), phase).toBe(true);
  } finally {
    probing = false;
    try {
      await Promise.all(preparations);
    } finally {
      vi.restoreAllMocks();
      await f.cleanup();
    }
  }
}, 20000);
