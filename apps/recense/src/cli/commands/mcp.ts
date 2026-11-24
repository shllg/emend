import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Io } from "../../main.ts";
import { createMcpServer } from "../../mcp/server.ts";
import { apiRequest, CliUsageError } from "../http.ts";
import { readAttachmentPair, resolveTarget } from "../target.ts";

export async function mcpCommand(stateDir: string, args: string[], io: Io) {
  if (args.length) throw new CliUsageError("Usage: recense mcp.");
  const pair = await readAttachmentPair(stateDir);
  if (pair) {
    const target = await resolveTarget(stateDir, pair);
    // Capabilities are public. A read-only probe for the empty blob also checks
    // the machine credential before starting the stdio protocol; absence is fine.
    await apiRequest(stateDir, target, "/blobs/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", {
      method: "HEAD",
      missingOk: true,
    });
  }
  const mcp = createMcpServer(stateDir, io.stderr);
  const transport = new StdioServerTransport();
  // SDK send() can finish on write() returning true, before its callback. Receipt
  // requires the callback, including small responses that do not apply backpressure.
  transport.send = async (message) => {
    await (io.stdoutAsync ?? io.stdout)(`${JSON.stringify(message)}\n`);
  };
  const close = () => {
    void mcp.server.close();
  };
  process.stdin.once("end", close);
  mcp.server.onclose = () => {
    process.stdin.off("end", close);
  };
  await mcp.connect(transport);
}
