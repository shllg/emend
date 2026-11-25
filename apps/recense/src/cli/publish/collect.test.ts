import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { LIMITS, type PublishManifest } from "@recense/contract";
import { expect, test, vi } from "vitest";
import { collectChanges } from "./collect.ts";
import { type PublishOptions, publishContext, resolvePublish } from "./resolve.ts";
import { readSides } from "./sides.ts";

const exec = promisify(execFile);
test("a configured external worktree cannot grant access to a docs-only source", async () => {
  const f = await repo();
  const outside = await mkdtemp(join(tmpdir(), "recense-external-worktree-"));
  try {
    await mkdir(join(outside, "synthetic-private"));
    const source = join(outside, "synthetic-private/key.txt");
    await writeFile(source, "synthetic private content");
    await f.run("config", "core.worktree", outside);
    await expect(
      resolvePublish(
        {
          version: 1,
          title: "Synthetic",
          topics: [],
          files: [{ path: "plan.md", role: "doc", source }],
          writeup: { overview: "", tldr: "", decisions: null, topics: {} },
        },
        { manifest: "synthetic", key: "p" },
        f.state,
        f.configDir,
        "instance",
        f.root,
        () => {},
      ),
    ).rejects.toThrow("the repository's worktree is configured elsewhere");
  } finally {
    await f.cleanup();
    await rm(outside, { recursive: true, force: true });
  }
});
async function repo(format = "sha1") {
  const dir = await mkdtemp(join(tmpdir(), "recense-git-"));
  const root = join(dir, "repo");
  const run = (...args: string[]) =>
    exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        LC_ALL: "C",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
  try {
    await mkdir(root);
    await run("init", `--object-format=${format}`, "-b", "main");
    await run("config", "user.name", "Synthetic");
    await run("config", "user.email", "synthetic@example.test");
    return {
      root,
      state: join(dir, "state"),
      configDir: join(dir, "config", "recense"),
      run,
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

const imageWriteup = { overview: "", tldr: "", decisions: null, topics: {} };

async function resolveImages(
  f: Awaited<ReturnType<typeof repo>>,
  base: string,
  {
    head = "worktree",
    context,
    docFolders,
    media,
  }: {
    head?: string;
    context?: Awaited<ReturnType<typeof publishContext>>;
    docFolders?: PublishOptions["docFolders"];
    media?: PublishManifest["media"];
  } = {},
) {
  return resolvePublish(
    {
      version: 1,
      title: "Images",
      base,
      head,
      files: [],
      topics: [],
      writeup: imageWriteup,
      media,
    },
    { manifest: "synthetic", docFolders },
    f.state,
    f.configDir,
    "instance",
    f.root,
    () => {},
    context,
  );
}

const png = (value: number) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, value]);
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
test("a committed image object is read once across paths, extensions and the SVG text view", async () => {
  const f = await repo();
  try {
    await f.run("commit", "--allow-empty", "-m", "synthetic base");
    const base = (await f.run("rev-parse", "HEAD")).stdout.trim();
    const svg = "<svg><title>shared</title></svg>";
    await writeFile(join(f.root, "a.jpg"), png(1));
    for (let i = 0; i < 12; i++) {
      await writeFile(join(f.root, `copy-${i}.png`), png(1));
      await writeFile(join(f.root, `copy-${i}.svg`), svg);
    }
    await f.run("add", ".");
    await f.run("commit", "-m", "synthetic images");
    const head = (await f.run("rev-parse", "HEAD")).stdout.trim();
    const context = await publishContext(f.root, f.state);
    const git = vi.fn(context.git);
    const { request, blobs } = await resolveImages(f, base, {
      head,
      context: { ...context, git },
      docFolders: new Map(),
    });
    const reads = () => git.mock.calls.filter(([, call]) => call[0] === "cat-file" && call[1] === "blob");
    expect(reads()).toHaveLength(2);
    expect(request.files).toHaveLength(25);
    for (const file of request.files) {
      if (file.path.endsWith(".jpg")) expect(file.image).toBeUndefined();
      else if (file.path.endsWith(".png")) expect(file.image?.new).toEqual({ blob: digest(png(1)) });
      else {
        expect(file.newBlob).toBe(digest(svg));
        expect(file.image?.new).toEqual({ blob: file.newBlob });
      }
    }
    for (const blob of blobs.values()) await blob.read();
    expect(reads()).toHaveLength(4);
  } finally {
    await f.cleanup();
  }
});

test("resolves image sides independently of the text flags and rechecks worktree images at upload", async () => {
  const f = await repo();
  try {
    const write = (path: string, bytes: Buffer | string) => writeFile(join(f.root, path), bytes);
    const oldSvg = "<svg><title>before</title></svg>",
      newSvg = "<svg><title>after</title></svg>";
    const removed = Buffer.alloc(9 * 1024 * 1024);
    png(3).copy(removed);
    await write("modified.png", png(1));
    await write("deleted.png", removed);
    await write("icon.svg", oldSvg);
    await f.run("add", ".");
    await f.run("commit", "-m", "synthetic images");
    const base = (await f.run("rev-parse", "HEAD")).stdout.trim();
    await rm(join(f.root, "deleted.png"));
    await write("modified.png", png(2));
    await write("added.png", png(4));
    await write("icon.svg", newSvg);
    const large = Buffer.alloc(5 * 1024 * 1024);
    png(5).copy(large);
    await write("large.png", large);
    await write("huge.png", png(6));
    await truncate(join(f.root, "huge.png"), LIMITS.assetBytes + 1);
    await write("font.woff2", png(7));
    await write("invalid.png", Buffer.from([1, 0, 2]));
    await symlink("added.png", join(f.root, "link.png"));
    const { request, blobs } = await resolveImages(f, base);
    const file = (path: string) => request.files.find((row) => row.path === path);
    expect(file("modified.png")).toMatchObject({
      flag: "binary",
      oldBlob: null,
      newBlob: null,
      image: { old: { blob: digest(png(1)) }, new: { blob: digest(png(2)) } },
    });
    expect(file("added.png")?.image).toEqual({ old: null, new: { blob: digest(png(4)) } });
    expect(file("deleted.png")?.image).toEqual({ old: { blob: digest(removed) }, new: null });
    expect(file("icon.svg")).toMatchObject({
      flag: null,
      oldBlob: digest(oldSvg),
      newBlob: digest(newSvg),
      image: { old: { blob: digest(oldSvg) }, new: { blob: digest(newSvg) } },
    });
    expect(file("huge.png")).toMatchObject({ flag: "oversized", image: { old: null, new: { flag: "oversized" } } });
    expect(file("large.png")).toMatchObject({ flag: "oversized", image: { old: null, new: { blob: digest(large) } } });
    expect(digest((await blobs.get(digest(large))?.read()) ?? "")).toBe(digest(large));
    for (const path of ["invalid.png", "link.png", "font.woff2"]) {
      expect(file(path)).toBeDefined();
      expect(file(path)).not.toHaveProperty("image");
    }
    await write("added.png", Buffer.from("not an image"));
    await expect(blobs.get(digest(png(4)))?.read()).rejects.toThrow("image changed before upload");
  } finally {
    await f.cleanup();
  }
});

test("a second image side over the revision budget rolls back just that file's image bytes", async () => {
  const f = await repo();
  const limit = LIMITS.revisionBytes;
  try {
    await writeFile(join(f.root, "b.png"), png(1));
    await writeFile(join(f.root, "z.png"), png(1));
    await f.run("add", ".");
    await f.run("commit", "-m", "synthetic base");
    const base = (await f.run("rev-parse", "HEAD")).stdout.trim();
    await writeFile(join(f.root, "b.png"), png(2));
    await writeFile(join(f.root, "note.txt"), "text");
    const writeupSize = Buffer.byteLength(JSON.stringify(imageWriteup));
    Object.assign(LIMITS, { revisionBytes: writeupSize + png(1).length + 4 });
    const { request, blobs } = await resolveImages(f, base);
    expect(request.files.find((file) => file.path === "b.png")).toMatchObject({
      flag: "binary",
      oldBlob: null,
      newBlob: null,
    });
    expect(request.files.find((file) => file.path === "b.png")).not.toHaveProperty("image");
    expect([...blobs.keys()]).toEqual([digest("text")]);
    // The later deletion needs the same old object that did not fit as part of the pair.
    await rm(join(f.root, "z.png"));
    const retry = await resolveImages(f, base);
    expect(retry.request.files.find((file) => file.path === "b.png")).not.toHaveProperty("image");
    expect(retry.request.files.find((file) => file.path === "z.png")?.image).toEqual({
      old: { blob: digest(png(1)) },
      new: null,
    });
    expect(new Set(retry.blobs.keys())).toEqual(new Set([digest("text"), digest(png(1))]));
  } finally {
    Object.assign(LIMITS, { revisionBytes: limit });
    await f.cleanup();
  }
});

test("later text and required writeup media get the revision budget before diff pictures", async () => {
  const f = await repo();
  const limit = LIMITS.revisionBytes;
  try {
    const medium = png(3);
    const note = "later text";
    await writeFile(join(f.root, "cover.png"), medium);
    await f.run("add", ".");
    await f.run("commit", "-m", "synthetic cover");
    const base = (await f.run("rev-parse", "HEAD")).stdout.trim();
    await writeFile(join(f.root, "a.png"), png(1));
    await writeFile(join(f.root, "b.png"), png(2));
    await writeFile(join(f.root, "copy.png"), medium);
    await writeFile(join(f.root, "z.txt"), note);
    Object.assign(LIMITS, {
      revisionBytes: Buffer.byteLength(JSON.stringify(imageWriteup)) + medium.length + Buffer.byteLength(note),
    });
    const { request, blobs } = await resolveImages(f, base, { media: [{ path: "cover.png" }], docFolders: new Map() });
    for (const path of ["a.png", "b.png"]) {
      const file = request.files.find((entry) => entry.path === path);
      expect(file).toMatchObject({ flag: "binary", oldBlob: null, newBlob: null });
      expect(file).not.toHaveProperty("image");
    }
    expect(request.files).toContainEqual(expect.objectContaining({ path: "z.txt", flag: null, newBlob: digest(note) }));
    expect(request.files).toContainEqual(
      expect.objectContaining({ path: "cover.png", role: "asset", newBlob: digest(medium) }),
    );
    expect(request.files.find((entry) => entry.path === "copy.png")?.image).toEqual({
      old: null,
      new: { blob: digest(medium) },
    });
    expect(new Set(blobs.keys())).toEqual(new Set([digest(note), digest(medium)]));
    await writeFile(join(f.root, "copy.png"), "changed");
    await expect(blobs.get(digest(medium))?.read()).rejects.toThrow("image changed before upload");
  } finally {
    Object.assign(LIMITS, { revisionBytes: limit });
    await f.cleanup();
  }
});

test("SHA-256 repositories collect a committed range using the matching empty tree", async () => {
  const f = await repo("sha256");
  try {
    await writeFile(join(f.root, "file.txt"), "before\n");
    await f.run("add", ".");
    await f.run("commit", "-m", "synthetic base");
    const base = (await f.run("rev-parse", "HEAD")).stdout.trim();
    await writeFile(join(f.root, "file.txt"), "after\n");
    await f.run("add", ".");
    await f.run("commit", "-m", "synthetic head");
    const head = (await f.run("rev-parse", "HEAD")).stdout.trim();
    expect(base).toHaveLength(64);
    const changes = await collectChanges(f.root, base, head);
    const change = changes[0];
    if (!change) throw new Error("missing change");
    expect(await readSides(f.root, base, head, change)).toEqual({
      old: { bytes: Buffer.from("before\n") },
      new: { bytes: Buffer.from("after\n") },
    });
  } finally {
    await f.cleanup();
  }
});
test("records renames, added, deleted and mode-changed files, unstaged and untracked but not ignored", async () => {
  const f = await repo();
  try {
    for (const name of ["old.txt", "delete.txt", "mode.txt", "edit.txt"])
      await writeFile(join(f.root, name), `${name}\n`);
    await writeFile(join(f.root, ".gitignore"), "ignored.txt\n");
    await f.run("add", ".");
    await f.run("commit", "-m", "synthetic base");
    const base = (await f.run("rev-parse", "HEAD")).stdout.trim();
    await rename(join(f.root, "old.txt"), join(f.root, "renamed.txt"));
    await f.run("add", "old.txt", "renamed.txt");
    await rm(join(f.root, "delete.txt"));
    await chmod(join(f.root, "mode.txt"), 0o755);
    await writeFile(join(f.root, "edit.txt"), "unstaged\n");
    await writeFile(join(f.root, "untracked.txt"), "new\n");
    await writeFile(join(f.root, "ignored.txt"), "ignored\n");
    const changes = await collectChanges(f.root, base, "worktree");
    expect(changes.map(({ path, oldPath, status }) => ({ path, oldPath, status }))).toEqual(
      expect.arrayContaining([
        { path: "renamed.txt", oldPath: "old.txt", status: "renamed" },
        { path: "delete.txt", oldPath: null, status: "deleted" },
        { path: "mode.txt", oldPath: null, status: "mode-changed" },
        { path: "edit.txt", oldPath: null, status: "modified" },
        { path: "untracked.txt", oldPath: null, status: "added" },
      ]),
    );
    expect(changes).toHaveLength(5);
    const renamed = changes.find((c) => c.status === "renamed");
    if (!renamed) throw new Error("missing rename");
    expect(await readSides(f.root, base, "worktree", renamed)).toEqual({
      old: { bytes: Buffer.from("old.txt\n") },
      new: { bytes: Buffer.from("old.txt\n") },
    });
  } finally {
    await f.cleanup();
  }
});
test("runs no fsmonitor, textconv or clean filter program and collects raw bytes", async () => {
  const f = await repo();
  try {
    await writeFile(join(f.root, "raw.txt"), "before\n");
    await writeFile(join(f.root, ".gitattributes"), "*.txt diff=hostile filter=hostile\n");
    await writeFile(join(f.root, ".gitignore"), "*.sh\n*-marker\n");
    await f.run("add", ".");
    await f.run("commit", "-m", "synthetic drivers");
    const base = (await f.run("rev-parse", "HEAD")).stdout.trim();
    await writeFile(join(f.root, "driver.sh"), '#!/bin/sh\nprintf executed > "$1"\ncat\n');
    await chmod(join(f.root, "driver.sh"), 0o755);
    await f.run("config", "core.fsmonitor", "./driver.sh fsmonitor-marker");
    await f.run("config", "diff.hostile.textconv", "./driver.sh textconv-marker");
    await f.run("config", "filter.hostile.clean", "./driver.sh clean-marker");
    await writeFile(join(f.root, "raw.txt"), "raw after\n");
    const manifest: PublishManifest = {
      version: 1,
      title: "Synthetic",
      base,
      head: "worktree",
      topics: [],
      files: [],
      writeup: { overview: "", tldr: "", decisions: null, topics: {} },
    };
    const result = await resolvePublish(
      manifest,
      { manifest: "synthetic.json" },
      f.state,
      f.configDir,
      "synthetic-instance",
      f.root,
      () => {},
    );
    const file = result.request.files.find((f) => f.path === "raw.txt");
    expect((await result.blobs.get(file?.newBlob ?? "")?.read())?.toString()).toBe("raw after\n");
    expect(file?.topic).toBe("other");
    for (const name of ["fsmonitor-marker", "textconv-marker", "clean-marker"])
      await expect(access(join(f.root, name))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await f.cleanup();
  }
});
test.each(["newline", "invalid UTF-8"])("refuses a %s git path with an escaped one-line name", async (kind) => {
  const f = await repo();
  try {
    await writeFile(join(f.root, "base.txt"), "base");
    await f.run("add", ".");
    await f.run("commit", "-m", "synthetic base");
    const base = (await f.run("rev-parse", "HEAD")).stdout.trim();
    const path =
      kind === "newline"
        ? Buffer.from(`${f.root}/line\nbreak.txt`)
        : Buffer.concat([Buffer.from(`${f.root}/bad-`), Buffer.from([255])]);
    await writeFile(path, "invalid path");
    try {
      await collectChanges(f.root, base, "worktree");
      throw new Error("accepted invalid path");
    } catch (error) {
      expect((error as Error).message).toContain("invalid path:");
      expect((error as Error).message).not.toContain("\n");
      expect((error as Error).message).toContain(kind === "newline" ? "\\u{a}" : "\\xff");
    }
  } finally {
    await f.cleanup();
  }
});
test("flags binary and oversized sides, reading symlinks as link text", async () => {
  const f = await repo();
  try {
    await writeFile(join(f.root, "base.txt"), "base");
    await f.run("add", ".");
    await f.run("commit", "-m", "synthetic base");
    const base = (await f.run("rev-parse", "HEAD")).stdout.trim();
    await writeFile(join(f.root, "binary.bin"), Buffer.from([1, 0, 2]));
    await writeFile(join(f.root, "big.txt"), Buffer.alloc(LIMITS.diffSideBytes + 1));
    await symlink("missing.txt", join(f.root, "link.txt"));
    const read = (path: string) => readSides(f.root, base, "worktree", { path, oldPath: null, status: "added" });
    expect(await read("binary.bin")).toEqual({ old: null, new: { flag: "binary" } });
    expect(await read("big.txt")).toEqual({ old: null, new: { flag: "oversized" } });
    expect(await read("link.txt")).toEqual({ old: null, new: { bytes: Buffer.from("missing.txt") } });
    const manifest: PublishManifest = {
      version: 1,
      title: "Synthetic",
      base,
      head: "worktree",
      files: [],
      topics: [],
      writeup: { overview: "", tldr: "", decisions: null, topics: {} },
    };
    const result = await resolvePublish(
      manifest,
      { manifest: "synthetic" },
      f.state,
      f.configDir,
      "instance",
      f.root,
      () => {},
    );
    expect(
      result.request.files.filter((file) => file.flag).every((file) => file.oldBlob === null && file.newBlob === null),
    ).toBe(true);
  } finally {
    await f.cleanup();
  }
});

test("same-branch worktrees share repo identity but have distinct review keys; detached HEAD requires a key", async () => {
  const f = await repo();
  const sibling = await mkdtemp(join(tmpdir(), "recense-worktree-"));
  try {
    await writeFile(join(f.root, "file.txt"), "base");
    await f.run("add", ".");
    await f.run("commit", "-m", "synthetic base");
    const base = (await f.run("rev-parse", "HEAD")).stdout.trim();
    await f.run("worktree", "add", "--force", sibling, "main");
    const manifest: PublishManifest = {
      version: 1,
      title: "Synthetic",
      base,
      head: "worktree",
      files: [],
      topics: [],
      writeup: { overview: "", tldr: "", decisions: null, topics: {} },
    };
    const collect = (cwd: string) =>
      resolvePublish(manifest, { manifest: "synthetic" }, f.state, f.configDir, "instance", cwd, () => {});
    const first = await collect(f.root);
    const second = await collect(sibling);
    expect(first.request.repo?.key).toBe(second.request.repo?.key);
    expect(first.request.reviewKey).not.toBe(second.request.reviewKey);
    expect((await collect(f.root)).request.reviewKey).toBe(first.request.reviewKey);
    await expect(
      resolvePublish(
        { ...manifest, files: [{ path: "file.txt", role: "diff" }] },
        { manifest: "synthetic" },
        f.state,
        f.configDir,
        "instance",
        f.root,
        () => {},
      ),
    ).rejects.toThrow(`not changed in ${base}..worktree: file.txt`);
    await f.run("checkout", "--detach");
    await expect(collect(f.root)).rejects.toThrow("pass --review or --key");
  } finally {
    await f.cleanup();
    await rm(sibling, { recursive: true, force: true });
  }
});

test("a BOM-prefixed untracked path cannot alias an ignored plain path", async () => {
  const f = await repo();
  try {
    await writeFile(join(f.root, ".gitignore"), "private.txt\n");
    await f.run("add", ".");
    await f.run("commit", "-m", "synthetic base");
    const base = (await f.run("rev-parse", "HEAD")).stdout.trim();
    await writeFile(join(f.root, "private.txt"), "ignored");
    await writeFile(join(f.root, "\ufeffprivate.txt"), "visible");
    await expect(collectChanges(f.root, base, "worktree")).rejects.toThrow("invalid path: \\u{feff}private.txt");
  } finally {
    await f.cleanup();
  }
});
