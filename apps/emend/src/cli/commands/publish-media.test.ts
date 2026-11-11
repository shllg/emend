import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { LIMITS, PublishRequest } from "@emend/contract";
import { expect, onTestFinished, test, vi } from "vitest";
import { run } from "../../main.ts";
import { resolvePublish } from "../publish/resolve.ts";
import { readBlob } from "../publish/upload.ts";
import { commandFixture } from "../test-support.ts";

// A synthetic 1x1 PNG header; the CLI hashes and uploads bytes without decoding them.
const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");
const mediaError = "emend: media source must end in .png, .jpg, .jpeg, .gif, .webp or .avif, like its path.\n";

async function fixture() {
  const f = await commandFixture();
  const root = await mkdtemp(join(tmpdir(), "emend-media-repo-"));
  const outside = await mkdtemp(join(tmpdir(), "emend-media-outside-"));
  onTestFinished(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  await promisify(execFile)("git", ["-c", "init.templateDir=", "init", root], {
    env: { PATH: process.env.PATH, HOME: root, LC_ALL: "C", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  await writeFile(join(f.dir, "instance.json"), JSON.stringify({ id: randomUUID() }));
  vi.spyOn(process, "cwd").mockReturnValue(root);
  const uploaded: string[] = [];
  const published: PublishRequest[] = [];
  const reviewId = randomUUID();
  f.setResponse(async (url, init) => {
    if (init?.method === "HEAD") return new Response(null, { status: 404 });
    if (init?.method === "PUT") {
      uploaded.push(String(url));
      return new Response(null, { status: 204 });
    }
    published.push(PublishRequest.parse(JSON.parse(String(init?.body))));
    return Response.json({
      reviewId,
      revision: 1,
      placed: 0,
      unplaced: 0,
      unrendered: [],
      url: `http://127.0.0.1:3636/r/${reviewId}`,
    });
  });
  const manifestPath = join(f.dir, "review.json");
  return {
    ...f,
    root,
    outside,
    uploaded,
    published,
    publish: async (extra: Record<string, unknown>) => {
      await writeFile(
        manifestPath,
        JSON.stringify({
          version: 1,
          title: "Synthetic review",
          topics: [],
          files: [],
          writeup: { overview: "![Before](media/before.png)", tldr: "", decisions: null, topics: {} },
          ...extra,
        }),
      );
      return run(["publish", "--manifest", manifestPath, "--key", "synthetic"], f.io);
    },
  };
}
async function refused(f: Awaited<ReturnType<typeof fixture>>, extra: Record<string, unknown>, stderr: string) {
  f.stderr.length = 0;
  expect(await f.publish(extra)).toBe(1);
  expect(f.stdout).toEqual([]);
  expect(f.stderr).toEqual([stderr]);
  expect(f.uploaded).toEqual([]);
  expect(f.published).toEqual([]);
}

test("publishes media as parentless assets read from the worktree and from a source", async () => {
  const f = await fixture();
  await mkdir(join(f.root, "media"));
  await writeFile(join(f.root, "media", "before.png"), png);
  await mkdir(join(f.root, ".shots"));
  await writeFile(join(f.root, ".shots", "after.png"), Buffer.concat([png, Buffer.from("x")]));
  // The upper-case path extension differs in case only from its source, which is allowed.
  expect(
    await f.publish({
      media: [{ path: "media/before.png" }, { path: "media/after.PNG", source: ".shots/after.png" }],
    }),
  ).toBe(0);
  expect(f.stdout).toHaveLength(1);
  const request = f.published[0];
  expect(request?.files).toEqual([
    expect.objectContaining({ path: "media/before.png", role: "asset", oldBlob: null, flag: null }),
    expect.objectContaining({ path: "media/after.PNG", role: "asset", oldBlob: null, flag: null }),
  ]);
  for (const file of request?.files ?? []) {
    expect(file).not.toHaveProperty("parent");
    expect(file).not.toHaveProperty("topic");
    expect(file.newBlob).toMatch(/^[0-9a-f]{64}$/);
  }
  expect(f.uploaded).toHaveLength(2);
});

test("a symlink inside the worktree that escapes it is refused", async () => {
  const f = await fixture();
  await writeFile(join(f.outside, "secret.png"), png);
  await mkdir(join(f.root, "media"));
  await symlink(join(f.outside, "secret.png"), join(f.root, "media", "before.png"));
  expect(await f.publish({ media: [{ path: "media/before.png" }] })).toBe(1);
  expect(f.stdout).toEqual([]);
  expect(f.stderr).toHaveLength(1);
  expect(f.uploaded).toEqual([]);
});

test("a source outside the worktree and the doc roots is refused", async () => {
  const f = await fixture();
  await writeFile(join(f.outside, "shot.png"), png);
  expect(await f.publish({ media: [{ path: "media/before.png", source: join(f.outside, "shot.png") }] })).toBe(1);
  expect(f.stdout).toEqual([]);
  expect(f.stderr).toEqual(["emend: source is outside the allowed doc roots\n"]);
  expect(f.uploaded).toEqual([]);
});

test("a missing source names the source", async () => {
  const f = await fixture();
  await refused(f, { media: [{ path: "media/before.png" }] }, "emend: media not found: media/before.png\n");
  await refused(
    f,
    { media: [{ path: "media/before.png", source: "shots/gone.png" }] },
    "emend: media not found: shots/gone.png\n",
  );
});

test("an image at the asset byte limit publishes", async () => {
  const f = await fixture();
  await mkdir(join(f.root, "media"));
  await writeFile(join(f.root, "media", "before.png"), png);
  await truncate(join(f.root, "media", "before.png"), LIMITS.assetBytes);
  expect(await f.publish({ media: [{ path: "media/before.png" }] })).toBe(0);
  expect(f.stderr).toEqual([expect.stringMatching(/^emend: published revision 1:/)]);
  expect(f.uploaded).toHaveLength(1);
  expect(f.published[0]?.files).toEqual([expect.objectContaining({ path: "media/before.png", role: "asset" })]);
});

test("an oversized file is refused", async () => {
  const f = await fixture();
  await mkdir(join(f.root, "media"));
  await writeFile(join(f.root, "media", "before.png"), png);
  await truncate(join(f.root, "media", "before.png"), LIMITS.assetBytes + 1);
  await refused(f, { media: [{ path: "media/before.png" }] }, "emend: media exceeds its size limit\n");
});

test("an extension mismatch is refused", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "shot.jpg"), png);
  await writeFile(join(f.root, "shot.svg"), "<svg/>");
  await writeFile(join(f.root, "shot.png"), png);
  await symlink(join(f.root, "shot.svg"), join(f.root, "alias.png"));
  await refused(f, { media: [{ path: "media/before.png", source: "shot.jpg" }] }, mediaError);
  await refused(f, { media: [{ path: "media/before.png", source: "shot.svg" }] }, mediaError);
  // A name that looks like a PNG but resolves to an SVG is judged by the real file.
  await refused(f, { media: [{ path: "media/before.png", source: "alias.png" }] }, mediaError);
});

test("a hidden path, an svg path and a duplicate path fail manifest validation with one line", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "shot.png"), png);
  for (const media of [
    [{ path: "media/.before.png", source: "shot.png" }],
    [{ path: "media/before.svg", source: "shot.png" }],
    [
      { path: "media/before.png", source: "shot.png" },
      { path: "media/before.png", source: "shot.png" },
    ],
  ]) {
    f.stderr.length = 0;
    expect(await f.publish({ media })).toBe(1);
    expect(f.stdout).toEqual([]);
    expect(f.stderr).toHaveLength(1);
    expect(f.stderr[0]).toMatch(/^emend: .*\n$/);
    expect(f.uploaded).toEqual([]);
  }
});

test("media that collides with an HTML doc's asset is refused", async () => {
  const f = await fixture();
  await mkdir(join(f.root, "docs"));
  await writeFile(join(f.root, "docs", "plan.html"), '<img src="a.png">');
  await writeFile(join(f.root, "docs", "a.png"), png);
  await refused(
    f,
    {
      files: [{ path: "docs/plan.html", role: "doc" }],
      media: [{ path: "docs/a.png" }],
    },
    "emend: media path is already a doc asset: docs/a.png\n",
  );
});

test("media that collides with a doc path is refused", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "a.png"), png);
  await writeFile(join(f.root, "plan.md"), "# Plan");
  expect(
    await f.publish({ files: [{ path: "a.png", role: "doc", source: "plan.md" }], media: [{ path: "a.png" }] }),
  ).toBe(1);
  expect(f.stdout).toEqual([]);
  expect(f.stderr).toHaveLength(1);
});

test.each([".git/shot.png", "link/shot.png", "leaf.png"])(
  "media source %j cannot expose Git metadata",
  async (source) => {
    const f = await fixture();
    await writeFile(join(f.root, ".git", "shot.png"), png);
    await symlink(".git", join(f.root, "link"));
    await symlink(".git/shot.png", join(f.root, "leaf.png"));
    f.stderr.length = 0;
    expect(await f.publish({ media: [{ path: "media/before.png", source }] })).toBe(1);
    expect(f.stdout).toEqual([]);
    expect(f.stderr).toHaveLength(1);
    expect(f.stderr[0]).toMatch(/^emend: refusing to read inside the git folder: /);
    expect(f.uploaded).toEqual([]);
  },
);

async function resolved(f: Awaited<ReturnType<typeof fixture>>, source: string) {
  return resolvePublish(
    {
      version: 1,
      title: "Synthetic",
      topics: [],
      files: [],
      media: [{ path: "media/before.png", source }],
      writeup: { overview: "", tldr: "", decisions: null, topics: {} },
    },
    { manifest: "synthetic", key: "docs" },
    f.dir,
    f.configDir,
    "instance",
    f.root,
    () => {},
  );
}

test("a media source swapped for different bytes before upload is refused", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "shot.png"), png);
  const result = await resolved(f, "shot.png");
  const [hash, source] = [...result.blobs.entries()][0] ?? [];
  if (!hash || !source) throw new Error("Missing media blob");
  await writeFile(join(f.root, "shot.png"), Buffer.concat([png, Buffer.from("changed")]));
  await expect(readBlob(hash, source)).rejects.toThrow("blob changed before upload");
});

test("a media source swapped for a Git metadata symlink before upload is refused", async () => {
  const f = await fixture();
  await writeFile(join(f.root, ".git", "shot.png"), png);
  await writeFile(join(f.root, "shot.png"), png);
  const result = await resolved(f, "shot.png");
  const [hash, source] = [...result.blobs.entries()][0] ?? [];
  if (!hash || !source) throw new Error("Missing media blob");
  await rm(join(f.root, "shot.png"));
  await symlink(".git/shot.png", join(f.root, "shot.png"));
  await expect(readBlob(hash, source)).rejects.toThrow("refusing to read inside the git folder:");
});

test("a media source swapped for a symlink to other bytes before upload is refused", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "shot.png"), png);
  await writeFile(join(f.root, "other.png"), Buffer.concat([png, Buffer.from("other")]));
  const result = await resolved(f, "shot.png");
  const [hash, source] = [...result.blobs.entries()][0] ?? [];
  if (!hash || !source) throw new Error("Missing media blob");
  await rm(join(f.root, "shot.png"));
  await symlink("other.png", join(f.root, "shot.png"));
  await expect(readBlob(hash, source)).rejects.toThrow("blob changed before upload");
});
