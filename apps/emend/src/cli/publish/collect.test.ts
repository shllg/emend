import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { LIMITS, type PublishManifest } from "@emend/contract";
import { expect, test } from "vitest";
import { collectChanges } from "./collect.ts";
import { resolvePublish } from "./resolve.ts";
import { readSides } from "./sides.ts";

const exec = promisify(execFile);
test("a configured external worktree cannot grant access to a docs-only source", async () => {
  const f = await repo();
  const outside = await mkdtemp(join(tmpdir(), "emend-external-worktree-"));
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
  const dir = await mkdtemp(join(tmpdir(), "emend-git-"));
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
      configDir: join(dir, "config", "emend"),
      run,
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

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
  const sibling = await mkdtemp(join(tmpdir(), "emend-worktree-"));
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
