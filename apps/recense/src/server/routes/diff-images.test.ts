import { access, unlink } from "node:fs/promises";
import { join } from "node:path";
import { BinView, LIMITS, type PublishFile, PublishResponse, RevisionView } from "@recense/contract";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test } from "vitest";
import { blobs, diffImages, files, reviews } from "../../db/schema.ts";
import { error } from "../mailbox/test-support.ts";
import { bundle, importFixture, required } from "./import-test-support.ts";

let f: Awaited<ReturnType<typeof importFixture>>;
beforeEach(async () => {
  f = await importFixture();
});
afterEach(async () => {
  await f.cleanup();
});

const png = Buffer.from("89504e470d0a1a0a0001", "hex");
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>');
const store = (bytes: Buffer) => f.deps.blobs.put(f.ownerId, bytes, "application/octet-stream");
const diff = (patch: Partial<PublishFile> = {}): PublishFile => ({
  path: "icon.png",
  role: "diff",
  status: "modified",
  oldPath: null,
  oldBlob: null,
  newBlob: null,
  flag: "binary",
  ...patch,
});
const body = (files: PublishFile[], key = "b") => ({
  reviewKey: key.repeat(64),
  repo: null,
  branch: null,
  title: "Images",
  base: null,
  head: null,
  topics: [],
  writeup: { overview: "Synthetic", tldr: "", decisions: null, topics: {} },
  files,
});
async function publish(input: ReturnType<typeof body>, machine = false) {
  const response = machine
    ? await f.importRequest("/publish", input)
    : await f.request("/publish", "POST", input, "agent");
  expect(response.status).toBe(200);
  return PublishResponse.parse(await response.json()).reviewId;
}
async function view(id: string, seq = 1) {
  const response = await f.request(`/reviews/${id}/revisions/${seq}`, "GET");
  expect(response.status).toBe(200);
  return RevisionView.parse(await response.json()).files;
}
const rows = () => f.db.read((q) => q.select().from(diffImages).where(eq(diffImages.ownerId, f.ownerId)));

test.each([false, true])(
  "a reviewer can read both image types and their isolation headers (machine publish %s)",
  async (machine) => {
    const old = await store(png),
      next = await store(svg);
    const id = await publish(
      body([
        diff({
          path: "after.SVG",
          oldPath: "before.PNG",
          status: "renamed",
          image: { old: { blob: old }, new: { blob: next } },
        }),
      ]),
      machine,
    );
    const file = required((await view(id))[0]);
    expect(file).toMatchObject({ flag: "binary", hasOld: false, hasNew: false, mediaType: "text/plain" });
    expect(file.image).toEqual({
      old: { mediaType: "image/png", flag: null },
      new: { mediaType: "image/svg+xml", flag: null },
    });
    expect(await rows()).toHaveLength(2);
    for (const [side, bytes, type] of [
      ["old", png, "image/png"],
      ["new", svg, "image/svg+xml"],
    ] as const) {
      const path = `/files/${file.id}/${side}/image`;
      for (const method of ["GET", "HEAD"]) {
        const response = await f.request(path, method);
        expect(response.status).toBe(200);
        for (const [header, value] of Object.entries({
          "Content-Type": type,
          "Content-Length": String(bytes.length),
          "Cache-Control": "no-store",
          "Content-Disposition": "inline",
          "X-Content-Type-Options": "nosniff",
          "Cross-Origin-Resource-Policy": "same-origin",
          "X-Frame-Options": "DENY",
          "Referrer-Policy": "no-referrer",
          "Cross-Origin-Opener-Policy": "same-origin",
          "Content-Security-Policy":
            "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:",
        }))
          expect(response.headers.get(header), header).toBe(value);
        expect(Buffer.from(await response.arrayBuffer())).toEqual(method === "GET" ? bytes : Buffer.alloc(0));
      }
      await error(await f.request(path, "GET", undefined, "foreign"), 404, "not_found");
      await error(await f.request(path, "GET", undefined, "agent"), 403, "forbidden");
    }
    for (const hash of [old, next]) await error(await f.request(`/media/${hash}`, "GET"), 404, "not_found");
    expect((await f.request(`/reviews/${id}/bin`, "POST")).status).toBe(204);
    const path = `/files/${file.id}/old/image`;
    await error(await f.request(path, "GET"), 409, "review_in_bin");
    await f.db.query((q) =>
      q
        .update(reviews)
        .set({ movedToUrl: "https://hub.example/r/moved" })
        .where(and(eq(reviews.ownerId, f.ownerId), eq(reviews.id, id))),
    );
    expect(Buffer.from(await (await f.request(path, "GET")).arrayBuffer())).toEqual(png);
  },
);

test("old revisions omit image metadata and only stored matching hashes mark a pair unchanged", async () => {
  const blob = await store(png);
  const id = await publish(body([diff()]));
  await publish(
    body([
      diff({ image: { old: { blob }, new: { blob } } }),
      diff({ path: "large.png", status: "added", flag: "oversized", image: { old: null, new: { flag: "oversized" } } }),
    ]),
  );
  expect(required((await view(id))[0])).not.toHaveProperty("image");
  const [same, large] = await view(id, 2);
  expect(same?.image?.unchanged).toBe(true);
  expect(large?.image).toEqual({ old: null, new: { mediaType: "image/png", flag: "oversized" } });
  for (const path of [`/files/${large?.id}/old/image`, `/files/${large?.id}/new/image`, "/files/no-uuid/new/image"])
    await error(await f.request(path, "GET"), 404, "not_found");

  const fileId = required(same).id;
  const where = and(eq(files.ownerId, f.ownerId), eq(files.id, fileId));
  const path = `/files/${fileId}/new/image`;
  await f.db.query((q) => q.update(files).set({ path: "unknown.txt" }).where(where));
  expect(required((await view(id, 2))[0])).not.toHaveProperty("image");
  await error(await f.request(path, "GET"), 404, "not_found");
  await f.db.query((q) => q.update(files).set({ role: "asset", path: "icon.png" }).where(where));
  await error(await f.request(path, "GET"), 404, "not_found");
  await f.db.query((q) => q.update(files).set({ role: "diff" }).where(where));
  await unlink(join(f.dir, "state", "blobs", blob.slice(0, 2), blob));
  await error(await f.request(path, "GET"), 404, "not_found");
});

test("publish refuses a missing or over-limit image before inserting rows", async () => {
  const blob = await store(png);
  await f.db.query((q) =>
    q
      .update(blobs)
      .set({ size: LIMITS.assetBytes + 1 })
      .where(and(eq(blobs.ownerId, f.ownerId), eq(blobs.sha256, blob))),
  );
  for (const [hash, status, code] of [
    ["f".repeat(64), 400, "blob_missing"],
    [blob, 413, "too_large"],
  ] as const) {
    await error(
      await f.request(
        "/publish",
        "POST",
        body([diff({ image: { old: { blob: hash }, new: { flag: "oversized" } } })]),
        "agent",
      ),
      status,
      code,
    );
  }
  expect(await rows()).toEqual([]);
});

test("publish counts each image hash once across image and text sides", async () => {
  const blob = await store(svg);
  const file = diff({
    path: "icon.svg",
    flag: null,
    oldBlob: blob,
    newBlob: blob,
    image: { old: { blob }, new: { blob } },
  });
  const input = body([file, { ...file, path: "copy.svg" }]);
  const limit = LIMITS.revisionBytes;
  try {
    Object.assign(LIMITS, { revisionBytes: Buffer.byteLength(JSON.stringify(input.writeup)) + svg.length });
    await publish(input);
    const extra = await store(png);
    await error(
      await f.request(
        "/publish",
        "POST",
        { ...input, files: [...input.files, diff({ status: "added", image: { old: null, new: { blob: extra } } })] },
        "agent",
      ),
      413,
      "too_large",
    );
    expect(await rows()).toHaveLength(4);
  } finally {
    Object.assign(LIMITS, { revisionBytes: limit });
  }
});

test("deleting a review and emptying the bin collect image blobs after their last reference", async () => {
  const shared = await store(png),
    unique = await store(Buffer.concat([png, Buffer.from("unique")]));
  const first = await publish(body([diff({ image: { old: { blob: shared }, new: { blob: unique } } })]));
  const second = await publish(body([diff({ status: "added", image: { old: null, new: { blob: shared } } })], "c"));
  expect((await f.request(`/reviews/${first}`, "DELETE")).status).toBe(204);
  await f.blobCleanup();
  expect(await rows()).toMatchObject([{ blob: shared }]);
  expect(await f.deps.blobs.hasWhole(f.ownerId, unique)).toBe(false);
  await expect(access(join(f.dir, "state", "blobs", unique.slice(0, 2), unique))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await f.deps.blobs.hasWhole(f.ownerId, shared)).toBe(true);
  expect((await f.request(`/reviews/${second}/bin`, "POST")).status).toBe(204);
  const { version } = BinView.parse(await (await f.request("/bin", "GET")).json());
  expect((await f.request("/bin", "DELETE", { version })).status).toBe(204);
  await f.blobCleanup();
  expect(await rows()).toEqual([]);
  expect(await f.deps.blobs.hasWhole(f.ownerId, shared)).toBe(false);
  await expect(access(join(f.dir, "state", "blobs", shared.slice(0, 2), shared))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test.each([false, true])("import round-trips optional image sides (included %s)", async (included) => {
  const input = await bundle(f);
  const blob = await store(png);
  const file = { ...required(input.files[0]), ...diff({ status: "added" }) };
  const legacy = { ...input, files: [file] };
  const row = { fileId: file.id, side: "new", blob, flag: null };
  if (included) {
    await error(
      await f.importRequest("/import", { ...legacy, diffImages: [{ ...row, blob: "f".repeat(64) }] }),
      400,
      "blob_missing",
    );
    const where = and(eq(blobs.ownerId, f.ownerId), eq(blobs.sha256, blob));
    await f.db.query((q) =>
      q
        .update(blobs)
        .set({ size: LIMITS.assetBytes + 1 })
        .where(where),
    );
    await error(await f.importRequest("/import", { ...legacy, diffImages: [row] }), 413, "too_large");
    await f.db.query((q) => q.update(blobs).set({ size: png.length }).where(where));
  }
  expect((await f.importRequest("/import", included ? { ...legacy, diffImages: [row] } : legacy)).status).toBe(201);
  const imported = required((await view(input.review.id))[0]);
  const response = await f.request(`/files/${file.id}/new/image`, "GET");
  if (included) {
    expect(imported.image).toEqual({ old: null, new: { mediaType: "image/png", flag: null } });
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
  } else {
    expect(imported).not.toHaveProperty("image");
    await error(response, 404, "not_found");
  }
});
