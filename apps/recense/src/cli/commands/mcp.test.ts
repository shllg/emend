import { randomUUID } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { expect, test, vi } from "vitest";
import { run } from "../../main.ts";
import { commandFixture } from "../test-support.ts";

test("mcp rejects options before starting the protocol", async () => {
  const f = await commandFixture();
  expect(await run(["mcp", "extra"], f.io)).toBe(2);
  expect(f.stdout).toEqual([]);
  expect(f.stderr).toHaveLength(1);
  expect(f.fetcher).not.toHaveBeenCalled();
});

test.each(["flush", "EPIPE"])("stdio MCP waits for %s without mixing diagnostics into stdout", async (write) => {
  const f = await commandFixture();
  let transport!: StdioServerTransport;
  vi.spyOn(StdioServerTransport.prototype, "start").mockImplementation(async function (this: StdioServerTransport) {
    transport = this;
  });
  const reviewId = randomUUID();
  const result = { kind: "approve", reviewId, deliveryId: randomUUID(), revision: 1 };
  const started = Promise.withResolvers<void>();
  const flush = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  let confirms = 0;
  f.setResponse(async (url) => {
    if (String(url).endsWith("/confirm")) {
      confirms++;
      completed.resolve();
      return new Response(null, { status: 204 });
    }
    return Response.json(result);
  });
  f.io.stdoutAsync = async (line) => {
    f.stdout.push(line);
    started.resolve();
    await flush.promise;
    if (write === "EPIPE") throw new Error("untrusted");
  };
  f.io.stderr = (line) => {
    f.stderr.push(line);
    completed.resolve();
  };
  expect(await run(["mcp"], f.io)).toBe(0);
  expect(f.fetcher).not.toHaveBeenCalled();
  try {
    transport.onmessage?.({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_feedback", arguments: { reviewId } },
    });
    await started.promise;
    expect(confirms).toBe(0);
    expect(f.stdout).toHaveLength(1);
    expect(JSON.parse(f.stdout[0] ?? "")).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { structuredContent: result },
    });
    flush.resolve();
    await completed.promise;
    expect(confirms).toBe(write === "flush" ? 1 : 0);
    expect(f.stderr).toEqual(write === "flush" ? [] : ["recense: MCP transport failed.\n"]);
  } finally {
    await transport.close();
  }
});
