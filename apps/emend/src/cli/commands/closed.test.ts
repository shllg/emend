import { randomUUID } from "node:crypto";
import { WaitResult } from "@emend/contract";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { run } from "../../main.ts";
import * as executors from "../../server/publish/executor.ts";
import { workInThread } from "../../test/in-thread-worker.ts";
import { directFixture } from "../direct-test-support.ts";
import { CliError } from "../http.ts";
import { deletedError } from "../moved.ts";
import * as pauses from "../pause.ts";
import { commandFixture } from "../test-support.ts";
import { takeFeedback } from "./wait.ts";

vi.mock("../pause.ts", async (original) => ({ ...(await original<typeof import("../pause.ts")>()) }));

vi.mock("../../server/publish/executor.ts", async (original) => ({
  ...(await original<typeof import("../../server/publish/executor.ts")>()),
}));

beforeEach(() => {
  workInThread(executors);
});

afterEach(() => vi.restoreAllMocks());

const hub = { url: "https://hub.example", token: `em_${"a".repeat(43)}`, via: "hub" } as const;
const reviewId = randomUUID();
const deleted = (id: string) => `emend: review ${id} was deleted or never existed\n`;

test.each(["wait", "feedback"])(
  "direct %s on a retired review prints one closed object, exits 0 and confirms it",
  async (command) => {
    const f = await directFixture();
    const { result } = await f.publish();
    const server = await f.reviewer();
    expect((await server.request(`/reviews/${result.reviewId}/retire`, {})).status).toBe(204);
    const out = f.output();
    expect(await run([command, result.reviewId, ...(command === "wait" ? ["--timeout", "1"] : [])], out.io)).toBe(0);
    expect(out.stderr).toEqual([]);
    expect(out.stdout).toHaveLength(1);
    const printed = WaitResult.parse(JSON.parse(out.stdout[0] ?? ""));
    expect(printed).toMatchObject({ kind: "closed", reviewId: result.reviewId, reason: "retired", until: null });
    expect(
      await server.db.read((q) =>
        q.values(sql`select confirmed_at is not null from deliveries where owner_id = ${server.ownerId}`),
      ),
    ).toEqual([[1]]);
    expect(
      await server.db.read((q) =>
        q.values(
          sql`select released_reason from reviews where owner_id = ${server.ownerId} and id = ${result.reviewId}`,
        ),
      ),
    ).toEqual([["retired"]]);
  },
);

test("direct wait on a snoozed review prints closed with the wake time at once", async () => {
  const f = await directFixture();
  const { result } = await f.publish();
  const server = await f.reviewer();
  const until = new Date(Date.now() + 3_600_000).toISOString();
  expect((await server.request(`/reviews/${result.reviewId}/snooze`, { until })).status).toBe(204);
  const out = f.output();
  const pause = vi.spyOn(pauses, "pause");
  expect(await run(["wait", result.reviewId, "--timeout", "30"], out.io)).toBe(0);
  expect(pause).not.toHaveBeenCalled();
  expect(JSON.parse(out.stdout[0] ?? "")).toMatchObject({ kind: "closed", reason: "snoozed", until });
});

test.each(["wait", "feedback"])(
  "direct %s on a deleted review exits 1 with one stderr line and no stdout",
  async (command) => {
    const f = await directFixture();
    const { result } = await f.publish();
    const server = await f.reviewer();
    const response = await server.app.request(`http://127.0.0.1:3636/api/v1/reviews/${result.reviewId}`, {
      method: "DELETE",
      headers: server.headers(),
    });
    expect(response.status).toBe(204);
    const out = f.output();
    expect(await run([command, result.reviewId], out.io)).toBe(1);
    expect(out.stdout).toEqual([]);
    expect(out.stderr).toEqual([deleted(result.reviewId)]);
  },
);

test("direct wait on an id that never existed prints the same line", async () => {
  const f = await directFixture();
  await f.publish();
  const out = f.output();
  const id = randomUUID();
  expect(await run(["wait", id], out.io)).toBe(1);
  expect(out.stdout).toEqual([]);
  expect(out.stderr).toEqual([deleted(id)]);
});

test("a hub take announces closed in its body and parses a closed answer", async () => {
  const f = await commandFixture();
  const bodies: unknown[] = [];
  const answer = {
    kind: "closed",
    reviewId,
    deliveryId: randomUUID(),
    revision: 2,
    reason: "snoozed",
    until: "2026-11-05T09:00:00.000Z",
  };
  f.setResponse(async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json(answer);
  });
  expect(await takeFeedback(f.dir, hub, reviewId, 0)).toEqual(answer);
  expect(bodies).toEqual([expect.objectContaining({ accepts: ["closed"] })]);
});

test("a hub 404 on take becomes the deleted-or-never-existed line", async () => {
  const f = await commandFixture();
  f.setResponse(async () =>
    Response.json({ error: { code: "unknown_review", message: "The review was not found." } }, { status: 404 }),
  );
  const error = await takeFeedback(f.dir, hub, reviewId, 0).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(CliError);
  expect((error as CliError).message).toBe(`review ${reviewId} was deleted or never existed`);
});

test("deletedError says deleted on the hub only for a local copy that moved to that hub", async () => {
  const f = await directFixture();
  const { result } = await f.publish();
  const server = await f.reviewer();
  const unknown = new (await import("../http.ts")).CliApiError("unknown_review");
  await expect(deletedError(f.stateDir, unknown, result.reviewId, "https://hub.example")).rejects.toThrow(
    `review ${result.reviewId} was deleted or never existed`,
  );
  await server.db.query((q) =>
    q.run(
      sql`update reviews set moved_to_url = ${`https://hub.example/r/${result.reviewId}`} where owner_id = ${server.ownerId} and id = ${result.reviewId}`,
    ),
  );
  await expect(deletedError(f.stateDir, unknown, result.reviewId, "https://hub.example")).rejects.toThrow(
    `review ${result.reviewId} was deleted on the hub`,
  );
  // Another hub, or other errors, are not rewritten.
  await expect(deletedError(f.stateDir, unknown, result.reviewId, "https://other.example")).rejects.toThrow(
    "was deleted or never existed",
  );
  const other = new (await import("../http.ts")).CliApiError("rate_limited");
  await expect(deletedError(f.stateDir, other, result.reviewId, "https://hub.example")).rejects.toBe(other);
});
