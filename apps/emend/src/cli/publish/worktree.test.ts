import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { LIMITS } from "@emend/contract";
import { expect, test, vi } from "vitest";
import { collectChanges } from "./collect.ts";
import { resolvePublish } from "./resolve.ts";
import { readSides, readWorktree } from "./sides.ts";
import * as worktree from "./worktree.ts";
import { hashWorktreeFile, statWorktree } from "./worktree.ts";

vi.mock("./worktree.ts", async (original) => ({ ...(await original<typeof import("./worktree.ts")>()) }));

const exec = promisify(execFile);
test("worktree stat and hashing refuse nested metadata before opening", async () => {
  const root = await mkdtemp(join(tmpdir(), "emend-worktree-metadata-"));
  try {
    const path = "vendor/lib/GIT~1. /config";
    const file = join(root, path);
    await mkdir(join(root, "vendor/lib/GIT~1. "), { recursive: true });
    await writeFile(file, "synthetic metadata");
    await expect(statWorktree(root, path)).rejects.toThrow(`refusing to read inside the git folder: ${file}`);
    const openFile = vi.fn(open);
    await expect(
      hashWorktreeFile(root, path, await lstat(file), "sha1", {
        open: openFile,
        realpath,
        stat,
        platform: process.platform,
      }),
    ).rejects.toThrow(`refusing to read inside the git folder: ${file}`);
    expect(openFile).not.toHaveBeenCalled();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a sparse 2 GiB untracked file is oversized without hashing or uploading it", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "huge.txt"), "");
    await truncate(join(f.root, "huge.txt"), 2 * 1024 ** 3);
    const hash = vi.spyOn(worktree, "hashWorktreeFile");
    const result = await resolvePublish(
      {
        version: 1,
        title: "Synthetic",
        base: f.base,
        head: "worktree",
        topics: [],
        files: [],
        writeup: { overview: "", tldr: "", decisions: null, topics: {} },
      },
      { manifest: "synthetic" },
      f.state,
      "instance",
      f.root,
      () => {},
    );
    expect(result.request.files).toMatchObject([{ path: "huge.txt", flag: "oversized", oldBlob: null, newBlob: null }]);
    expect(result.blobs.size).toBe(0);
    expect(hash.mock.calls.filter(([, path]) => path === "huge.txt")).toEqual([]);
  } finally {
    vi.restoreAllMocks();
    await f.cleanup();
  }
});
test("a later doc reserves bytes before 255 MiB of real collected diff sides", async () => {
  const f = await fixture();
  try {
    const bytes = Buffer.alloc(LIMITS.diffSideBytes, 120);
    for (let i = 0; i < 255; i++) {
      bytes.write(String(i).padStart(8, "0"));
      await writeFile(join(f.root, `file-${String(i).padStart(3, "0")}.txt`), bytes);
    }
    await writeFile(join(f.root, "plan.html"), `<p>Plan</p>${" ".repeat(2 * 1024 ** 2)}`);
    const result = await resolvePublish(
      {
        version: 1,
        title: "Synthetic",
        base: f.base,
        head: "worktree",
        topics: [],
        files: [
          { path: "file-000.txt", role: "diff" },
          { path: "plan.html", role: "doc" },
        ],
        writeup: { overview: "", tldr: "", decisions: null, topics: {} },
      },
      { manifest: "synthetic" },
      f.state,
      "instance",
      f.root,
      () => {},
    );
    expect(result.request.files[0]).toMatchObject({
      path: "plan.html",
      role: "doc",
      flag: null,
      newBlob: expect.any(String),
    });
    expect(
      result.request.files.filter(
        (file) => file.role === "diff" && file.path.startsWith("file-") && file.flag === "oversized",
      ),
    ).toHaveLength(2);
    expect([...result.blobs.values()].reduce((sum, blob) => sum + blob.size, 0)).toBeLessThan(LIMITS.revisionBytes);
  } finally {
    await f.cleanup();
  }
}, 15000);
async function fixture(format = "sha1", content = "base\n") {
  const dir = await mkdtemp(join(tmpdir(), "emend-worktree-listing-"));
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
    await writeFile(join(root, "file.txt"), content);
    await run("add", ".");
    await run("commit", "-m", "synthetic base");
    const base = (await run("rev-parse", "HEAD")).stdout.trim();
    return { root, state: join(dir, "state"), run, base, cleanup: () => rm(dir, { recursive: true, force: true }) };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

test("a staged-only edit reverted on disk is unchanged", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "file.txt"), "staged\n");
    await f.run("add", "file.txt");
    await writeFile(join(f.root, "file.txt"), "base\n");
    expect(await collectChanges(f.root, f.base, "worktree")).toEqual([]);
  } finally {
    await f.cleanup();
  }
});

test("an intent-to-add path uses its current disk bytes", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "intent.txt"), "intent\n");
    await f.run("add", "-N", "intent.txt");
    const changes = await collectChanges(f.root, f.base, "worktree");
    expect(changes).toMatchObject([{ path: "intent.txt", status: "added" }]);
    const change = changes[0];
    if (!change) throw new Error("missing change");
    expect((await readSides(f.root, f.base, "worktree", change)).new).toEqual({ bytes: Buffer.from("intent\n") });
  } finally {
    await f.cleanup();
  }
});

test("an unmerged path is listed once and uses the disk resolution", async () => {
  const f = await fixture();
  try {
    await f.run("checkout", "-b", "other");
    await writeFile(join(f.root, "file.txt"), "theirs\n");
    await f.run("commit", "-am", "synthetic theirs");
    await f.run("checkout", "main");
    await writeFile(join(f.root, "file.txt"), "ours\n");
    await f.run("commit", "-am", "synthetic ours");
    await expect(f.run("merge", "other")).rejects.toThrow();
    await writeFile(join(f.root, "file.txt"), "resolved\n");
    const index = await readFile(join(f.root, ".git/index"));
    const changes = await collectChanges(f.root, f.base, "worktree");
    expect(changes).toMatchObject([{ path: "file.txt", status: "modified" }]);
    const change = changes[0];
    if (!change) throw new Error("missing change");
    expect((await readSides(f.root, f.base, "worktree", change)).new).toEqual({ bytes: Buffer.from("resolved\n") });
    expect(await readFile(join(f.root, ".git/index"))).toEqual(index);
  } finally {
    await f.cleanup();
  }
});

test("an absent skip-worktree path uses its index blob, including staged changes", async () => {
  const f = await fixture();
  try {
    await f.run("update-index", "--skip-worktree", "file.txt");
    await rm(join(f.root, "file.txt"));
    expect(await collectChanges(f.root, f.base, "worktree")).toEqual([]);
    await f.run("update-index", "--no-skip-worktree", "file.txt");
    await writeFile(join(f.root, "file.txt"), "staged sparse\n");
    await f.run("add", "file.txt");
    await f.run("update-index", "--skip-worktree", "file.txt");
    await rm(join(f.root, "file.txt"));
    const changes = await collectChanges(f.root, f.base, "worktree");
    expect(changes).toMatchObject([{ path: "file.txt", status: "modified" }]);
    const change = changes[0];
    if (!change) throw new Error("missing change");
    expect((await readSides(f.root, f.base, "worktree", change)).new).toEqual({
      bytes: Buffer.from("staged sparse\n"),
    });
  } finally {
    await f.cleanup();
  }
});

test("core.fileMode=false uses the index exec bit; otherwise only the owner exec bit counts", async () => {
  const f = await fixture();
  try {
    await chmod(join(f.root, "file.txt"), 0o655);
    expect(await collectChanges(f.root, f.base, "worktree")).toEqual([]);
    await chmod(join(f.root, "file.txt"), 0o755);
    await f.run("config", "--unset", "core.filemode");
    expect(await collectChanges(f.root, f.base, "worktree")).toMatchObject([
      { path: "file.txt", status: "mode-changed" },
    ]);
    await f.run("config", "core.filemode", "false");
    expect(await collectChanges(f.root, f.base, "worktree")).toEqual([]);
    await f.run("update-index", "--chmod=+x", "file.txt");
    await chmod(join(f.root, "file.txt"), 0o644);
    expect(await collectChanges(f.root, f.base, "worktree")).toMatchObject([
      { path: "file.txt", status: "mode-changed", newMode: "100755" },
    ]);
  } finally {
    await f.cleanup();
  }
});

test("a base gitlink removed from the index is deleted even with its directory still present", async () => {
  const f = await fixture();
  try {
    await f.run("update-index", "--add", "--cacheinfo", `160000,${f.base},sub`);
    await f.run("commit", "-m", "synthetic gitlink");
    const base = (await f.run("rev-parse", "HEAD")).stdout.trim();
    await f.run("init", join(f.root, "sub"));
    await f.run("update-index", "--force-remove", "sub");
    const warnings: string[] = [];
    const changes = await collectChanges(f.root, base, "worktree", undefined, (line) => warnings.push(line));
    expect(changes).toMatchObject([{ path: "sub", status: "deleted", oldMode: "160000", oldOid: f.base }]);
    expect(warnings).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});

test("worktree comparison preserves raw CRLF bytes even with autocrlf enabled", async () => {
  const f = await fixture();
  try {
    await f.run("config", "core.autocrlf", "true");
    await writeFile(join(f.root, "file.txt"), "base\r\n");
    const changes = await collectChanges(f.root, f.base, "worktree");
    expect(changes).toMatchObject([{ path: "file.txt", status: "modified" }]);
    const change = changes[0];
    if (!change) throw new Error("missing change");
    expect((await readSides(f.root, f.base, "worktree", change)).new).toEqual({ bytes: Buffer.from("base\r\n") });
    // Different regular-blob sizes prove a change without opening/hashing disk bytes.
    expect(change.newOid).toBeUndefined();
  } finally {
    await f.cleanup();
  }
});

test("replacing a tracked directory with a gitlink never reads its former descendants", async () => {
  const f = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "emend-outside-gitlink-"));
  try {
    await mkdir(join(f.root, "sub"));
    await writeFile(join(f.root, "sub/tracked.txt"), "base\n");
    await f.run("add", "sub/tracked.txt");
    await f.run("commit", "-m", "synthetic directory");
    const base = (await f.run("rev-parse", "HEAD")).stdout.trim();
    await f.run("update-index", "--force-remove", "sub/tracked.txt");
    await f.run("update-index", "--add", "--cacheinfo", `160000,${f.base},sub`);
    await rm(join(f.root, "sub"), { recursive: true });
    await writeFile(join(outside, "tracked.txt"), "unread\n");
    await symlink(outside, join(f.root, "sub"));
    expect(await collectChanges(f.root, base, "worktree")).toMatchObject([
      { path: "sub/tracked.txt", status: "deleted" },
      { path: "sub", status: "added", newMode: "160000", newOid: f.base },
    ]);
  } finally {
    await f.cleanup();
    await rm(outside, { recursive: true, force: true });
  }
});

test.each(["darwin", "linux"] as const)(
  "%s streaming comparison refuses a swapped parent restored before realpath",
  async (platform) => {
    const dir = await mkdtemp(join(tmpdir(), "emend-stream-containment-"));
    try {
      const root = join(dir, "repo");
      await mkdir(root);
      await writeFile(join(root, "inside.txt"), "allowed");
      const outside = join(dir, "outside.txt");
      await writeFile(outside, "outside");
      const handle = await open(outside, "r");
      const read = vi.spyOn(handle, "read");
      const fs = { platform, open: (() => Promise.resolve(handle)) as typeof open, realpath, stat };
      await expect(hashWorktreeFile(root, "inside.txt", await lstat(outside), "sha1", fs)).rejects.toThrow(
        "file changed while reading",
      );
      expect(read).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("streaming comparison reads bounded chunks and refuses growth during hashing", async () => {
  const root = await mkdtemp(join(tmpdir(), "emend-stream-growth-"));
  try {
    const file = join(root, "file.txt");
    await writeFile(file, Buffer.alloc(256 * 1024, 97));
    const info = await lstat(file);
    const handle = await open(file, "r");
    const read = handle.read.bind(handle);
    const spy = vi.spyOn(handle, "read").mockImplementationOnce(async (...args) => {
      await writeFile(file, "more", { flag: "a" });
      return read(...args);
    });
    const fs = { platform: process.platform, open: (() => Promise.resolve(handle)) as typeof open, realpath, stat };
    await expect(hashWorktreeFile(root, "file.txt", info, "sha1", fs)).rejects.toThrow("file changed while reading");
    expect(spy).toHaveBeenCalledTimes(5);
    for (const call of spy.mock.calls) {
      if (!Buffer.isBuffer(call[0])) throw new Error("expected a read buffer");
      expect(call[0].length).toBeLessThanOrEqual(64 * 1024);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a symlink retarget hashes the link text without reading its destination", async () => {
  const f = await fixture();
  try {
    await symlink("missing-before", join(f.root, "link"));
    await f.run("add", "link");
    await f.run("commit", "-m", "synthetic link");
    const base = (await f.run("rev-parse", "HEAD")).stdout.trim();
    await rm(join(f.root, "link"));
    await symlink("missing-after", join(f.root, "link"));
    const changes = await collectChanges(f.root, base, "worktree");
    expect(changes).toMatchObject([{ path: "link", status: "modified", newMode: "120000" }]);
    const change = changes[0];
    if (!change) throw new Error("missing change");
    expect(await readSides(f.root, base, "worktree", change)).toEqual({
      old: { bytes: Buffer.from("missing-before") },
      new: { bytes: Buffer.from("missing-after") },
    });
  } finally {
    await f.cleanup();
  }
});

test("a file replaced by a directory lists a deletion and its new children", async () => {
  const f = await fixture();
  try {
    await rm(join(f.root, "file.txt"));
    await mkdir(join(f.root, "file.txt"));
    await writeFile(join(f.root, "file.txt", "child.txt"), "child\n");
    expect(await collectChanges(f.root, f.base, "worktree")).toMatchObject([
      { path: "file.txt", status: "deleted" },
      { path: "file.txt/child.txt", status: "added" },
    ]);
  } finally {
    await f.cleanup();
  }
});

test.each(["sha1", "sha256"])(
  "%s worktree hashing drops unchanged oversized files and retains same-size edits",
  async (format) => {
    const f = await fixture(format, "a".repeat(LIMITS.diffSideBytes + 1));
    try {
      expect(await collectChanges(f.root, f.base, "worktree")).toEqual([]);
      await writeFile(join(f.root, "file.txt"), "b".repeat(LIMITS.diffSideBytes + 1));
      const changes = await collectChanges(f.root, f.base, "worktree");
      expect(changes).toMatchObject([{ path: "file.txt", status: "modified" }]);
      const change = changes[0];
      if (!change) throw new Error("missing change");
      expect((await readSides(f.root, f.base, "worktree", change)).new).toEqual({ flag: "oversized" });
    } finally {
      await f.cleanup();
    }
  },
);

test.each([".git", "visible"])("a committed leading symlink to %s makes former descendants absent", async (target) => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, "link"));
    await writeFile(join(f.root, "link/config"), "synthetic old\n");
    await f.run("add", ".");
    await f.run("commit", "-m", "synthetic folder");
    const base = (await f.run("rev-parse", "HEAD")).stdout.trim();
    if (target === "visible") {
      await mkdir(join(f.root, target));
      await writeFile(join(f.root, target, "config"), "unread synthetic\n");
    }
    await rm(join(f.root, "link"), { recursive: true });
    await symlink(target, join(f.root, "link"));
    await f.run("add", ".");
    await f.run("commit", "-m", "synthetic link");
    const result = await resolvePublish(
      {
        version: 1,
        title: "Synthetic",
        base,
        head: "worktree",
        topics: [],
        files: [],
        writeup: { overview: "", tldr: "", decisions: null, topics: {} },
      },
      { manifest: "synthetic" },
      f.state,
      "instance",
      f.root,
      () => {},
    );
    expect(result.request.files.find((file) => file.path === "link/config")).toMatchObject({
      status: "deleted",
      newBlob: null,
    });
    const link = result.request.files.find((file) => file.path === "link");
    expect(link).toMatchObject({ status: "added" });
    expect((await result.blobs.get(link?.newBlob ?? "")?.read())?.toString()).toBe(target);
    expect(await readWorktree(f.root, "link/config")).toBeNull();
  } finally {
    await f.cleanup();
  }
});

test("linked worktree doc sources cannot read either Git directory, even through leaf aliases", async () => {
  const f = await fixture();
  const linked = `${f.root}-linked`;
  try {
    await f.run("worktree", "add", "-b", "linked", linked);
    const privateDir = (
      await exec("git", ["rev-parse", "--absolute-git-dir"], {
        cwd: linked,
        env: {
          PATH: process.env.PATH,
          HOME: f.root,
          LC_ALL: "C",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
        },
      })
    ).stdout.trim();
    await symlink(join(privateDir, "HEAD"), join(linked, "private.md"));
    await symlink(join(f.root, ".git/config"), join(linked, "common.md"));
    for (const source of ["private.md", "common.md"]) {
      await expect(
        resolvePublish(
          {
            version: 1,
            title: "Synthetic",
            topics: [],
            files: [{ path: "doc.md", role: "doc", source }],
            writeup: { overview: "", tldr: "", decisions: null, topics: {} },
          },
          { manifest: "synthetic", key: "docs" },
          f.state,
          "instance",
          linked,
          () => {},
        ),
      ).rejects.toThrow("refusing to read inside the git folder:");
    }
  } finally {
    await rm(linked, { recursive: true, force: true });
    await f.cleanup();
  }
});
