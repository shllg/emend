import { ImportBundle } from "@emend/contract";
import { beforeEach, expect, test, vi } from "vitest";
import { run } from "../main.ts";
import * as executors from "../server/publish/executor.ts";
import { workInThread } from "../test/in-thread-worker.ts";
import { snapshot } from "./attach/bundle.ts";
import { directFixture } from "./direct-test-support.ts";

vi.mock("../server/publish/executor.ts", async (original) => ({
  ...(await original<typeof import("../server/publish/executor.ts")>()),
}));

beforeEach(() => {
  workInThread(executors);
});

test("an attach snapshot leaves out a send-less closed delivery, so the bundle stays valid", async () => {
  const f = await directFixture();
  const { result } = await f.publish();
  const server = await f.reviewer();
  expect((await server.request(`/reviews/${result.reviewId}/retire`, {})).status).toBe(204);
  const out = f.output();
  expect(await run(["wait", result.reviewId, "--timeout", "1"], out.io)).toBe(0);
  expect(JSON.parse(out.stdout[0] ?? "")).toMatchObject({ kind: "closed" });
  const snap = await server.db.transaction((q) =>
    snapshot(
      q,
      server.ownerId,
      server.instance.id,
      result.reviewId,
      `https://hub.example/r/${result.reviewId}`,
      Date.now(),
    ),
  );
  if (snap.kind !== "bundle") throw new Error(`expected a bundle, got ${snap.kind}`);
  expect(snap.bundle.deliveries).toEqual([]);
  expect(snap.bundle.review.state).toBe("settled");
  expect(ImportBundle.safeParse(JSON.parse(snap.json)).success).toBe(true);
});
