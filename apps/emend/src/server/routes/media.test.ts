import { randomUUID } from "node:crypto";
import { type FileHandle, open, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { files } from "../../db/schema.ts";
import { error, mailboxFixture } from "../mailbox/test-support.ts";

let f: Awaited<ReturnType<typeof mailboxFixture>>;
beforeEach(async () => {
  f = await mailboxFixture();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await f.cleanup();
});

// A synthetic 1x1 PNG header; the route serves bytes without decoding them.
const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");

async function seed(overrides: Partial<typeof files.$inferInsert> = {}, fixture = f) {
  await fixture.db.query((q) =>
    q.insert(files).values({
      id: randomUUID(),
      ownerId: fixture.ownerId,
      revisionId: fixture.revisionId,
      path: `${randomUUID()}.png`,
      role: "asset",
      ord: 0,
      mediaType: "image/png",
      ...overrides,
    }),
  );
}

test("serves a declared image with locked-down headers for GET and HEAD", async () => {
  const hash = await f.deps.blobs.put(f.ownerId, png, "image/png");
  await seed({ newBlob: hash });
  for (const method of ["GET", "HEAD"]) {
    const response = await f.request(`/media/${hash}`, method);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe(String(png.length));
    expect(Object.fromEntries(["Content-Type", ...headerNames].map((n) => [n, response.headers.get(n)]))).toEqual({
      "Content-Type": "image/png",
      ...expected,
    });
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      method === "HEAD" ? new Uint8Array() : new Uint8Array(png),
    );
  }
});
const expected = {
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "sandbox; default-src 'none'",
  "Content-Disposition": "inline",
};
const headerNames = Object.keys(expected);

async function imageDescriptors(hash: string) {
  const probe = await open(join(f.dir, "state", "blobs", hash.slice(0, 2), hash), "r");
  const prototype: FileHandle = Object.getPrototypeOf(probe);
  await probe.close();
  const stats = vi.spyOn(prototype, "stat");
  const opens = vi.spyOn(f.deps.blobs, "open");
  return {
    opens,
    expectClosed(count: number) {
      expect(opens).toHaveBeenCalledTimes(count);
      const handles = [...new Set(stats.mock.contexts as FileHandle[])];
      expect(handles).toHaveLength(count);
      expect(handles.filter((handle) => handle.fd === -1)).toHaveLength(count);
    },
  };
}

test("large writeup images stream byte-exact without the buffered blob API", async () => {
  const bytes = Buffer.concat([png, Buffer.alloc(200 * 1024, 0x5a)]);
  const hash = await f.deps.blobs.put(f.ownerId, bytes, "image/png");
  await seed({ newBlob: hash });
  const descriptors = await imageDescriptors(hash);
  const get = vi.spyOn(f.deps.blobs, "get");
  const response = await f.request(`/media/${hash}`, "GET");
  expect(response.status).toBe(200);
  expect(
    Object.fromEntries(["Content-Type", ...headerNames].map((name) => [name, response.headers.get(name)])),
  ).toEqual({
    "Content-Type": "image/png",
    ...expected,
  });
  expect(response.headers.get("Content-Length")).toBe(String(bytes.length));
  expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  expect(get).not.toHaveBeenCalled();
  descriptors.expectClosed(1);
});

test.each(["cancel", "truncate"])("an image response closes its descriptor on %s", async (action) => {
  const bytes = Buffer.concat([png, Buffer.alloc(200 * 1024, 0x5a)]);
  const hash = await f.deps.blobs.put(f.ownerId, bytes, "image/png");
  await seed({ newBlob: hash });
  const descriptors = await imageDescriptors(hash);
  const response = await f.request(`/media/${hash}`, "GET");
  expect(response.status).toBe(200);
  if (action === "cancel") {
    if (!response.body) throw new Error("Missing image body");
    const reader = response.body.getReader();
    const chunk = await reader.read();
    expect(chunk.done).toBe(false);
    expect(chunk.value?.byteLength).toBe(64 * 1024);
    await reader.cancel();
  } else {
    await truncate(join(f.dir, "state", "blobs", hash.slice(0, 2), hash), 0);
    await expect(response.arrayBuffer()).rejects.toThrow("Blob ended before its verified size");
  }
  descriptors.expectClosed(1);
});

test("HEAD closes the image descriptor without creating a body stream", async () => {
  const hash = await f.deps.blobs.put(f.ownerId, png, "image/png");
  await seed({ newBlob: hash });
  const descriptors = await imageDescriptors(hash);
  const response = await f.request(`/media/${hash}`, "HEAD");
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Length")).toBe(String(png.length));
  expect(await response.text()).toBe("");
  descriptors.expectClosed(1);
  const read = await descriptors.opens.mock.results[0]?.value;
  expect(() => read?.stream()).toThrow();
});

test.each(["HEAD", "GET"])("%s setup failures retain app error headers and close the image", async (method) => {
  const hash = await f.deps.blobs.put(f.ownerId, png, "image/png");
  await seed({ newBlob: hash });
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
  const response = await f.request(`/media/${hash}`, method);
  const read = await opens.mock.results[0]?.value;
  try {
    expect(response.status).toBe(500);
    expect(response.headers.has("Content-Length")).toBe(false);
    expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
    expect(response.headers.has("Cross-Origin-Resource-Policy")).toBe(false);
    expect(response.headers.has("Content-Disposition")).toBe(false);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(response.headers.get("Content-Security-Policy")).not.toBe(expected["Content-Security-Policy"]);
    expect(read?.closed).toBe(true);
    if (method === "HEAD") expect(await response.text()).toBe("");
    else expect(await response.json()).toMatchObject({ error: { code: "internal" } });
  } finally {
    await read?.close().catch(() => {});
  }
});

test("fixture cleanup closes and reports a dropped response body", async () => {
  const isolated = await mailboxFixture();
  const opens = vi.spyOn(isolated.deps.blobs, "open");
  let cleanupStarted = false;
  try {
    const hash = await isolated.deps.blobs.put(isolated.ownerId, png, "image/png");
    await seed({ newBlob: hash }, isolated);
    const response = await isolated.request(`/media/${hash}`, "GET");
    expect(response.status).toBe(200);
    expect(response.bodyUsed).toBe(false);
    cleanupStarted = true;
    await expect(isolated.cleanup()).rejects.toThrow("1 BlobRead left open");
    const read = await opens.mock.results[0]?.value;
    expect(read?.closed).toBe(true);
    expect(() => read?.stream()).toThrow();
  } finally {
    const read = await opens.mock.results[0]?.value;
    await read?.close();
    if (!cleanupStarted) await isolated.cleanup();
  }
});

test("an aborted image request closes its verified descriptor and returns no body stream", async () => {
  const bytes = Buffer.concat([png, Buffer.alloc(200 * 1024, 0x5a)]);
  const hash = await f.deps.blobs.put(f.ownerId, bytes, "image/png");
  await seed({ newBlob: hash });
  const descriptors = await imageDescriptors(hash);
  const controller = new AbortController();
  controller.abort();
  const response = await f.request(`/media/${hash}`, "GET", undefined, "reviewer", controller.signal);
  try {
    await error(response, 404, "not_found");
    expect(descriptors.opens.mock.calls[0]?.[2]?.aborted).toBe(true);
    expect(await descriptors.opens.mock.results[0]?.value).toBeNull();
    descriptors.expectClosed(1);
  } finally {
    const read = await descriptors.opens.mock.results[0]?.value;
    await read?.close();
  }
});

test.each(["hash", "size"])(
  "an image with a mismatched %s returns no image bytes or success headers",
  async (mismatch) => {
    const hash = await f.deps.blobs.put(f.ownerId, png, "image/png");
    await seed({ newBlob: hash });
    const descriptors = await imageDescriptors(hash);
    const wrong = Buffer.alloc(mismatch === "hash" ? png.length : 100, "Z");
    await writeFile(join(f.dir, "state", "blobs", hash.slice(0, 2), hash), wrong);
    const response = await f.request(`/media/${hash}`, "GET");
    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).not.toMatch(/^image\//);
    expect(response.headers.has("Content-Length")).toBe(false);
    expect(response.headers.has("Content-Disposition")).toBe(false);
    const body = await response.text();
    expect(body).not.toContain("Z");
    expect(Buffer.from(body).includes(png)).toBe(false);
    expect(JSON.parse(body)).toMatchObject({ error: { code: "not_found" } });
    expect(await descriptors.opens.mock.results[0]?.value).toBeNull();
    descriptors.expectClosed(1);
  },
);

test("an HTML doc's parented PNG asset is not served, while writeup media is", async () => {
  const docHash = await f.deps.blobs.put(f.ownerId, png, "image/png");
  const doc = randomUUID();
  await seed({ id: doc, path: "plan.html", role: "doc", mediaType: "text/html", newBlob: docHash });
  await seed({ path: "a.png", parentDocId: doc, newBlob: docHash });
  await error(await f.request(`/media/${docHash}`, "GET"), 404, "not_found");
  // Another image of the same owner, as writeup media, still resolves.
  const shot = await f.deps.blobs.put(f.ownerId, Buffer.concat([png, Buffer.from("shot")]), "image/png");
  await seed({ path: "media/shot.png", newBlob: shot });
  const response = await f.request(`/media/${shot}`, "GET");
  expect(response.status).toBe(200);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.concat([png, Buffer.from("shot")]));
});

test("the same bytes as a doc asset and as writeup media are served through the parentless row", async () => {
  const hash = await f.deps.blobs.put(f.ownerId, png, "image/png");
  const doc = randomUUID();
  await seed({ id: doc, path: "plan.html", role: "doc", mediaType: "text/html", newBlob: hash });
  // The parented row sorts first by type, so only the parentless filter lets the media row win.
  await seed({ path: "a.gif", mediaType: "image/gif", parentDocId: doc, newBlob: hash });
  await seed({ path: "media/a.png", mediaType: "image/png", newBlob: hash });
  const response = await f.request(`/media/${hash}`, "GET");
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("image/png");
  expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
});

test("the same bytes stored as two image types serve one stable type", async () => {
  const hash = await f.deps.blobs.put(f.ownerId, png, "image/png");
  await seed({ path: "a.gif", mediaType: "image/gif", newBlob: hash });
  await seed({ path: "a.png", mediaType: "image/png", newBlob: hash });
  const types = [];
  for (let i = 0; i < 2; i++) {
    const response = await f.request(`/media/${hash}`, "GET");
    types.push(response.headers.get("Content-Type"));
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
  }
  expect(types).toEqual(["image/gif", "image/gif"]);
});

test("refuses bad hashes, other owners, diff blobs, SVG, missing bytes and non-image assets", async () => {
  const hash = await f.deps.blobs.put(f.ownerId, png, "image/png");
  await seed({ newBlob: hash });
  for (const bad of ["abc", hash.toUpperCase(), `${hash}0`, "g".repeat(64), "%2e%2e"])
    await error(await f.request(`/media/${bad}`, "GET"), 404, "not_found");
  await error(await f.request(`/media/${hash}`, "GET", undefined, "foreign"), 404, "not_found");
  await error(await f.request(`/media/${"e".repeat(64)}`, "GET"), 404, "not_found");

  const diff = await f.deps.blobs.put(f.ownerId, Buffer.from("synthetic diff side"), "text/plain");
  await seed({ role: "diff", mediaType: "text/plain", newBlob: diff, oldBlob: diff });
  await error(await f.request(`/media/${diff}`, "GET"), 404, "not_found");

  const svg = await f.deps.blobs.put(f.ownerId, Buffer.from('<svg onload="x"/>'), "image/svg+xml");
  await seed({ path: "a.svg", mediaType: "image/svg+xml", newBlob: svg });
  await error(await f.request(`/media/${svg}`, "GET"), 404, "not_found");

  const css = await f.deps.blobs.put(f.ownerId, Buffer.from("body{}"), "text/css");
  await seed({ path: "a.css", mediaType: "text/css", newBlob: css });
  await error(await f.request(`/media/${css}`, "GET"), 404, "not_found");

  vi.spyOn(f.deps.blobs, "open").mockResolvedValue(null);
  await error(await f.request(`/media/${hash}`, "GET"), 404, "not_found");
});

test("an unauthenticated request is refused like other API routes", async () => {
  const hash = await f.deps.blobs.put(f.ownerId, png, "image/png");
  await seed({ newBlob: hash });
  const response = await f.app.request(`http://127.0.0.1:3636/api/v1/media/${hash}`, {
    headers: { Host: "127.0.0.1:3636" },
  });
  expect(response.status).toBe(401);
  expect(response.headers.get("Content-Type")).not.toMatch(/^image\//);
  expect(await response.json()).toMatchObject({ error: { code: "unauthorized" } });
});
