import { lstat, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { expect, test, vi } from "vitest";
import type { GitRunner } from "../git.ts";
import { collectChanges } from "./collect.ts";

const oid = "a".repeat(40);
function listings(paths: string[], skip = true, mode = "100644"): GitRunner {
  const tree = Buffer.from(paths.map((path) => `${mode} blob ${oid} 4\t${path}\0`).join(""));
  const index = Buffer.from(paths.map((path) => `S ${mode} ${oid} 0\t${path}\0`).join(""));
  return async (_root, call) => {
    if (call[0] === "ls-tree") return tree;
    if (call[0] === "ls-files") return call[1] === "-z" && skip ? index : Buffer.alloc(0);
    if (call[0] === "rev-parse") return Buffer.from("sha1");
    return Buffer.alloc(0);
  };
}

test.each([1, 100])(
  "10001 paths in %i folders share each leading check and bound concurrent leaf stats",
  async (folders) => {
    const root = await mkdtemp(join(tmpdir(), "recense-collection-count-"));
    try {
      const directories = [join(root, "shared"), join(root, "shared/deep")];
      for (let i = 0; i < folders; i++) {
        const folder = join(root, `shared/deep/folder-${i}`);
        directories.push(folder);
        await mkdir(folder, { recursive: true });
      }
      const paths = Array.from({ length: 10001 }, (_, i) => `shared/deep/folder-${i % folders}/file-${i}.txt`);
      const calls = new Map<string, number>();
      let active = 0;
      let maximum = 0;
      const fs = {
        lstat: (async (file: string) => {
          calls.set(file, (calls.get(file) ?? 0) + 1);
          maximum = Math.max(maximum, ++active);
          try {
            return await lstat(file);
          } finally {
            active--;
          }
        }) as typeof lstat,
        realpath: vi.fn((file: string) => realpath(file)) as unknown as typeof realpath,
      };
      expect(await collectChanges(root, oid, "worktree", listings(paths), () => {}, undefined, fs)).toEqual([]);
      expect(calls.size).toBe(paths.length + directories.length);
      for (const directory of directories) expect(calls.get(directory), directory).toBe(1);
      for (const path of paths) expect(calls.get(join(root, path))).toBe(1);
      expect(maximum).toBeGreaterThan(1);
      expect(maximum).toBeLessThanOrEqual(64);
      expect(active).toBe(0);
      expect(fs.realpath).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each(["absent", "symlink", "file"])(
  "a cached %s parent makes all descendants absent without probing them",
  async (state) => {
    const root = await mkdtemp(join(tmpdir(), "recense-collection-blocked-"));
    try {
      await mkdir(join(root, "shared"));
      const blocked = join(root, "shared/blocked");
      if (state === "symlink") {
        await mkdir(join(root, "target/deep"), { recursive: true });
        await symlink("../target", blocked);
      } else if (state === "file") await writeFile(blocked, "synthetic");
      const paths = Array.from({ length: 130 }, (_, i) => `shared/blocked/deep/file-${i}.txt`);
      const fs = { lstat: vi.fn(lstat), realpath: vi.fn((file: string) => realpath(file)) };
      const changed = await collectChanges(root, oid, "worktree", listings(paths), () => {}, undefined, {
        lstat: fs.lstat as typeof lstat,
        realpath: fs.realpath as unknown as typeof realpath,
      });
      expect(changed.map(({ path, status }) => ({ path, status }))).toEqual(
        paths.map((path) => ({ path, status: "deleted" })),
      );
      expect(fs.lstat.mock.calls.map(([file]) => file)).toEqual([join(root, "shared"), blocked]);
      expect(fs.realpath).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("folder state is discarded between collections", async () => {
  const root = await mkdtemp(join(tmpdir(), "recense-collection-fresh-"));
  try {
    await mkdir(join(root, "shared"));
    await mkdir(join(root, "target"));
    const run = listings(["shared/missing.txt"]);
    expect(await collectChanges(root, oid, "worktree", run)).toEqual([]);
    await rm(join(root, "shared"), { recursive: true });
    await symlink("target", join(root, "shared"));
    expect(await collectChanges(root, oid, "worktree", run)).toMatchObject([
      { path: "shared/missing.txt", status: "deleted" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["file", "symlink"])("%s reads recheck a folder swapped after its collection check", async (kind) => {
  const root = await mkdtemp(join(tmpdir(), "recense-collection-swap-"));
  try {
    const folder = join(root, "shared");
    await mkdir(folder);
    await mkdir(join(root, "replacement"));
    if (kind === "file") await writeFile(join(folder, "entry"), "safe");
    else await symlink("safe", join(folder, "entry"));
    let swapped = false;
    const fs = {
      lstat,
      realpath: (async (file: string) => {
        const actual = await realpath(file);
        if (file === folder && !swapped) {
          swapped = true;
          await rename(folder, join(root, "moved"));
          await symlink("replacement", folder);
        }
        return actual;
      }) as typeof realpath,
    };
    await expect(
      collectChanges(
        root,
        oid,
        "worktree",
        listings(["shared/entry"], false, kind === "file" ? "100644" : "120000"),
        () => {},
        undefined,
        fs,
      ),
    ).rejects.toThrow("file changed while reading");
    expect(swapped).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed batch drains its filesystem work and reports the first error in listing order", async () => {
  const root = await mkdtemp(join(tmpdir(), "recense-collection-failure-"));
  try {
    const paths = Array.from({ length: 130 }, (_, i) => `file-${i}.txt`);
    let active = 0;
    const calls: string[] = [];
    const first = new Error("first listed error");
    const fs = {
      lstat: (async (file: string) => {
        calls.push(file);
        active++;
        try {
          await setImmediate();
          if (file === join(root, paths[0] ?? "")) {
            await setImmediate();
            throw first;
          }
          if (file === join(root, paths[1] ?? "")) throw new Error("later listed error");
          return await lstat(file);
        } finally {
          active--;
        }
      }) as typeof lstat,
      realpath,
    };
    await expect(collectChanges(root, oid, "worktree", listings(paths), () => {}, undefined, fs)).rejects.toBe(first);
    expect(calls).toHaveLength(64);
    expect(active).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
