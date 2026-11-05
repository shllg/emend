import { ThreadCreated } from "@emend/contract";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { sql } from "drizzle-orm";
import { expect, test } from "vitest";
import { directFixture } from "../cli/direct-test-support.ts";
import { pollUntil } from "../test/poll-until.ts";
import { createMcpServer } from "./server.ts";

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
  const pending = await client.callTool({ name: "wait_for_review", arguments: { reviewId, timeoutSeconds: 1 } });
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
