import { once } from "node:events";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { Duplex } from "node:stream";
import { expect, test } from "vitest";
import { APP_CSP } from "./http/headers.ts";
import { nodeRequestHandler } from "./serve.ts";

async function rawExchange(host: string, path: string, fail = false) {
  const chunks: Buffer[] = [];
  const sink = new Duplex({
    read() {},
    write(chunk, _encoding, done) {
      chunks.push(Buffer.from(chunk));
      done();
    },
  });
  const incoming = new IncomingMessage(new Socket());
  incoming.method = "GET";
  incoming.url = path;
  incoming.headers = { host };
  incoming.rawHeaders = ["Host", host];
  incoming.httpVersion = "1.1";
  incoming.httpVersionMajor = 1;
  incoming.httpVersionMinor = 1;
  const outgoing = new ServerResponse(incoming);
  outgoing.assignSocket(sink as Socket);
  const finished = once(outgoing, "finish");
  const handler = nodeRequestHandler(
    {
      fetch(request) {
        void request.url;
        if (fail) throw new Error("synthetic adapter failure");
        return new Response("Synthetic success");
      },
    },
    { allowedHosts: ["127.0.0.1:3636"] },
  );
  try {
    await handler(incoming, outgoing);
    await finished;
    const raw = Buffer.concat(chunks).toString("utf8");
    return { status: outgoing.statusCode, raw };
  } finally {
    incoming.destroy();
    sink.destroy();
  }
}

test.each(["[broken", "evil.example", "127.0.0.1:3637"])(
  "raw Host %s is refused before adapter parsing with the complete error contract",
  async (host) => {
    const response = await rawExchange(host, "/api/v1/capabilities");
    expect(response.status).toBe(403);
    expect(response.raw).toContain('"code":"bad_host"');
    for (const text of [APP_CSP, "x-frame-options: DENY", "x-content-type-options: nosniff", "cache-control: no-store"])
      expect(response.raw).toContain(text);
  },
);

test.each([
  ["http://[broken", false],
  ["/api/v1/capabilities", true],
] as const)("adapter failures at %s have fixed JSON and app headers", async (path, fail) => {
  const response = await rawExchange("127.0.0.1:3636", path, fail);
  expect(response.status).toBe(400);
  expect(response.raw).toContain('"code":"invalid_request"');
  expect(response.raw).toContain(APP_CSP);
  expect(response.raw).not.toContain("synthetic adapter failure");
});

test("raw content-path errors carry content isolation headers with self ancestors", async () => {
  for (const [host, fail] of [
    ["invalid.example", false],
    ["127.0.0.1:3636", true],
  ] as const) {
    const response = await rawExchange(host, "/content/invalid/doc.html", fail);
    for (const header of [
      "sandbox allow-scripts;",
      "script-src 'none';",
      "frame-ancestors 'self'",
      "cross-origin-resource-policy: same-origin",
      "referrer-policy: no-referrer",
      "x-content-type-options: nosniff",
      "cache-control: no-store",
    ])
      expect(response.raw).toContain(header);
    expect(response.raw).not.toContain("x-frame-options");
    expect(response.raw).not.toContain("access-control-allow-origin");
  }
});
