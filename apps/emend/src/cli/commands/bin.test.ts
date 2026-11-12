import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { revisions } from "../../db/schema.ts";
import { run } from "../../main.ts";
import * as executors from "../../server/publish/executor.ts";
import { workInThread } from "../../test/in-thread-worker.ts";
import { directFixture } from "../direct-test-support.ts";
import { CliApiError, CliError } from "../http.ts";
import { binnedError } from "../moved.ts";
import { commandFixture } from "../test-support.ts";
import { takeFeedback } from "./wait.ts";

vi.mock("../../server/publish/executor.ts", async (original) => ({
  ...(await original<typeof import("../../server/publish/executor.ts")>()),
}));

beforeEach(() => {
  workInThread(executors);
});
afterEach(() => vi.restoreAllMocks());

const hub = { url: "https://hub.example", token: `em_${"a".repeat(43)}`, via: "hub" } as const;
const inBin = (id: string) => `emend: review ${id} is in the bin\n`;
const byId = (id: string) =>
  `emend: review ${id} is in the bin. Restore it in Settings, or publish without --review and with a new --key for a new review.\n`;
const byKey =
  "emend: the review this publish would update is in the bin. Restore it in Settings, or pass a new --key for a new review.\n";
const byKeyShortcut =
  "emend: the review this publish would update is in the bin. Restore it in Settings, or pass --new for a new review.\n";

async function binned() {
  const f = await directFixture();
  const { result } = await f.publish();
  const server = await f.reviewer();
  expect((await server.request(`/reviews/${result.reviewId}/bin`, {})).status).toBe(204);
  return { f, server, id: result.reviewId };
}

test.each(["wait", "feedback"])("direct %s on a binned review prints one line and no stdout", async (command) => {
  const { f, id } = await binned();
  const out = f.output();
  expect(await run([command, id], out.io)).toBe(1);
  expect(out.stdout).toEqual([]);
  expect(out.stderr).toEqual([inBin(id)]);
});

test("direct reply on a comment of a binned review names the review", async () => {
  const f = await directFixture();
  const { result } = await f.publish();
  const server = await f.reviewer();
  const created = await server.request(`/reviews/${result.reviewId}/threads`, {
    revision: 1,
    target: { kind: "review" },
    body: "Please explain.",
  });
  const { commentId } = (await created.json()) as { commentId: string };
  expect((await server.request(`/reviews/${result.reviewId}/bin`, {})).status).toBe(204);
  const out = f.output();
  expect(await run(["reply", commentId, "--status", "fixed", "--body", "Done"], out.io)).toBe(1);
  expect(out.stdout).toEqual([]);
  expect(out.stderr).toEqual([inBin(result.reviewId)]);
});

test("direct publish by id and by key on a binned review prints its line and writes nothing", async () => {
  const { f, server, id } = await binned();
  vi.spyOn(process, "cwd").mockReturnValue(f.source);
  const byKeyOut = f.output();
  expect(await run(["publish", "--manifest", f.manifest, "--key", "synthetic"], byKeyOut.io)).toBe(1);
  expect(byKeyOut.stdout).toEqual([]);
  expect(byKeyOut.stderr).toEqual([byKey]);
  const byIdOut = f.output();
  expect(await run(["publish", "--manifest", f.manifest, "--review", id], byIdOut.io)).toBe(1);
  expect(byIdOut.stdout).toEqual([]);
  expect(byIdOut.stderr).toEqual([byId(id)]);
  expect(await server.db.read((q) => q.select().from(revisions))).toHaveLength(1);
});

test("a hub 409 review_in_bin on take becomes the in-the-bin line", async () => {
  const f = await commandFixture();
  const id = randomUUID();
  f.setResponse(async () =>
    Response.json({ error: { code: "review_in_bin", message: "The review is in the bin." } }, { status: 409 }),
  );
  const error = await takeFeedback(f.dir, hub, id, 0).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(CliError);
  expect((error as CliError).message).toBe(`review ${id} is in the bin`);
});

test("binnedError rewrites only review_in_bin and falls back to the comment when the review is unknown", async () => {
  const f = await directFixture();
  await f.publish();
  const bin = new CliApiError("review_in_bin");
  const commentId = randomUUID();
  await expect(binnedError(f.stateDir, bin, { commentId })).rejects.toThrow(
    `the review of comment ${commentId} is in the bin`,
  );
  await expect(binnedError(f.stateDir, bin, { reviewId: randomUUID() })).rejects.toBeInstanceOf(CliError);
  const other = new CliApiError("review_moved");
  await expect(binnedError(f.stateDir, bin, { publish: true, shortcut: true })).rejects.toThrow(
    byKeyShortcut.slice("emend: ".length).trimEnd(),
  );
  await expect(binnedError(f.stateDir, bin, { publish: true })).rejects.toThrow(
    byKey.slice("emend: ".length).trimEnd(),
  );
  await expect(binnedError(f.stateDir, other, { reviewId: randomUUID() })).rejects.toBe(other);
});
