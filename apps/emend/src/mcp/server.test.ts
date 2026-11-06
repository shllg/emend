import { randomUUID } from "node:crypto";
import { chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { expect, onTestFinished, test, vi } from "vitest";
import { commandFixture, provenTestServer } from "../cli/test-support.ts";
import { createToken } from "../server/auth/tokens.ts";
import { mailboxFixture } from "../server/mailbox/test-support.ts";
import { writeSecretFile } from "../state/files.ts";
import { createMcpServer } from "./server.ts";

async function connected(withServer = true) {
  const f = await commandFixture();
  if (!withServer) {
    await rm(join(f.dir, "server.json"));
    await rm(join(f.dir, "agent.token"));
  }
  const client = new Client({ name: "synthetic-client", version: "1.0.0" });
  const [clientTransport, transport] = InMemoryTransport.createLinkedPair();
  const mcp = createMcpServer(f.dir, f.io.stderr);
  await mcp.connect(transport);
  await client.connect(clientTransport);
  onTestFinished(() => client.close());
  return { ...f, client, clientTransport, transport, mcp };
}
const reviewId = randomUUID();
const approve = { kind: "approve", reviewId, deliveryId: randomUUID(), revision: 1 };

test.each(["folder", "token"])("MCP returns the precise permission error for a loose %s", async (kind) => {
  const f = await connected();
  const path = kind === "folder" ? f.dir : join(f.dir, "agent.token");
  await chmod(path, kind === "folder" ? 0o755 : 0o644);
  const result = await f.client.callTool({ name: "get_feedback", arguments: { reviewId } });
  expect(result.isError).toBe(true);
  expect(result.content).toEqual([
    {
      type: "text",
      text: `${kind === "folder" ? "State directory" : "Token file"} ${path} has group or other permissions; fix it with chmod ${kind === "folder" ? "700" : "600"} '${path}'\n`,
    },
  ]);
  expect(f.fetcher.mock.calls.every(([, init]) => !new Headers(init?.headers).has("Authorization"))).toBe(true);
});

test("MCP lists three schema-bearing tools without resolving a target, then discovers a later server", async () => {
  const f = await connected(false);
  expect(f.fetcher).not.toHaveBeenCalled();
  const { tools } = await f.client.listTools();
  expect(tools.map((tool) => tool.name)).toEqual(["wait_for_review", "get_feedback", "reply"]);
  for (const tool of tools) {
    expect(tool.inputSchema.type).toBe("object");
    expect(tool.outputSchema?.type).toBe("object");
  }
  expect(tools[0]?.inputSchema.properties?.timeoutSeconds).toMatchObject({ default: 50, minimum: 1, maximum: 540 });
  expect(tools[0]?.description).toMatch(/below.*client.*timeout/i);
  expect(tools[0]?.description).toMatch(/again.*pending/i);
  expect(tools[0]?.description).toMatch(/closed.*retired or snoozed.*stop/i);
  expect(tools[1]?.description).toMatch(/closed.*retired or snoozed/i);
  expect(f.fetcher).not.toHaveBeenCalled();
  provenTestServer(f.dir);
  writeSecretFile(join(f.dir, "agent.token"), `em_${"a".repeat(43)}`);
  f.setResponse(async () => Response.json({ kind: "pending", reviewId, waitedSeconds: 0 }));
  const result = await f.client.callTool({ name: "get_feedback", arguments: { reviewId } });
  expect(result.structuredContent).toEqual({ kind: "pending", reviewId, waitedSeconds: 0 });
  expect(result.content).toEqual([{ type: "text", text: JSON.stringify(result.structuredContent) }]);
  expect(f.fetcher).toHaveBeenCalled();
});

test("the default MCP wait returns pending after 50 seconds without a Send", async () => {
  const f = await connected();
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const rounds: number[] = [];
  f.setResponse(async (_url, init) => {
    const { waitSeconds } = JSON.parse(String(init?.body));
    rounds.push(waitSeconds);
    now += waitSeconds * 1000;
    return Response.json({ kind: "pending", reviewId, waitedSeconds: waitSeconds });
  });
  const result = await f.client.callTool({ name: "wait_for_review", arguments: { reviewId } });
  expect(result.structuredContent).toEqual({ kind: "pending", reviewId, waitedSeconds: 50 });
  expect(rounds).toEqual([25, 25]);
});

test.each([0, "synthetic-request", ""])(
  "cancelling JSON-RPC request id %j aborts its take and sends no result",
  async (id) => {
    const f = await connected();
    const started = Promise.withResolvers<AbortSignal>();
    const stopped = Promise.withResolvers<void>();
    f.setResponse(async (url, init) => {
      expect(String(url)).toMatch(/\/take$/);
      const signal = init?.signal as AbortSignal;
      started.resolve(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            stopped.resolve();
            reject(signal.reason);
          },
          { once: true },
        );
      });
    });
    const sent = vi.spyOn(f.transport, "send");
    await f.clientTransport.send({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "wait_for_review", arguments: { reviewId } },
    });
    const signal = await started.promise;
    await f.clientTransport.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } });
    // Let the notification handler and fetch rejection settle without waiting for the take timeout.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(signal.aborted).toBe(true);
    await stopped.promise;
    expect(sent).not.toHaveBeenCalled();
    expect(f.fetcher.mock.calls.some(([url]) => String(url).endsWith("/confirm"))).toBe(false);
  },
);

test.each([0, 541, 1.5, "25"])("MCP rejects invalid timeout %s without a target lookup", async (timeoutSeconds) => {
  const f = await connected();
  const result = await f.client.callTool({ name: "wait_for_review", arguments: { reviewId, timeoutSeconds } });
  expect(result.isError).toBe(true);
  expect(f.fetcher).not.toHaveBeenCalled();
});

test.each([5, 0, ""])(
  "same-chunk cancellation refuses an in-flight reused id %j and stdin close aborts all waits",
  async (id) => {
    const f = await commandFixture();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const transport = new StdioServerTransport(stdin, stdout);
    const mcp = createMcpServer(f.dir, f.io.stderr);
    const closed = Promise.withResolvers<void>();
    // Match the command's EOF wiring while using the SDK's real stdin chunk parser.
    stdin.once("end", () => void mcp.server.close());
    mcp.server.onclose = () => closed.resolve();
    const first = Promise.withResolvers<AbortSignal>();
    const reused = Promise.withResolvers<AbortSignal>();
    const running = new Set<AbortSignal>();
    const finish = new Set<() => void>();
    let takes = 0;
    f.setResponse(async (url, init) => {
      expect(String(url)).toMatch(/\/take$/);
      const signal = init?.signal as AbortSignal;
      takes++;
      running.add(signal);
      (takes === 1 ? first : reused).resolve(signal);
      try {
        return await new Promise<Response>((_resolve, reject) => {
          const stop = () => reject(signal.reason ?? new Error("Test cleanup"));
          finish.add(stop);
          signal.addEventListener("abort", stop, { once: true });
        });
      } finally {
        running.delete(signal);
      }
    });
    onTestFinished(async () => {
      await mcp.server.close();
      for (const stop of finish) stop();
      stdin.destroy();
      stdout.destroy();
    });
    const sent = vi.spyOn(transport, "send");
    await mcp.connect(transport);
    const call = serializeMessage({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "wait_for_review", arguments: { reviewId } },
    });
    stdin.write(call);
    const original = await first.promise;
    const cancel = serializeMessage({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } });
    stdin.write(cancel + call);
    // Both lines run synchronously, before any SDK notification microtask can run.
    expect(original.aborted).toBe(true);
    expect(sent.mock.calls.map(([message]) => message)).toEqual([
      { jsonrpc: "2.0", id, error: { code: ErrorCode.InvalidRequest, message: expect.stringMatching(/in flight/i) } },
    ]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(takes).toBe(1);
    expect(running.size).toBe(0);
    expect(sent).toHaveBeenCalledTimes(1);

    // Once the cancelled request ends, the same id is available again.
    stdin.write(call);
    const next = await reused.promise;
    expect(next.aborted).toBe(false);
    expect(takes).toBe(2);
    stdin.end();
    await closed.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(next.aborted).toBe(true);
    expect(running.size).toBe(0);
    expect(sent).toHaveBeenCalledTimes(1);
    expect(f.fetcher.mock.calls.some(([url]) => String(url).endsWith("/confirm"))).toBe(false);
  },
);

test("a duplicate tool id is refused without disturbing the original delivery", async () => {
  const f = await connected();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const confirmed = Promise.withResolvers<void>();
  let takes = 0;
  let confirms = 0;
  f.setResponse(async (url) => {
    if (String(url).endsWith("/confirm")) {
      confirms++;
      confirmed.resolve();
      return new Response(null, { status: 204 });
    }
    takes++;
    started.resolve();
    await release.promise;
    return Response.json(approve);
  });
  onTestFinished(() => release.resolve());
  const sent = vi.spyOn(f.transport, "send");
  const call = {
    jsonrpc: "2.0" as const,
    id: 5,
    method: "tools/call",
    params: { name: "get_feedback", arguments: { reviewId } },
  };
  await f.clientTransport.send(call);
  await started.promise;
  await f.clientTransport.send(call);
  expect(sent.mock.calls.map(([message]) => message)).toEqual([
    { jsonrpc: "2.0", id: 5, error: { code: ErrorCode.InvalidRequest, message: expect.stringMatching(/in flight/i) } },
  ]);
  expect(takes).toBe(1);
  expect(confirms).toBe(0);
  release.resolve();
  await confirmed.promise;
  expect(takes).toBe(1);
  expect(confirms).toBe(1);
  expect(sent).toHaveBeenCalledTimes(2);
  expect(sent.mock.calls[1]?.[0]).toMatchObject({ id: 5, result: { structuredContent: approve } });
});

test.each(["tools/list", "ping"])(
  "%s reserves its id before a same-chunk wait, and stdin close aborts every later wait",
  async (method) => {
    const f = await commandFixture();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const transport = new StdioServerTransport(stdin, stdout);
    const mcp = createMcpServer(f.dir, f.io.stderr);
    const closed = Promise.withResolvers<void>();
    stdin.once("end", () => void mcp.server.close());
    mcp.server.onclose = () => closed.resolve();
    const started = Promise.withResolvers<void>();
    const signals: AbortSignal[] = [];
    const running = new Set<AbortSignal>();
    const finish = new Set<() => void>();
    f.setResponse(async (url, init) => {
      expect(String(url)).toMatch(/\/take$/);
      const signal = init?.signal as AbortSignal;
      signals.push(signal);
      running.add(signal);
      if (signals.length === 2) started.resolve();
      try {
        return await new Promise<Response>((_resolve, reject) => {
          const stop = () => reject(signal.reason ?? new Error("Test cleanup"));
          finish.add(stop);
          signal.addEventListener("abort", stop, { once: true });
        });
      } finally {
        running.delete(signal);
      }
    });
    onTestFinished(async () => {
      await mcp.server.close();
      for (const stop of finish) stop();
      stdin.destroy();
      stdout.destroy();
    });
    const sent = vi.spyOn(transport, "send");
    await mcp.connect(transport);
    const call = (id: number) =>
      serializeMessage({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "wait_for_review", arguments: { reviewId } },
      });
    stdin.write(serializeMessage({ jsonrpc: "2.0", id: 5, method }) + call(5));
    // Refuse the duplicate before the first request's handler or response can run.
    expect(sent.mock.calls.map(([message]) => message)).toEqual([
      {
        jsonrpc: "2.0",
        id: 5,
        error: { code: ErrorCode.InvalidRequest, message: expect.stringMatching(/in flight/i) },
      },
    ]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(sent).toHaveBeenCalledTimes(2);
    expect(sent.mock.calls[1]?.[0]).toEqual({
      jsonrpc: "2.0",
      id: 5,
      result: method === "tools/list" ? { tools: expect.any(Array) } : {},
    });
    stdin.write(serializeMessage({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 5 } }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(signals).toHaveLength(0);

    // A completed non-tool response releases only its own id. Both new waits must
    // remain reachable for the command's EOF-close behavior to abort them.
    stdin.write(call(5) + call(6));
    await started.promise;
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    expect(running.size).toBe(2);
    stdin.end();
    await closed.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(running.size).toBe(0);
    expect(sent).toHaveBeenCalledTimes(2);
    expect(f.fetcher.mock.calls.some(([url]) => String(url).endsWith("/confirm"))).toBe(false);
  },
);

test("MCP resolves the target on each call and keeps the printed response after a late confirm", async () => {
  const f = await connected();
  const diagnostic = Promise.withResolvers<void>();
  // The stderr function passed to the server writes into this array.
  const push = vi.spyOn(f.stderr, "push").mockImplementation((...lines) => {
    Array.prototype.push.apply(f.stderr, lines);
    diagnostic.resolve();
    return f.stderr.length;
  });
  f.setResponse(async (url) =>
    String(url).endsWith("/confirm")
      ? Response.json({ error: { code: "not_found", message: "untrusted" } }, { status: 404 })
      : Response.json(approve),
  );
  const result = await f.client.callTool({ name: "get_feedback", arguments: { reviewId } });
  await diagnostic.promise;
  expect(result.structuredContent).toEqual(approve);
  expect(f.stderr).toEqual(["emend: Could not confirm receipt; the same feedback will be offered again.\n"]);
  push.mockRestore();
  writeSecretFile(join(f.dir, "attach.json"), "{");
  f.fetcher.mockClear();
  expect((await f.client.callTool({ name: "get_feedback", arguments: { reviewId } })).isError).toBe(true);
  expect(f.fetcher).not.toHaveBeenCalled();
});

test.each(["wait_for_review", "get_feedback"])(
  "%s confirms only after the transport finishes the response",
  async (name) => {
    const f = await connected();
    let confirms = 0;
    const confirmed = Promise.withResolvers<void>();
    f.setResponse(async (url) => {
      if (String(url).endsWith("/take")) return Response.json(approve);
      confirms++;
      confirmed.resolve();
      return new Response(null, { status: 204 });
    });
    const send = f.transport.send.bind(f.transport);
    const release = Promise.withResolvers<void>();
    f.transport.send = async (message, options) => {
      await send(message, options);
      if ("result" in message && "structuredContent" in message.result) await release.promise;
    };
    const result = await f.client.callTool({ name, arguments: { reviewId } });
    expect(result.structuredContent).toEqual(approve);
    expect(confirms).toBe(0);
    release.resolve();
    await confirmed.promise;
    expect(confirms).toBe(1);
  },
);

test.each(["cancel", "close"])("MCP %s aborts an in-flight take without confirming", async (kind) => {
  const f = await connected();
  const started = Promise.withResolvers<AbortSignal>();
  const aborted = Promise.withResolvers<void>();
  f.setResponse(async (url, init) => {
    expect(String(url)).toMatch(/\/take$/);
    const signal = init?.signal as AbortSignal;
    started.resolve(signal);
    return new Promise((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          aborted.resolve();
          reject(signal.reason);
        },
        { once: true },
      );
    });
  });
  const controller = new AbortController();
  const result = f.client.callTool({ name: "wait_for_review", arguments: { reviewId } }, undefined, {
    signal: controller.signal,
  });
  const failed = expect(result).rejects.toThrow();
  const signal = await started.promise;
  if (kind === "cancel") controller.abort();
  else await f.client.close();
  await failed;
  await aborted.promise;
  expect(signal.aborted).toBe(true);
  expect(f.fetcher.mock.calls.some(([url]) => String(url).endsWith("/confirm"))).toBe(false);
});

test("an unsent response never confirms", async () => {
  const f = await connected();
  let confirms = 0;
  f.setResponse(async (url) => {
    if (String(url).endsWith("/confirm")) confirms++;
    return Response.json(approve);
  });
  const failedSend = Promise.withResolvers<void>();
  f.transport.send = async () => {
    failedSend.resolve();
    throw new Error("closed");
  };
  const result = f.client.callTool({ name: "get_feedback", arguments: { reviewId } });
  const failed = expect(result).rejects.toThrow();
  await failedSend.promise;
  await f.client.close();
  await failed;
  expect(confirms).toBe(0);
});

test("MCP emits progress each 25-second round and returns a valid pending output", async () => {
  const f = await connected();
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  f.setResponse(async (_url, init) => {
    const { waitSeconds } = JSON.parse(String(init?.body));
    now += waitSeconds * 1000;
    return Response.json({ kind: "pending", reviewId, waitedSeconds: waitSeconds });
  });
  const progress: number[] = [];
  const result = await f.client.callTool(
    { name: "wait_for_review", arguments: { reviewId, timeoutSeconds: 51 } },
    undefined,
    {
      onprogress: (value) => {
        progress.push(value.progress);
      },
      resetTimeoutOnProgress: true,
    },
  );
  expect(progress).toEqual([25, 50]);
  expect(result.structuredContent).toEqual({ kind: "pending", reviewId, waitedSeconds: 51 });
});

test.each(["unauthorized", "not_found", "network"])(
  "MCP %s is a safe tool error, not a protocol error",
  async (code) => {
    const f = await connected();
    f.setResponse(async () => {
      if (code === "network") throw new Error("untrusted\nsecret");
      return Response.json({ error: { code, message: "untrusted\nsecret" } }, { status: 401 });
    });
    const result = await f.client.callTool({ name: "get_feedback", arguments: { reviewId } });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: expect.stringMatching(/^emend: [^\n]+\n$/) }]);
    expect(JSON.stringify(result)).not.toMatch(/untrusted|secret/);
  },
);

test("MCP reply creates an agent comment and returns the same JSON as the CLI", async () => {
  const f = await connected();
  const mailbox = await mailboxFixture();
  onTestFinished(() => mailbox.cleanup());
  const token = await createToken(mailbox.db, mailbox.ownerId, "agent", { instanceId: mailbox.instanceId });
  writeSecretFile(join(f.dir, "agent.token"), token.secret);
  f.setResponse(async (url, init) =>
    mailbox.app.request(String(url), { ...init, headers: { ...init?.headers, Host: "127.0.0.1:3636" } }),
  );
  const thread = await mailbox.thread();
  await mailbox.send();
  const feedback = await f.client.callTool({ name: "get_feedback", arguments: { reviewId: mailbox.reviewId } });
  expect(feedback.structuredContent).toMatchObject({ kind: "go", comments: [{ id: thread.commentId }] });
  expect(feedback.content).toEqual([{ type: "text", text: JSON.stringify(feedback.structuredContent) }]);
  const result = await f.client.callTool({
    name: "reply",
    arguments: { commentId: thread.commentId, outcome: "explained", body: "Synthetic answer" },
  });
  expect(result.structuredContent).toMatchObject({ threadId: thread.threadId, state: "answered" });
  expect(result.content).toEqual([{ type: "text", text: JSON.stringify(result.structuredContent) }]);
  await mailbox.comment(thread.threadId, "Follow-up");
  await mailbox.send();
  const delivery = await mailbox.take();
  expect(delivery.kind).toBe("go");
  if (delivery.kind === "go")
    expect(delivery.comments.at(-1)?.history).toContainEqual({
      author: "agent",
      body: "Synthetic answer",
      outcome: "explained",
    });
});
