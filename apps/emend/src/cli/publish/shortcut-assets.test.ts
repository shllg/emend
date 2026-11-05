import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { LIMITS, type PublishManifest } from "@emend/contract";
import { expect, test, vi } from "vitest";
import { directFixture } from "../direct-test-support.ts";
import * as reads from "./read.ts";
import { publishContext, resolvePublish } from "./resolve.ts";
import { shortcutManifest } from "./shortcut.ts";
import { readBlob } from "./upload.ts";

vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof import("node:fs/promises")>()) }));
vi.mock("./read.ts", async (original) => ({ ...(await original<typeof import("./read.ts")>()) }));

const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
async function fixture() {
  const f = await directFixture();
  await fs.rm(f.manifest);
  await fs.rm(join(f.source, "plan.md"));
  async function file(path: string, bytes: string | Buffer) {
    const source = join(f.source, path);
    await fs.mkdir(join(source, ".."), { recursive: true });
    await fs.writeFile(source, bytes, { mode: 0o644 });
    return source;
  }
  async function prepare(paths: string[]) {
    const context = await publishContext(f.source, f.stateDir);
    const shortcut = await shortcutManifest({ paths }, f.stateDir, f.source, context);
    return () =>
      resolvePublish(
        shortcut.manifest,
        {
          key: shortcut.key,
          docFolders: shortcut.docFolders,
          skipNodeModules: true,
        },
        f.stateDir,
        "instance",
        f.source,
        () => {},
        context,
      );
  }
  return { ...f, file, prepare };
}

test("64 docs read their shared 1 MiB asset once per phase", async () => {
  const f = await fixture();
  const image = Buffer.alloc(1024 * 1024, 65);
  const source = await f.file("bundle/logo.png", image);
  for (let i = 0; i < 64; i++) await f.file(`bundle/doc-${i}.html`, '<img src="logo.png">');
  const collect = await f.prepare(["bundle"]);
  const read = vi.spyOn(reads, "readRegular");
  const stat = vi.spyOn(fs, "stat");
  const resolved = await collect();
  const resolution = read.mock.calls.filter(([path]) => path === source).length;
  const stats = stat.mock.calls.filter(([path]) => path === source).length;
  read.mockClear();
  for (const [id, blob] of resolved.blobs) await readBlob(id, blob);
  const upload = read.mock.calls.filter(([path]) => path === source).length;
  expect({ resolution, upload, bytes: (resolution + upload) * image.length, stats }).toEqual({
    resolution: 1,
    upload: 1,
    bytes: 2 * image.length,
    stats: 1,
  });
  expect(resolved.request.files.filter((file) => file.role === "asset")).toHaveLength(1);
  expect(
    resolved.request.files.filter((file) => file.role === "doc").every((file) => file.assets?.[0] === "logo.png"),
  ).toBe(true);
});

test("distinct asset paths with equal bytes each read once but upload one blob", async () => {
  const f = await fixture();
  const sources = await Promise.all([
    f.file("bundle/a.png", "synthetic image"),
    f.file("bundle/b.png", "synthetic image"),
  ]);
  for (let i = 0; i < 8; i++) await f.file(`bundle/doc-${i}.html`, '<img src="a.png"><img src="b.png">');
  const collect = await f.prepare(["bundle"]);
  const read = vi.spyOn(reads, "readRegular");
  const resolved = await collect();
  const counts = () => sources.map((source) => read.mock.calls.filter(([path]) => path === source).length);
  const resolution = counts();
  read.mockClear();
  const uploaded = [];
  for (const [id, blob] of resolved.blobs) uploaded.push((await readBlob(id, blob)).toString());
  expect({ resolution, upload: counts() }).toEqual({ resolution: [1, 1], upload: [1, 1] });
  expect(uploaded.filter((bytes) => bytes === "synthetic image")).toHaveLength(1);
});

test.each([false, true])("different walked boundaries remain merged (inner first: %s)", async (innerFirst) => {
  const f = await fixture();
  await f.file("outer/a.html", '<img src="inner/logo.png">');
  await f.file("outer/inner/b.html", '<img src="logo.png">');
  const source = await f.file("outer/inner/logo.png", "synthetic image");
  const target = await f.file("outer/other.png", "synthetic image");
  const collect = await f.prepare(innerFirst ? ["outer/inner", "outer"] : ["outer", "outer/inner"]);
  const resolved = await collect();
  await fs.rm(source);
  await fs.symlink(target, source);
  const blob = resolved.blobs.get(hash("synthetic image"));
  if (!blob) throw new Error("missing shared image");
  await expect(readBlob(hash("synthetic image"), blob)).rejects.toThrow(
    "symlink leaves the published folder: outer/inner",
  );
  await expect(collect()).rejects.toThrow("symlink leaves the published folder: outer/inner");
});

// Resolving the cap-sized HTML reference lists exercises the publish JSON budget.
test("reference budget refuses a tree before any asset read", async () => {
  const f = await fixture();
  const names = Array.from({ length: 600 }, (_, i) => `asset-${i}-${"x".repeat(200)}.png`);
  await Promise.all(names.map((name) => f.file(`bundle/${name}`, "synthetic")));
  const html = names.map((name) => `<img src="${name}">`).join("");
  const referenceBytes = Buffer.byteLength(JSON.stringify(names));
  const docs = Math.ceil(LIMITS.publishJsonBytes / referenceBytes) + 1;
  await Promise.all(Array.from({ length: docs }, (_, i) => f.file(`bundle/doc-${i}.html`, html)));
  const collect = await f.prepare(["bundle"]);
  const original = reads.readRegular;
  let assetReads = 0;
  vi.spyOn(reads, "readRegular").mockImplementation(async (...args) => {
    if (args[0].endsWith(".png")) {
      assetReads++;
      throw new Error("unexpected asset read before reference budget check");
    }
    return original(...args);
  });
  const result = await collect().then(
    () => "published",
    (error: Error) => error.message,
  );
  expect({ result, assetReads }).toEqual({ result: "publish request exceeds its size limit", assetReads: 0 });
}, 30000);

test("manifest shared-asset request, blob bytes and read counts match HEAD", async () => {
  const f = await fixture();
  const html = '<title>Synthetic</title><img src="logo.png">';
  const one = await f.file("one.html", html);
  const two = await f.file("two.html", html);
  const image = await f.file("logo.png", "synthetic image");
  const input: PublishManifest = {
    version: 1,
    title: "Synthetic",
    topics: [],
    files: [
      { path: "one.html", role: "doc" },
      { path: "two.html", role: "doc" },
    ],
    writeup: { overview: "", tldr: "", decisions: null, topics: {} },
  };
  const read = vi.spyOn(reads, "readRegular");
  const result = await resolvePublish(
    input,
    { manifest: "synthetic", key: "plan" },
    f.stateDir,
    "instance",
    f.source,
    () => {},
  );
  const counts = () => [one, two, image].map((source) => read.mock.calls.filter(([path]) => path === source).length);
  const resolution = counts();
  read.mockClear();
  const bytes = [];
  for (const [id, blob] of result.blobs) bytes.push((await readBlob(id, blob)).toString());
  const upload = counts();
  expect({ resolution, upload, bytes }).toEqual({
    resolution: [1, 1, 1],
    upload: [1, 0, 1],
    bytes: [html, "synthetic image"],
  });
  expect(JSON.parse(JSON.stringify(result.request))).toEqual({
    reviewKey: "d9b1d7c2b10b81d49993713257c61b70368ee24f37e5560e364b46fe12e0de0a",
    repo: null,
    branch: null,
    title: "Synthetic",
    base: null,
    head: null,
    topics: [],
    writeup: input.writeup,
    files: [
      {
        path: "one.html",
        oldPath: null,
        role: "doc",
        oldBlob: null,
        newBlob: hash(html),
        flag: null,
        assets: ["logo.png"],
      },
      {
        path: "logo.png",
        oldPath: null,
        role: "asset",
        parent: "one.html",
        oldBlob: null,
        newBlob: hash("synthetic image"),
        flag: null,
      },
      {
        path: "two.html",
        oldPath: null,
        role: "doc",
        oldBlob: null,
        newBlob: hash(html),
        flag: null,
        assets: ["logo.png"],
      },
    ],
  });
});

test.each([false, true])("growing assets respect every doc budget during reads (shared: %s)", async (shared) => {
  const f = await fixture();
  const names = Array.from({ length: shared ? 3 : 64 }, (_, i) => `image-${i}.png`);
  const sources = await Promise.all(names.map((name) => f.file(name, "x")));
  await f.file(
    "a.html",
    names
      .slice(0, shared ? 1 : names.length)
      .map((name) => `<img src="${name}">`)
      .join(""),
  );
  if (shared) await f.file("b.html", names.map((name) => `<img src="${name}">`).join(""));
  const collect = await f.prepare(shared ? ["a.html", "b.html"] : ["a.html"]);
  const original = reads.readRegular;
  let grown = false;
  let bytesRead = 0;
  let completedReads = 0;
  const probe = vi.spyOn(reads, "readRegular").mockImplementation(async (...args) => {
    const asset = sources.includes(args[0]);
    if (asset && !grown) {
      grown = true;
      await Promise.all(sources.map((source) => fs.truncate(source, LIMITS.assetBytes)));
    }
    const bytes = await original(...args);
    if (asset) {
      bytesRead += bytes.length;
      completedReads++;
      // Measure the bytes without retaining large returned buffers in the spy.
      probe.mockClear();
    }
    return bytes;
  });
  const result = await collect().then(
    () => "published",
    (error: Error) => error.message,
  );
  expect({ result, bytesRead, completedReads }).toEqual({
    result: "HTML doc and assets exceed their size limit",
    bytesRead: 2 * LIMITS.assetBytes,
    completedReads: 2,
  });
});

test.each([false, true])(
  "a shared asset outside one doc boundary is skipped for both (inner first: %s)",
  async (innerFirst) => {
    const f = await fixture();
    await f.file("a.html", '<img src="inner/logo.png">');
    await f.file("inner/b.html", '<img src="logo.png">');
    const target = await f.file("outer.png", "synthetic image");
    await fs.symlink(target, join(f.source, "inner/logo.png"));
    const collect = await f.prepare(innerFirst ? ["inner/b.html", "a.html"] : ["a.html", "inner/b.html"]);
    const read = vi.spyOn(reads, "readRegular");
    const result = await collect();
    expect(result.request.files.map((file) => [file.path, file.assets])).toEqual([
      ["a.html", []],
      ["inner/b.html", []],
    ]);
    expect(result.blobs.has(hash("synthetic image"))).toBe(false);
    expect(read.mock.calls.some(([path]) => path === target)).toBe(false);
  },
);
