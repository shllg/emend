import { randomUUID } from "node:crypto";
import { rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { LIMITS } from "@emend/contract";
import { afterEach, expect, test, vi } from "vitest";
import { NewerDatabaseError } from "../db/migrate.ts";
import { testDb } from "../db/test-support.ts";
import { run } from "../main.ts";
import { StateDirModeError, writeSecretFile } from "../state/files.ts";
import { apiRequest, CliHttpError, CliUnansweredError, errorLine } from "./http.ts";
import { localTarget } from "./target.ts";
import { commandFixture, provenTestServer } from "./test-support.ts";

afterEach(() => vi.unstubAllGlobals());

const oversizedReplyBytes = 64 * 1024 * 1024 + 1;

function paddedReply(size: number, value: unknown, init?: ResponseInit) {
  const json = Buffer.from(JSON.stringify(value));
  const padding = Buffer.alloc(1024 * 1024, " ");
  let sent = 0;
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (sent === size) return controller.close();
    const chunk = sent === 0 ? json : padding.subarray(0, Math.min(padding.length, size - sent));
    sent += chunk.length;
    controller.enqueue(chunk);
  });
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), init);
  return { response, pull, cancel, bytesRead: () => sent };
}

test.each([200, 400, 500])(
  "ls refuses a streamed oversized HTTP %i reply on one line and cancels it",
  async (status) => {
    const f = await commandFixture();
    const reply = paddedReply(oversizedReplyBytes, { items: [] }, { status });
    f.setResponse(async () => reply.response);
    expect(await run(["ls", "--json"], f.io)).toBe(1);
    expect(f.stdout).toEqual([]);
    expect(f.stderr).toEqual(["emend: the emend server's answer was larger than 64 MiB.\n"]);
    expect(reply.cancel).toHaveBeenCalledOnce();
    expect(reply.response.body?.locked).toBe(false);
  },
);

test("a declared oversized reply is cancelled without reading its body", async () => {
  const f = await commandFixture();
  const value = { items: [] };
  const reply = paddedReply(Buffer.byteLength(JSON.stringify(value)), value, {
    headers: { "Content-Length": String(oversizedReplyBytes) },
  });
  f.setResponse(async () => reply.response);
  expect(await run(["ls", "--json"], f.io)).toBe(1);
  expect(f.stdout).toEqual([]);
  expect(f.stderr).toEqual(["emend: the emend server's answer was larger than 64 MiB.\n"]);
  expect(reply.pull).not.toHaveBeenCalled();
  expect(reply.cancel).toHaveBeenCalledOnce();
});

test.each(["local", "hub"] as const)("an oversized %s publish answer preserves possible publication", async (via) => {
  const f = await commandFixture();
  const manifest = join(f.dir, "manifest.json");
  writeSecretFile(
    manifest,
    JSON.stringify({
      version: 1,
      title: "Synthetic",
      topics: [],
      files: [],
      writeup: { overview: "", tldr: "", decisions: null, topics: {} },
    }),
  );
  writeSecretFile(join(f.dir, "instance.json"), JSON.stringify({ id: randomUUID() }));
  if (via === "hub") {
    writeSecretFile(
      join(f.dir, "attach.json"),
      JSON.stringify({
        hubUrl: "https://hub.example",
        hubId: randomUUID(),
        hubName: "Synthetic hub",
      }),
    );
    writeSecretFile(join(f.dir, "hub.token"), `em_${"b".repeat(43)}`);
  }
  const reply = paddedReply(oversizedReplyBytes, { revision: 1 });
  f.setResponse(async () => reply.response);
  expect(await run(["publish", "--manifest", manifest, "--key", "synthetic"], f.io)).toBe(1);
  expect(f.stdout).toEqual([]);
  expect(f.stderr).toEqual(["emend: the server's answer was cut off; the revision may have been published\n"]);
  expect(reply.cancel).toHaveBeenCalledOnce();
});

test.each([200, 400, 500])("an oversized hub write reply with HTTP %i may have reached the hub", async (status) => {
  const f = await commandFixture();
  const target = { via: "hub" as const, url: "https://hub.example", token: `em_${"b".repeat(43)}` };
  const reply = paddedReply(2, {}, { status, headers: { "Content-Length": String(oversizedReplyBytes) } });
  f.setResponse(async () => reply.response);
  const error = await apiRequest(f.dir, target, "/import", { method: "POST", body: {} }).catch(
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(CliUnansweredError);
  expect(errorLine(error)).toBe(
    "emend: the hub at https://hub.example did not answer. The request may have reached it; check before trying again.\n",
  );
  expect(reply.pull).not.toHaveBeenCalled();
  expect(reply.cancel).toHaveBeenCalledOnce();
});

test.each([LIMITS.handoffBytes, oversizedReplyBytes - 1])(
  "feedback accepts a hand-off JSON reply of exactly %i bytes",
  async (size) => {
    const f = await commandFixture();
    const result = { kind: "approve", reviewId: randomUUID(), deliveryId: randomUUID(), revision: 1 };
    const reply = paddedReply(size, result);
    f.setResponse(async (url) =>
      String(url).endsWith("/take") ? reply.response : new Response(null, { status: 204 }),
    );
    expect(await run(["feedback", result.reviewId], f.io)).toBe(0);
    expect(f.stdout).toEqual([`${JSON.stringify(result)}\n`]);
    expect(f.stderr).toEqual([]);
    expect(reply.bytesRead()).toBe(size);
    expect(reply.cancel).not.toHaveBeenCalled();
    expect(reply.response.body?.locked).toBe(false);
    expect(f.fetcher.mock.calls.some(([url]) => String(url).endsWith(`/deliveries/${result.deliveryId}/confirm`))).toBe(
      true,
    );
  },
);

test("an upload larger than the reply cap still reaches fetch and accepts a 204", async () => {
  const f = await commandFixture();
  const raw = Buffer.alloc(oversizedReplyBytes);
  f.setResponse(async (_url, init) => {
    expect(init?.method).toBe("PUT");
    expect(new Headers(init?.headers).get("Content-Length")).toBe(String(raw.length));
    expect(init?.body).toBeInstanceOf(Uint8Array);
    expect(init?.body).toHaveProperty("byteLength", raw.length);
    return new Response(null, { status: 204 });
  });
  const target = await localTarget(f.dir, "http://127.0.0.1:3636");
  expect(await apiRequest(f.dir, target, `/blobs/${"a".repeat(64)}`, { method: "PUT", raw })).toBeNull();
});

test.each([200, 400, 500])("malformed HTTP %i JSON keeps its existing error for hub writes", async (status) => {
  const f = await commandFixture();
  f.setResponse(async () => new Response("{", { status }));
  const target = { via: "hub" as const, url: "https://hub.example", token: `em_${"b".repeat(43)}` };
  const error = await apiRequest(f.dir, target, "/import", { method: "POST", body: {} }).catch(
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(CliHttpError);
  expect(error).not.toBeInstanceOf(CliUnansweredError);
  expect(errorLine(error)).toBe("emend: The emend server returned an invalid response.\n");
});

test("caller cancellation while reading a reply preserves the caller's error", async () => {
  const f = await commandFixture();
  const controller = new AbortController();
  const reason = new Error("Synthetic caller cancellation");
  f.setResponse(
    async () =>
      new Response(
        new ReadableStream(
          {
            pull(stream) {
              controller.abort(reason);
              stream.error(reason);
            },
          },
          { highWaterMark: 0 },
        ),
      ),
  );
  const target = await localTarget(f.dir, "http://127.0.0.1:3636");
  await expect(
    apiRequest(f.dir, target, "/publish", { method: "POST", body: {}, signal: controller.signal }),
  ).rejects.toBe(reason);
});

test.each([
  "config",
  "publish",
  "wait",
  "feedback",
  "reply",
  "mcp",
  "service",
  "skills",
  "pair",
  "devices",
  "attach",
  "detach",
  "serve",
  "open",
])("%s mode errors escape the folder everywhere on one line", (command) => {
  const error = new StateDirModeError("/synthetic/state\n\u001b[31m\u202e");
  expect(errorLine(error, command)).toBe(
    "State directory /synthetic/state\\u{a}\\u{1b}[31m\\u{202e} has group or other permissions; fix it with chmod 700 $'/synthetic/state\\x0a\\x1b[31m\\xe2\\x80\\xae'\n",
  );
});

test("mode errors keep a pasteable chmod hint for ordinary paths with spaces and quotes", () => {
  const dir = "/synthetic/reviewer's state";
  expect(errorLine(new StateDirModeError(dir), "config")).toBe(
    "State directory /synthetic/reviewer's state has group or other permissions; fix it with chmod 700 '/synthetic/reviewer'\\''s state'\n",
  );
});

test("newer-database errors contain no path and keep their fixed diagnostic", () => {
  expect(errorLine(new NewerDatabaseError(), "config")).toBe(
    "The emend database is newer than this emend. Update emend, then try again.\n",
  );
});

test("a publish timeout reports that nothing was published", async () => {
  const fixture = await testDb();
  try {
    writeSecretFile(join(fixture.dir, "agent.token"), `em_${"a".repeat(43)}`);
    const proof = provenTestServer(fixture.dir);
    vi.stubGlobal(
      "fetch",
      (url: string | URL, init?: RequestInit) =>
        proof(url, init) ??
        new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
    );
    await expect(
      apiRequest(fixture.dir, await localTarget(fixture.dir, "http://127.0.0.1:3636", "agent"), "/publish", {
        method: "POST",
        body: {},
        timeoutMs: 10,
      }),
    ).rejects.toThrow("the server did not answer in time; nothing was published");
  } finally {
    await fixture.cleanup();
  }
});
test("HTTP sends state token, version and JSON, refuses redirects and renders fixed API errors", async () => {
  const fixture = await testDb();
  try {
    const secret = `em_${"a".repeat(43)}`;
    writeSecretFile(join(fixture.dir, "admin.token"), secret);
    const proof = provenTestServer(fixture.dir);
    let calls = 0;
    const fetcher = vi.fn(
      async (url: string | URL, init?: RequestInit) =>
        proof(url, init) ??
        (++calls === 1
          ? Response.json({ ok: true })
          : Response.json({ error: { code: "unauthorized", message: `untrusted\n${secret}` } }, { status: 401 })),
    );
    vi.stubGlobal("fetch", fetcher);
    expect(
      await apiRequest(fixture.dir, await localTarget(fixture.dir, "http://127.0.0.1:3636", "admin"), "/pairings", {
        method: "POST",
        body: { purpose: "device" },
      }),
    ).toEqual({ ok: true });
    expect(String(fetcher.mock.calls[1]?.[0])).toBe("http://127.0.0.1:3636/api/v1/pairings");
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
      redirect: "error",
      headers: { Authorization: `Bearer ${secret}`, "X-Emend-Client": "cli/0.1.0", "Content-Type": "application/json" },
      body: '{"purpose":"device"}',
    });
    await expect(
      apiRequest(fixture.dir, await localTarget(fixture.dir, "http://127.0.0.1:3636", "admin"), "/pairings", {
        method: "POST",
        body: {},
      }),
    ).rejects.toThrow("Authentication is required.");
  } finally {
    await fixture.cleanup();
  }
});

test("CLI tokens trim trailing CR/LF and reject symlinks before any Authorization is sent", async () => {
  const fixture = await testDb();
  try {
    const proof = provenTestServer(fixture.dir);
    const secret = `em_${"a".repeat(43)}`;
    const path = join(fixture.dir, "admin.token");
    writeSecretFile(path, `${secret}\r\n`);
    const fetcher = vi.fn(
      async (url: string | URL, init?: RequestInit) => proof(url, init) ?? Response.json({ ok: true }),
    );
    vi.stubGlobal("fetch", fetcher);
    expect(
      await apiRequest(fixture.dir, await localTarget(fixture.dir, "http://127.0.0.1:3636", "admin"), "/pairings", {
        method: "POST",
        body: {},
      }),
    ).toEqual({ ok: true });
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get("Authorization")).toBe(`Bearer ${secret}`);
    await rm(path);
    const target = join(fixture.dir, "outside-token");
    writeSecretFile(target, secret);
    await symlink(target, path);
    fetcher.mockClear();
    await expect(localTarget(fixture.dir, "http://127.0.0.1:3636", "admin")).rejects.toThrow(
      "Could not read the emend credential.",
    );
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    await fixture.cleanup();
  }
});

test.each([200, 500])(
  "publish response %i body timeout distinguishes a possibly published revision",
  async (status) => {
    const fixture = await testDb();
    try {
      writeSecretFile(join(fixture.dir, "agent.token"), `em_${"a".repeat(43)}`);
      const proof = provenTestServer(fixture.dir);
      vi.stubGlobal(
        "fetch",
        async (url: string | URL, init?: RequestInit) =>
          proof(url, init) ??
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"partial":'));
                init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
              },
            }),
            { status, headers: { "Content-Type": "application/json" } },
          ),
      );
      await expect(
        apiRequest(fixture.dir, await localTarget(fixture.dir, "http://127.0.0.1:3636", "agent"), "/publish", {
          method: "POST",
          body: {},
          timeoutMs: 10,
        }),
      ).rejects.toThrow(
        status === 200
          ? "the server's answer timed out; the revision may have been published"
          : "The emend server returned an invalid response.",
      );
    } finally {
      await fixture.cleanup();
    }
  },
);

test.each([200, 500])("publish response %i body reset preserves possible publication", async (status) => {
  const fixture = await testDb();
  try {
    writeSecretFile(join(fixture.dir, "agent.token"), `em_${"a".repeat(43)}`);
    const proof = provenTestServer(fixture.dir);
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      const proven = proof(url, init);
      if (proven) return proven;
      signal = init?.signal;
      let partial = false;
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (partial) controller.error(new TypeError("connection reset"));
            else {
              controller.enqueue(new TextEncoder().encode('{"partial":'));
              partial = true;
            }
          },
        }),
        { status, headers: { "Content-Type": "application/json" } },
      );
    });
    await expect(
      apiRequest(fixture.dir, await localTarget(fixture.dir, "http://127.0.0.1:3636", "agent"), "/publish", {
        method: "POST",
        body: {},
      }),
    ).rejects.toThrow(
      status === 200
        ? "the server's answer was cut off; the revision may have been published"
        : "The emend server returned an invalid response.",
    );
    expect(signal?.aborted).toBe(false);
  } finally {
    await fixture.cleanup();
  }
});
