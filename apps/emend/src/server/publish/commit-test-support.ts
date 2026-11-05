import { join } from "node:path";
import { blockHash } from "@emend/core";
import { eq } from "drizzle-orm";
import { expect, vi } from "vitest";
import type { Db } from "../../db/client.ts";
import { revisions, threads } from "../../db/schema.ts";
import { testDb } from "../../db/test-support.ts";
import { BlobStore } from "../../store/blobs.ts";
import { createApp } from "../app.ts";
import { createToken } from "../auth/tokens.ts";
import { workerExecutor } from "./executor.ts";

export const publishPhases = [
  "snapshot",
  "writeup",
  "doc",
  "resection",
  "blob-read",
  "blob-store",
  "place",
  "changed",
  "prepare",
  "commit",
];

type During = <T>(phase: string, run: () => Promise<T>) => Promise<T>;

/** The same cap-sized previous/current revisions and anchors for the gate and bench. */
export async function commitFixture(during: During) {
  const f = await testDb();
  const execute = workerExecutor();
  const writer = { transaction: f.db.transaction.bind(f.db) };
  const cleanup = async () => {
    try {
      await execute.close();
    } finally {
      await f.cleanup();
    }
  };
  try {
    const store = new BlobStore(f.db, join(f.dir, "state"));
    const hash = await store.put(f.ownerId, Buffer.from("first"), "text/markdown");
    const nextHash = await store.put(f.ownerId, Buffer.from("second"), "text/markdown");
    const token = (await createToken(f.db, f.ownerId, "agent", { instanceId: f.instanceId })).secret;
    const origin = "http://127.0.0.1:3636";
    const headers = { Host: "127.0.0.1:3636", Authorization: `Bearer ${token}` };
    const db: Db = {
      ...f.db,
      query: (callback) => during("snapshot", () => f.db.query(callback)),
      transaction: (callback, options) => during("commit", () => writer.transaction(callback, options)),
    };
    for (const method of ["get", "put"] as const) {
      // Store probes include main-thread byte hashing and persistence between worker phases.
      if (method === "get") {
        const get = store.get.bind(store);
        vi.spyOn(store, "get").mockImplementation((...args) => during("blob-read", () => get(...args)));
      } else {
        const put = store.put.bind(store);
        vi.spyOn(store, "put").mockImplementation((...args) => during("blob-store", () => put(...args)));
      }
    }
    const app = createApp({
      db,
      blobs: store,
      instance: { id: f.instanceId, name: "Synthetic" },
      now: Date.now,
      publishExecutor: (work) => during(work.kind, () => execute(work)),
      config: {
        baseUrl: origin,
        allowedHosts: ["127.0.0.1:3636"],
        appOrigins: [origin],
        secureCookieHost: undefined,
        webRoot: f.dir,
        serverKey: "A".repeat(43),
      },
    });
    const publish = (second: boolean) =>
      app.request(`${origin}/api/v1/publish`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          reviewKey: "a".repeat(64),
          repo: null,
          branch: null,
          title: "Synthetic",
          base: null,
          head: null,
          topics: [],
          files: [
            ...["a.md", "b.md"].map((path) => ({
              path,
              role: "doc",
              oldPath: null,
              oldBlob: null,
              newBlob: second ? nextHash : hash,
              flag: null,
            })),
            ...Array.from({ length: 200 }, (_, i) => ({
              path: `${i}.bin`,
              role: "diff",
              oldPath: null,
              oldBlob: null,
              newBlob: null,
              flag: "binary",
            })),
          ],
          writeup: { overview: second ? "second" : "first", tldr: "", decisions: null, topics: {} },
        }),
      });
    expect((await publish(false)).status).toBe(200);
    const previous = await f.db.query((q) => q.select().from(revisions).where(eq(revisions.ownerId, f.ownerId)).get());
    if (!previous) throw new Error("missing revision");
    const docSection = `doc-${await blockHash("a.md")}`;
    await f.db.query((q) =>
      q.insert(threads).values([
        {
          ownerId: f.ownerId,
          reviewId: previous.reviewId,
          createdRevisionId: previous.id,
          target: { kind: "writeup-span", blockId: "overview-00000000", quote: "needle", prefix: "", suffix: "" },
        },
        {
          ownerId: f.ownerId,
          reviewId: previous.reviewId,
          createdRevisionId: previous.id,
          target: {
            kind: "doc-span",
            path: "a.md",
            blockId: `${docSection}-00000000`,
            quote: "needle",
            prefix: "",
            suffix: "",
          },
        },
      ]),
    );
    return {
      ...f,
      writer,
      previous,
      publish,
      get: () => app.request(`${origin}/api/v1/capabilities`, { headers }),
      head: () => app.request(`${origin}/api/v1/blobs/${hash}`, { method: "HEAD", headers }),
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
