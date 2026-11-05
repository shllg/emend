import { ThreadCreated } from "@emend/contract";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { sql } from "drizzle-orm";
import { beforeEach, expect, onTestFinished, test, vi } from "vitest";
import { directFixture } from "../cli/direct-test-support.ts";
import * as pauseModule from "../cli/pause.ts";
import * as executors from "../server/publish/executor.ts";
import { advanceWhilePaused, trackPauses } from "../test/advance-until-settled.ts";
import { workInThread } from "../test/in-thread-worker.ts";
import { pollUntil } from "../test/poll-until.ts";
import { createMcpServer } from "./server.ts";

vi.mock("../cli/pause.ts", async (original) => ({ ...(await original<typeof import("../cli/pause.ts")>()) }));
vi.mock("../server/publish/executor.ts", async (original) => ({
  ...(await original<typeof import("../server/publish/executor.ts")>()),
}));

beforeEach(() => {
  workInThread(executors);
});

test("MCP waits, takes, confirms after transport delivery, and replies without a server", async () => {
  const f = await directFixture();
  const { result: published } = await f.publish();
  const reviewer = await f.reviewer();
  const client = new Client({ name: "synthetic", version: "1.0.0" });
  const [clientTransport, transport] = InMemoryTransport.createLinkedPair();
  const out = f.output();
  const mcp = createMcpServer(f.stateDir, out.io.stderr);
  await mcp.connect(transport);
  await client.connect(clientTransport);
  f.cleanup.push(() => client.close());
  const reviewId = published.reviewId;
  // The one-second wait sleeps in pause(): fake the timers, not Date, and run them only while it sleeps.
  vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const pauses = trackPauses(pauseModule);
  const pending = await advanceWhilePaused(
    client.callTool({ name: "wait_for_review", arguments: { reviewId, timeoutSeconds: 1 } }),
    pauses,
  );
  vi.useRealTimers();
  expect(pending.structuredContent).toEqual({ kind: "pending", reviewId, waitedSeconds: 1 });
  const thread = ThreadCreated.parse(
    await (
      await reviewer.request(`/reviews/${reviewId}/threads`, {
        revision: 1,
        target: { kind: "review" },
        body: "Synthetic question",
      })
    ).json(),
  );
  await reviewer.request(`/reviews/${reviewId}/sends`, { revision: 1, kind: "go" });
  const feedback = await client.callTool({ name: "get_feedback", arguments: { reviewId } });
  expect(feedback.structuredContent).toMatchObject({ kind: "go", comments: [{ id: thread.commentId }] });
  await pollUntil(async () =>
    expect(
      await reviewer.db.read((q) =>
        q.values(sql`select confirmed_at from deliveries where owner_id = ${reviewer.ownerId}`),
      ),
    ).toEqual([[expect.any(Number)]]),
  );
  const reply = await client.callTool({
    name: "reply",
    arguments: { commentId: thread.commentId, outcome: "explained", body: "Synthetic answer" },
  });
  expect(reply.structuredContent).toMatchObject({ threadId: thread.threadId, state: "answered" });
  expect(out.stderr).toEqual([]);
});

test("an MCP tool on a newer database returns the exact diagnostic", async () => {
  const f = await directFixture();
  const { result } = await f.publish();
  const reviewer = await f.reviewer();
  await reviewer.db.query((q) => q.run(sql`insert into __emend_migrations values ('synthetic-future', 'future', 1)`));
  const client = new Client({ name: "synthetic", version: "1.0.0" });
  const [clientTransport, transport] = InMemoryTransport.createLinkedPair();
  const mcp = createMcpServer(f.stateDir, f.output().io.stderr);
  await mcp.connect(transport);
  await client.connect(clientTransport);
  f.cleanup.push(() => client.close());
  expect(await client.callTool({ name: "get_feedback", arguments: { reviewId: result.reviewId } })).toEqual({
    isError: true,
    content: [{ type: "text", text: "The emend database is newer than this emend. Update emend, then try again.\n" }],
  });
});
