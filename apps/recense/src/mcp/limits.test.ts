import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ReadBuffer, STDIO_DEFAULT_MAX_BUFFER_SIZE, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import { eq } from "drizzle-orm";
import { expect, onTestFinished, test } from "vitest";
import { commandFixture } from "../cli/test-support.ts";
import { comments, deliveries, sends } from "../db/schema.ts";
import { run } from "../main.ts";
import { createToken } from "../server/auth/tokens.ts";
import { mailboxFixture } from "../server/mailbox/test-support.ts";
import { writeSecretFile } from "../state/files.ts";
import { createMcpServer } from "./server.ts";

const maxBytes = 3145728;
async function fixture() {
  const f = await commandFixture();
  const mailbox = await mailboxFixture();
  onTestFinished(() => mailbox.cleanup());
  const token = await createToken(mailbox.db, mailbox.ownerId, "agent", { instanceId: mailbox.instanceId });
  writeSecretFile(join(f.dir, "agent.token"), token.secret);
  f.setResponse(async (url, init) =>
    mailbox.app.request(String(url), { ...init, headers: { ...init?.headers, Host: "127.0.0.1:3636" } }),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const frames: Buffer[] = [];
  const reader = new ReadBuffer();
  const send = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (message, options) => {
    const bytes = Buffer.from(serializeMessage(message));
    frames.push(bytes);
    try {
      reader.append(bytes);
      const decoded = reader.readMessage();
      if (!decoded) throw new Error("Incomplete stdio frame");
      await send(decoded, options);
    } catch (error) {
      await serverTransport.close();
      throw error;
    }
  };
  const mcp = createMcpServer(f.dir, f.io.stderr);
  const client = new Client({ name: "synthetic-framed-client", version: "1.0.0" });
  await mcp.connect(serverTransport);
  await client.connect(clientTransport);
  onTestFinished(() => client.close());
  async function seed(threadId: string, count: number, author: "user" | "agent") {
    await mailbox.db.transaction(async (q) => {
      for (let i = 0; i < count; i++)
        await q.insert(comments).values({
          ownerId: mailbox.ownerId,
          reviewId: mailbox.reviewId,
          threadId,
          author,
          body: '"'.repeat(20000),
          ...(author === "agent" ? { outcome: "held" as const } : {}),
          createdAt: mailbox.deps.now(),
        });
    });
  }
  return { ...f, mailbox, client, frames, seed };
}

test("a quote-heavy handoff near 3 MiB fits the SDK's real stdio framing and output validation", async () => {
  const f = await fixture();
  const thread = await f.mailbox.thread("Previous comment");
  await f.mailbox.send();
  const first = await f.mailbox.take();
  if (first.kind !== "go") throw new Error("not go");
  await f.mailbox.request(`/deliveries/${first.deliveryId}/confirm`, "POST", undefined, "agent");
  await f.seed(thread.threadId, 100, "agent");
  await f.mailbox.comment(thread.threadId, "Follow-up");
  await f.mailbox.send();
  const result = await f.client.callTool({ name: "get_feedback", arguments: { reviewId: f.mailbox.reviewId } });
  expect(result.isError).not.toBe(true);
  const bytes = Buffer.byteLength(JSON.stringify(result.structuredContent));
  expect(bytes).toBeLessThanOrEqual(maxBytes);
  expect(bytes).toBeGreaterThan(maxBytes - 41000);
  expect(result.structuredContent).toMatchObject({ kind: "go", comments: [{ historyTrimmed: true }] });
  expect(result.content).toEqual([{ type: "text", text: JSON.stringify(result.structuredContent) }]);
  const line = f.frames.at(-1);
  expect(line?.byteLength).toBeGreaterThan(9 * 1024 * 1024 - 100000);
  expect(line?.byteLength).toBeLessThan(STDIO_DEFAULT_MAX_BUFFER_SIZE);
  expect(
    f.fetcher.mock.calls
      .filter(([url]) => String(url).endsWith("/take"))
      .map(([, init]) => JSON.parse(String(init?.body)).maxBytes),
  ).toEqual([maxBytes]);
});

test("a Send larger than the MCP budget stays queued for CLI feedback", async () => {
  const f = await fixture();
  const thread = await f.mailbox.thread('"'.repeat(20000));
  await f.seed(thread.threadId, 79, "user");
  await f.mailbox.send();
  const result = await f.client.callTool({ name: "get_feedback", arguments: { reviewId: f.mailbox.reviewId } });
  expect(result.isError).toBe(true);
  expect(result.content).toEqual([
    {
      type: "text",
      text: `This feedback is too large for MCP. Run \`recense feedback ${f.mailbox.reviewId}\` in a shell to get it.`,
    },
  ]);
  expect(
    await f.mailbox.db.read((q) =>
      q.select({ deliveryId: sends.deliveryId }).from(sends).where(eq(sends.ownerId, f.mailbox.ownerId)),
    ),
  ).toEqual([{ deliveryId: null }]);
  expect(
    await f.mailbox.db.read((q) => q.select().from(deliveries).where(eq(deliveries.ownerId, f.mailbox.ownerId))),
  ).toEqual([]);
  expect(await run(["feedback", f.mailbox.reviewId], f.io)).toBe(0);
  expect(JSON.parse(f.stdout[0] ?? "").comments).toHaveLength(80);
  const takes = f.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/take"));
  expect(JSON.parse(String(takes.at(-1)?.[1]?.body))).toEqual({ waitSeconds: 0, accepts: ["closed"] });
});
