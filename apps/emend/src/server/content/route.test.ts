import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { type FileHandle, open, rename, truncate, utimes, writeFile } from "node:fs/promises";
import { type ClientRequest, createServer, request as httpRequest } from "node:http";
import { join } from "node:path";
import { RevisionView } from "@emend/contract";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { devices, files, reviews, revisions } from "../../db/schema.ts";
import { mailboxFixture } from "../mailbox/test-support.ts";
import { nodeRequestHandler } from "../serve.ts";
import { BRIDGE_SOURCE } from "./bridge.ts";

let f: Awaited<ReturnType<typeof mailboxFixture>>;
let docUrl: string;
let secondUrl: string;
const origin = "http://127.0.0.1:3636";
const csp =
  "sandbox allow-scripts; default-src 'none'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self'; connect-src 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'self'";
const docCsp = csp.replace(
  "script-src 'none'",
  `script-src 'sha256-${createHash("sha256").update(BRIDGE_SOURCE).digest("base64")}'`,
);
const source =
  '<body><p>Synthetic seeds</p><link rel="stylesheet" href="shared.css"><script src="classic.js"></script><img src="seed.svg"></body>';
const bigCss = "/* synthetic */\n".padEnd(200 * 1024, " ");
const bigSha = createHash("sha256").update(bigCss).digest("hex");
beforeEach(async () => {
  f = await mailboxFixture();
  const entries = [
    ["docs/a #é.html", "doc", source],
    ["docs/b.html", "doc", source],
    ["docs/shared.css", "asset", "p { color: green; }"],
    ["docs/classic.js", "asset", "window.synthetic = true;"],
    ["docs/seed.svg", "asset", '<svg xmlns="http://www.w3.org/2000/svg"/>'],
    ["docs/data.css", "asset", '{"synthetic":true}'],
    ["docs/big.css", "asset", bigCss],
    ["docs/unlisted.css", "asset", "p {}"],
    ["docs/change.html", "diff", "<script>synthetic()</script>"],
  ];
  const inputFiles = [];
  for (const [path, role, text] of entries) {
    if (!path || !role || text === undefined) throw new Error("Invalid fixture");
    const hash = await f.deps.blobs.put(f.ownerId, Buffer.from(text), "application/octet-stream");
    inputFiles.push({
      path,
      role,
      oldPath: null,
      oldBlob: null,
      newBlob: hash,
      flag: null,
      ...(role === "doc"
        ? { assets: ["docs/shared.css", "docs/classic.js", "docs/seed.svg", "docs/data.css", "docs/big.css"] }
        : {}),
      ...(role === "asset" ? { parent: "docs/a #é.html" } : {}),
    });
  }
  const published = await f.request(
    "/publish",
    "POST",
    {
      reviewId: f.reviewId,
      reviewKey: "a".repeat(64),
      repo: null,
      branch: null,
      title: "Synthetic HTML",
      base: null,
      head: null,
      topics: [],
      files: inputFiles,
      writeup: { overview: "Synthetic", tldr: "Summary", decisions: null, topics: {} },
    },
    "agent",
  );
  expect(published.status).toBe(200);
  await f.db.query((q) =>
    q
      .update(files)
      .set({ mediaType: "application/json" })
      .where(and(eq(files.ownerId, f.ownerId), eq(files.path, "docs/data.css"))),
  );
  const view = RevisionView.parse(await (await f.request(`/reviews/${f.reviewId}/revisions/2`, "GET")).json());
  const first = view.docs[0],
    second = view.docs[1];
  if (first?.kind !== "html" || second?.kind !== "html") throw new Error("Missing docs");
  docUrl = first.contentUrl;
  secondUrl = second.contentUrl;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await f.cleanup();
});
function request(path: string, method = "GET", headers: Record<string, string> = {}) {
  return f.app.request(`${origin}${path}`, { method, headers: { Host: "127.0.0.1:3636", ...headers } });
}
function headers(response: Response, asset = false) {
  expect(response.headers.get("Content-Security-Policy")).toBe(response.ok && !asset ? docCsp : csp);
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe(asset ? "cross-origin" : "same-origin");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.has("X-Frame-Options")).toBe(false);
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe(asset ? "*" : null);
}

async function assetHandlePrototype() {
  const handle = await open(join(f.dir, "state", "blobs", bigSha.slice(0, 2), bigSha), "r");
  const prototype: FileHandle = Object.getPrototypeOf(handle);
  await handle.close();
  return prototype;
}

async function assetDescriptors() {
  const stats = vi.spyOn(await assetHandlePrototype(), "stat");
  const opens = vi.spyOn(f.deps.blobs, "open");
  const handles = () => [...new Set(stats.mock.contexts as FileHandle[])];
  return {
    opens,
    handles,
    expectClosed(count: number) {
      expect(opens).toHaveBeenCalledTimes(count);
      expect(handles()).toHaveLength(count);
      expect(handles().filter((handle) => handle.fd === -1)).toHaveLength(count);
    },
  };
}

test("large assets stream byte-exact with their isolation headers and content length", async () => {
  const descriptors = await assetDescriptors();
  const get = vi.spyOn(f.deps.blobs, "get");
  const response = await request(new URL("big.css", origin + docUrl).pathname);
  expect(response.status).toBe(200);
  headers(response, true);
  expect(response.headers.get("Content-Type")).toBe("text/css; charset=utf-8");
  expect(response.headers.get("Content-Length")).toBe(String(Buffer.byteLength(bigCss)));
  expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(bigCss));
  expect(get).not.toHaveBeenCalled();
  descriptors.expectClosed(1);
});

test("parallel query variants verify an asset once before any response body is pulled", async () => {
  const descriptors = await assetDescriptors();
  const reads = vi.spyOn(await assetHandlePrototype(), "read");
  const path = new URL("big.css", origin + docUrl).pathname;
  const responses = await Promise.all(Array.from({ length: 20 }, (_, i) => request(`${path}?${i + 1}`)));
  expect(reads).toHaveBeenCalledTimes(Math.ceil(Buffer.byteLength(bigCss) / (64 * 1024)) + 1);
  await Promise.all(
    responses.map(async (response) => {
      expect(response.status).toBe(200);
      headers(response, true);
      expect(Buffer.from(await response.arrayBuffer()).equals(Buffer.from(bigCss))).toBe(true);
    }),
  );
  descriptors.expectClosed(20);
});

test("cancelling twenty parallel asset responses after one chunk closes every descriptor", async () => {
  const descriptors = await assetDescriptors();
  const path = new URL("big.css", origin + docUrl).pathname;
  const responses = await Promise.all(Array.from({ length: 20 }, (_, i) => request(`${path}?${i + 1}`)));
  const readers = responses.map((response) => {
    expect(response.status).toBe(200);
    headers(response, true);
    if (!response.body) throw new Error("Missing asset body");
    return response.body.getReader();
  });
  const chunks = await Promise.all(readers.map((reader) => reader.read()));
  for (const chunk of chunks) {
    expect(chunk.done).toBe(false);
    expect(chunk.value?.byteLength).toBe(64 * 1024);
  }
  expect(descriptors.handles().filter((handle) => handle.fd !== -1)).toHaveLength(20);
  await Promise.all(readers.map((reader) => reader.cancel()));
  descriptors.expectClosed(20);
});

test("aborting while an asset open is awaiting returns only an isolated error and closes the descriptor", async () => {
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<AbortSignal | undefined>();
  const controller = new AbortController();
  const originalOpen = f.deps.blobs.open.bind(f.deps.blobs);
  const descriptors = await assetDescriptors();
  descriptors.opens.mockImplementation(async (owner, sha, signal) => {
    entered.resolve(signal);
    await gate.promise;
    return originalOpen(owner, sha, signal);
  });
  const pending = f.app.request(
    f.keep(
      new Request(new URL("big.css", origin + docUrl), {
        headers: { Host: "127.0.0.1:3636" },
        signal: controller.signal,
      }),
    ),
  );
  try {
    const signal = await entered.promise;
    expect(signal).toBeInstanceOf(AbortSignal);
    controller.abort();
    expect(signal?.aborted).toBe(true);
    gate.resolve();
    const response = await pending;
    expect(response.status).toBe(404);
    headers(response);
    expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
    expect(await descriptors.opens.mock.results[0]?.value).toBeNull();
    descriptors.expectClosed(1);
  } finally {
    gate.resolve();
    await pending;
    const read = await descriptors.opens.mock.results[0]?.value;
    await read?.close();
  }
});

test("disconnecting while an asset open is awaiting closes the descriptor before returning a body", async () => {
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<AbortSignal | undefined>();
  const closed = Promise.withResolvers<FileHandle>();
  const handled = Promise.withResolvers<void>();
  const prototype = await assetHandlePrototype();
  const originalStat = prototype.stat;
  const closes: FileHandle[] = [];
  const stats = vi.spyOn(prototype, "stat").mockImplementationOnce(function (this: FileHandle, ...args) {
    const originalClose = this.close.bind(this);
    vi.spyOn(this, "close").mockImplementation(async () => {
      await originalClose();
      closes.push(this);
      closed.resolve(this);
    });
    return originalStat.apply(this, args);
  });
  const originalOpen = f.deps.blobs.open.bind(f.deps.blobs);
  const openBlob = vi.spyOn(f.deps.blobs, "open").mockImplementation(async (owner, sha, signal?: AbortSignal) => {
    entered.resolve(signal);
    await gate.promise;
    return originalOpen(owner, sha, signal);
  });
  const handler = nodeRequestHandler(f.app, f.deps.config);
  const server = createServer((incoming, outgoing) => {
    void handler(incoming, outgoing).then(handled.resolve, handled.reject);
  });
  let client: ClientRequest | undefined;
  try {
    const listening = once(server, "listening");
    server.listen(0, "127.0.0.1");
    await listening;
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    client = httpRequest({
      hostname: "127.0.0.1",
      port: address.port,
      path: new URL("big.css", origin + docUrl).pathname,
      headers: { Host: "127.0.0.1:3636" },
      agent: false,
    });
    // Destroying the client intentionally emits ECONNRESET; failures before entry must unblock the test.
    client.on("error", entered.reject);
    client.end();
    const signal = await entered.promise;
    expect(signal).toBeInstanceOf(AbortSignal);
    if (!signal) throw new Error("Missing request signal");
    const aborted = once(signal, "abort");
    client.destroy();
    await aborted;
    expect(signal.aborted).toBe(true);
    gate.resolve();
    expect(await openBlob.mock.results[0]?.value).toBeNull();
    const handle = await closed.promise;
    await handled.promise;
    expect(handle.fd).toBe(-1);
    expect(closes).toEqual([handle]);
    expect([...new Set(stats.mock.contexts as FileHandle[])]).toEqual([handle]);
  } finally {
    client?.destroy();
    gate.resolve();
    const read = await openBlob.mock.results[0]?.value;
    await read?.close();
    server.closeAllConnections();
    if (server.listening)
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("an asset truncated after open errors its response body and closes its descriptor", async () => {
  const descriptors = await assetDescriptors();
  const response = await request(new URL("big.css", origin + docUrl).pathname);
  expect(response.status).toBe(200);
  expect(descriptors.handles().filter((handle) => handle.fd !== -1)).toHaveLength(1);
  await truncate(join(f.dir, "state", "blobs", bigSha.slice(0, 2), bigSha), 0);
  await expect(response.arrayBuffer()).rejects.toThrow("Blob ended before its verified size");
  descriptors.expectClosed(1);
});

test("HEAD verifies an asset and closes its descriptor without creating a body stream", async () => {
  const descriptors = await assetDescriptors();
  const response = await request(new URL("big.css", origin + docUrl).pathname, "HEAD");
  expect(response.status).toBe(200);
  headers(response, true);
  expect(response.headers.get("Content-Type")).toBe("text/css; charset=utf-8");
  expect(response.headers.get("Content-Length")).toBe(String(Buffer.byteLength(bigCss)));
  expect(await response.text()).toBe("");
  descriptors.expectClosed(1);
  const read = await descriptors.opens.mock.results[0]?.value;
  expect(() => read?.stream()).toThrow();
});

test.each(["HEAD", "GET"])("%s setup failures retain content error headers and close the asset", async (method) => {
  const originalOpen = f.deps.blobs.open.bind(f.deps.blobs);
  const opens = vi.spyOn(f.deps.blobs, "open").mockImplementation(async (...args) => {
    const read = await originalOpen(...args);
    if (!read) throw new Error("Missing blob");
    if (method === "HEAD") {
      const close = read.close.bind(read);
      vi.spyOn(read, "close").mockImplementation(async () => {
        await close();
        throw new Error("Synthetic close failure");
      });
    } else {
      vi.spyOn(read, "stream").mockImplementation(() => {
        throw new Error("Synthetic stream failure");
      });
    }
    return read;
  });
  const response = await request(new URL("big.css", origin + docUrl).pathname, method);
  const read = await opens.mock.results[0]?.value;
  try {
    expect(response.status).toBe(500);
    headers(response);
    expect(response.headers.has("Content-Length")).toBe(false);
    expect(response.headers.has("Content-Disposition")).toBe(false);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(read?.closed).toBe(true);
    if (method === "HEAD") expect(await response.text()).toBe("");
    else expect(await response.json()).toMatchObject({ error: { code: "internal" } });
  } finally {
    await read?.close().catch(() => {});
  }
});

test("HTML doc reads stay on the read-only database scope", async () => {
  const query = vi.spyOn(f.deps.db, "query");
  const get = vi.spyOn(f.deps.blobs, "get");
  const response = await request(docUrl);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("<p>Synthetic seeds</p>");
  expect(get).toHaveBeenCalledTimes(1);
  expect(get.mock.calls[0]?.[2]).toBeDefined();
  expect(query).not.toHaveBeenCalled();
});

test.each(["hash", "size"])("an asset with a mismatched %s returns only an isolated error", async (mismatch) => {
  const descriptors = await assetDescriptors();
  const wrong = Buffer.alloc(mismatch === "hash" ? Buffer.byteLength(bigCss) : 100, "Z");
  await writeFile(join(f.dir, "state", "blobs", bigSha.slice(0, 2), bigSha), wrong);
  const response = await request(new URL("big.css", origin + docUrl).pathname);
  expect(response.status).toBe(404);
  headers(response);
  expect(response.headers.get("Content-Type")).not.toContain("text/css");
  expect(response.headers.has("Content-Length")).toBe(false);
  const body = await response.text();
  expect(body).not.toContain("Z");
  expect(body).not.toContain("synthetic");
  expect(JSON.parse(body)).toMatchObject({ error: { code: "not_found" } });
  expect(await descriptors.opens.mock.results[0]?.value).toBeNull();
  descriptors.expectClosed(1);
});

test.each(["rename", "in-place rewrite"])(
  "a verified asset corrupted by %s is reverified and never served",
  async (change) => {
    const descriptors = await assetDescriptors();
    const reads = vi.spyOn(await assetHandlePrototype(), "read");
    const path = new URL("big.css", origin + docUrl).pathname;
    const original = await request(path);
    expect(original.status).toBe(200);
    expect(await original.text()).toBe(bigCss);
    descriptors.expectClosed(1);
    const file = join(f.dir, "state", "blobs", bigSha.slice(0, 2), bigSha);
    const wrong = Buffer.alloc(Buffer.byteLength(bigCss), "Z");
    if (change === "rename") {
      await writeFile(`${file}.replacement`, wrong, { mode: 0o600 });
      await rename(`${file}.replacement`, file);
    } else {
      await writeFile(file, wrong);
      await utimes(file, 1000, 1000);
    }
    reads.mockClear();
    const response = await request(path);
    expect(response.status).toBe(404);
    headers(response);
    expect(reads).toHaveBeenCalledTimes(Math.ceil(wrong.length / (64 * 1024)) + 1);
    const body = await response.text();
    expect(body).not.toContain("Z");
    expect(JSON.parse(body)).toMatchObject({ error: { code: "not_found" } });
    descriptors.expectClosed(2);
  },
);

test("an asset that cannot be opened retains content error headers without CORS", async () => {
  vi.spyOn(f.deps.blobs, "open").mockResolvedValue(null);
  const response = await request(new URL("big.css", origin + docUrl).pathname);
  expect(response.status).toBe(404);
  headers(response);
});
test("doc key names one HTML doc; GET/HEAD serve injected docs and byte-exact relative assets", async () => {
  expect(docUrl).toMatch(/^\/content\/[A-Za-z0-9_-]{43}[0-9a-f]{32}\/docs\/a%20%23%C3%A9.html$/);
  for (const method of ["GET", "HEAD"]) {
    const response = await request(docUrl, method, { Cookie: "emend_session=ignored", Authorization: "ignored" });
    expect(response.status).toBe(200);
    headers(response);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const text = await response.text();
    if (method === "HEAD") expect(text).toBe("");
    else {
      const scripts = [...text.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
      expect(scripts).toEqual([BRIDGE_SOURCE]);
      const hash = createHash("sha256")
        .update(scripts[0] ?? "")
        .digest("base64");
      expect(response.headers.get("Content-Security-Policy")).toContain(`script-src 'sha256-${hash}';`);
      expect(text).toContain("<p>Synthetic seeds</p>");
    }
    for (const [path, type, bytes] of [
      ["shared.css", "text/css; charset=utf-8", "p { color: green; }"],
      ["classic.js", "text/javascript; charset=utf-8", "window.synthetic = true;"],
      ["seed.svg", "image/svg+xml; charset=utf-8", '<svg xmlns="http://www.w3.org/2000/svg"/>'],
      ["data.css", "application/json; charset=utf-8", '{"synthetic":true}'],
    ]) {
      const url = new URL(path ?? "", origin + docUrl);
      const asset = await request(url.pathname, method, { Origin: "null" });
      expect(asset.status).toBe(200);
      headers(asset, true);
      expect(asset.headers.get("Content-Type")).toBe(type);
      expect(await asset.text()).toBe(method === "HEAD" ? "" : bytes);
    }
  }
});
test("shared asset loads under both doc keys, but other docs, diff files and unlisted assets never do", async () => {
  for (const url of [docUrl, secondUrl]) {
    const shared = await request(new URL("shared.css", origin + url).pathname);
    expect(shared.status).toBe(200);
    expect(await shared.text()).toBe("p { color: green; }");
    for (const path of ["unlisted.css", "change.html", "missing.css", url === docUrl ? "b.html" : "a%20%23%C3%A9.html"])
      expect((await request(new URL(path, origin + url).pathname)).status).toBe(404);
  }
});
test("script text before the real body close preserves the injected script and its CSP hash", async () => {
  const html = '<body><p>Seed</p><script>const ending = "</body>";</script></body>';
  const blob = await f.deps.blobs.put(f.ownerId, Buffer.from(html), "text/html");
  await f.db.query((q) =>
    q
      .update(files)
      .set({ newBlob: blob })
      .where(and(eq(files.ownerId, f.ownerId), eq(files.path, "docs/a #é.html"))),
  );
  const response = await request(docUrl);
  expect(response.status).toBe(200);
  headers(response);
  const texts = [...(await response.text()).matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  expect(texts).toEqual(['const ending = "</body>";', BRIDGE_SOURCE]);
  const hash = createHash("sha256")
    .update(texts[1] ?? "")
    .digest("base64");
  expect(response.headers.get("Content-Security-Policy")).toContain(`script-src 'sha256-${hash}';`);
});
test("bad keys and paths have content headers even with a valid reviewer cookie", async () => {
  const key = docUrl.split("/")[2] ?? "";
  const revision = await f.db.read((q) =>
    q
      .select()
      .from(revisions)
      .where(and(eq(revisions.ownerId, f.ownerId), eq(revisions.seq, 2)))
      .get(),
  );
  if (!revision) throw new Error("Missing revision");
  const otherKey = "Z".repeat(43);
  await f.db.query((q) =>
    q
      .update(revisions)
      .set({ contentKey: otherKey })
      .where(and(eq(revisions.ownerId, f.ownerId), eq(revisions.id, f.revisionId))),
  );
  const { createToken, SESSION_MS } = await import("../auth/tokens.ts");
  const deviceId = randomUUID();
  await f.db.query((q) =>
    q.insert(devices).values({ id: deviceId, ownerId: f.ownerId, kind: "browser", name: "Synthetic" }),
  );
  const session = await createToken(f.db, f.ownerId, "reviewer", { deviceId, expiresAt: f.deps.now() + SESSION_MS });
  expect((await request("/api/v1/reviews", "GET", { Cookie: `emend_session=${session.secret}` })).status).toBe(200);
  for (const path of [
    `/content/${key.slice(1)}/docs/b.html`,
    `/content/${key}0/docs/b.html`,
    `/content/${revision.contentKey}${randomUUID().replaceAll("-", "")}/docs/b.html`,
    `/content/${otherKey}${key.slice(43)}/docs/b.html`,
    `/content/${key}/docs/%`,
    `/content/${key}/docs//shared.css`,
    `/content/${key}/docs/%2e%2e%2fshared.css`,
    `/content/${key}/docs/%00`,
    `/content/${key}/docs/%2Fshared.css`,
    "/content/",
  ]) {
    const response = await request(path, "GET", { Cookie: `emend_session=${session.secret}` });
    expect(response.status, path).toBe(404);
    headers(response);
  }
  for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
    const response = await request(docUrl, method);
    expect(response.status).toBe(404);
    headers(response);
  }
  const refused = await request(docUrl, "GET", { Host: "invalid.example" });
  expect(refused.status).toBe(403);
  headers(refused);
});
test("blob failures retain content headers without CORS", async () => {
  vi.spyOn(f.deps.blobs, "get").mockResolvedValue(null);
  const response = await request(docUrl);
  expect(response.status).toBe(404);
  headers(response);
});
test("asset associations are owner/revision constrained and content keys are unique", async () => {
  const rows = await f.db.read((q) =>
    q
      .select()
      .from(files)
      .where(and(eq(files.ownerId, f.ownerId), eq(files.role, "doc"))),
  );
  const doc = rows[0];
  if (!doc) throw new Error("Missing doc");
  await expect(
    f.db.query((q) =>
      q.run(sql`INSERT INTO doc_assets VALUES (${f.otherOwnerId}, ${doc.revisionId}, ${doc.id}, ${doc.id})`),
    ),
  ).rejects.toThrow();
  await expect(
    f.db.query((q) => q.run(sql`INSERT INTO doc_assets VALUES (${f.ownerId}, ${f.revisionId}, ${doc.id}, ${doc.id})`)),
  ).rejects.toThrow();
  const key = docUrl.split("/")[2]?.slice(0, 43);
  await expect(
    f.db.query((q) =>
      q
        .update(revisions)
        .set({ contentKey: key })
        .where(and(eq(revisions.ownerId, f.ownerId), eq(revisions.id, f.revisionId))),
    ),
  ).rejects.toThrow();
});

test("a real foreign doc id cannot be combined with this revision capability", async () => {
  const reviewId = randomUUID(),
    revisionId = randomUUID(),
    fileId = randomUUID();
  await f.db.query(async (q) => {
    await q.insert(reviews).values({
      id: reviewId,
      ownerId: f.otherOwnerId,
      originInstanceId: f.instanceId,
      reviewKey: "b".repeat(64),
      title: "Synthetic foreign review",
    });
    await q
      .insert(revisions)
      .values({ id: revisionId, ownerId: f.otherOwnerId, reviewId, seq: 1, contentKey: "f".repeat(43) });
    await q.insert(files).values({
      id: fileId,
      ownerId: f.otherOwnerId,
      revisionId,
      role: "doc",
      path: "docs/b.html",
      mediaType: "text/html",
      ord: 0,
    });
  });
  const key = docUrl.split("/")[2]?.slice(0, 43);
  const response = await request(`/content/${key}${fileId.replaceAll("-", "")}/docs/b.html`);
  expect(response.status).toBe(404);
  headers(response);
});

test("publishing more than 500 associations retains every shared asset under both docs", async () => {
  const blob = await f.deps.blobs.put(f.ownerId, Buffer.from("p {}"), "text/css");
  const assets = Array.from({ length: 501 }, (_, i) => `many/${i}.css`);
  const published = await f.request(
    "/publish",
    "POST",
    {
      reviewId: f.reviewId,
      reviewKey: "a".repeat(64),
      repo: null,
      branch: null,
      title: "Synthetic shared assets",
      base: null,
      head: null,
      topics: [],
      writeup: { overview: "Synthetic", tldr: "Summary", decisions: null, topics: {} },
      files: [
        ...["many/a.html", "many/b.html"].map((path) => ({
          path,
          role: "doc",
          oldPath: null,
          oldBlob: null,
          newBlob: blob,
          flag: null,
          assets,
        })),
        ...assets.map((path) => ({
          path,
          role: "asset",
          oldPath: null,
          oldBlob: null,
          newBlob: blob,
          flag: null,
          parent: "many/a.html",
        })),
      ],
    },
    "agent",
  );
  expect(published.status).toBe(200);
  const view = RevisionView.parse(await (await f.request(`/reviews/${f.reviewId}/revisions/3`, "GET")).json());
  for (const doc of view.docs) {
    if (doc.kind !== "html") throw new Error("Missing HTML doc");
    for (const name of ["0.css", "499.css", "500.css"]) {
      const response = await request(new URL(name, origin + doc.contentUrl).pathname);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("p {}");
    }
  }
  expect(await f.db.read((q) => q.values(sql`SELECT count(*) FROM doc_assets WHERE owner_id = ${f.ownerId}`))).toEqual([
    [1012],
  ]);
});
