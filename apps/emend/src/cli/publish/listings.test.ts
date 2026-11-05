import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIMITS } from "@emend/contract";
import { expect, test, vi } from "vitest";
import type { GitRunner } from "../git.ts";
import { collectChanges } from "./collect.ts";
import * as worktree from "./worktree.ts";

vi.mock("./worktree.ts", async (original) => ({ ...(await original<typeof import("./worktree.ts")>()) }));

const oid = "a".repeat(40);
test.each([".git/config", ".GIT/x", ".git./x", "git~1/x", ".g\u206ait/x"])(
  "refuses a crafted tree with metadata path %j",
  async (path) => {
    const tree = Buffer.from(`100644 blob ${oid} 1\t${path}\0`);
    await expect(collectChanges("/tmp/synthetic", oid, "worktree", listings(tree, Buffer.alloc(0)))).rejects.toThrow(
      `invalid path: ${path.replace("\u206a", "\\u{206a}")}`,
    );
  },
);
function listings(tree: Buffer, index: Buffer, untracked = Buffer.alloc(0)): GitRunner {
  return async (_cwd, call) => {
    if (call[0] === "ls-tree") return tree;
    if (call[0] === "ls-files") return call[1] === "-z" ? index : untracked;
    if (call[0] === "config") return Buffer.alloc(0);
    if (call[0] === "rev-parse" && call[1] === "--show-object-format") return Buffer.from("sha1\n");
    throw new Error("unexpected git call");
  };
}

test.each(["base", "index", "untracked"])(
  "%s listings preserve path bytes and reject invisible/invalid names",
  async (source) => {
    for (const path of [Buffer.from("\ufeffprivate.txt"), Buffer.from("line\nbreak.txt"), Buffer.from([255])]) {
      const tree =
        source === "base"
          ? Buffer.concat([Buffer.from(`100644 blob ${oid} 1\t`), path, Buffer.from([0])])
          : Buffer.alloc(0);
      const index =
        source === "index"
          ? Buffer.concat([Buffer.from(`H 100644 ${oid} 0\t`), path, Buffer.from([0])])
          : Buffer.alloc(0);
      const untracked = source === "untracked" ? Buffer.concat([path, Buffer.from([0])]) : Buffer.alloc(0);
      await expect(collectChanges("/tmp/synthetic", oid, "worktree", listings(tree, index, untracked))).rejects.toThrow(
        "invalid path:",
      );
    }
  },
);

test.each(["base", "index", "untracked"])("%s listings must end with NUL", async (source) => {
  const tree = source === "base" ? Buffer.from(`100644 blob ${oid} 1\tfile.txt`) : Buffer.alloc(0);
  const index = source === "index" ? Buffer.from(`H 100644 ${oid} 0\tfile.txt`) : Buffer.alloc(0);
  const untracked = source === "untracked" ? Buffer.from("file.txt") : Buffer.alloc(0);
  await expect(collectChanges("/tmp/synthetic", oid, "worktree", listings(tree, index, untracked))).rejects.toThrow(
    "invalid git path listing",
  );
});

test("the changed-file limit does not reject a larger unchanged sparse repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "emend-many-listings-"));
  try {
    const paths = Array.from({ length: LIMITS.filesPerRevision + 1 }, (_, i) => `file-${i}.txt`);
    const tree = Buffer.from(paths.map((path) => `100644 blob ${oid} 1\t${path}\0`).join(""));
    const index = Buffer.from(paths.map((path) => `S 100644 ${oid} 0\t${path}\0`).join(""));
    expect(await collectChanges(root, oid, "worktree", listings(tree, index))).toEqual([]);
    await expect(collectChanges(root, oid, "worktree", listings(tree, Buffer.alloc(0)))).rejects.toThrow(
      "too many changed files",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("crafted base and skip-worktree index descendants behind a symlink are deletions", async () => {
  const root = await mkdtemp(join(tmpdir(), "emend-crafted-link-"));
  try {
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git/config"), "synthetic metadata");
    await symlink(".git", join(root, "link"));
    const tree = Buffer.from(`100644 blob ${oid} 1\tlink/config\0`);
    const index = Buffer.from(`S 100644 ${oid} 0\tlink/config\0`);
    expect(await collectChanges(root, oid, "worktree", listings(tree, index))).toMatchObject([
      { path: "link/config", status: "deleted", newOid: undefined },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["120000 blob", "100644 blob"])(
  "a sparse 2 GiB side with %s BAD base is oversized without hashing",
  async (entry) => {
    const root = await mkdtemp(join(tmpdir(), "emend-oversized-base-"));
    try {
      await writeFile(join(root, "huge.txt"), "");
      await truncate(join(root, "huge.txt"), 2 * 1024 ** 3);
      const tree = Buffer.from(`${entry} ${oid} ${entry.startsWith("120000") ? "10" : "BAD"}\thuge.txt\0`);
      const hash = vi.spyOn(worktree, "hashWorktreeFile");
      expect(await collectChanges(root, oid, "worktree", listings(tree, Buffer.alloc(0)))).toMatchObject([
        { path: "huge.txt", status: "modified", newOversized: true, newOid: undefined },
      ]);
      expect(hash).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      await rm(root, { recursive: true, force: true });
    }
  },
);
