import { execFile } from "node:child_process";
import { access, chmod, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { createGitSession } from "../git.ts";
import { collectChanges } from "./collect.ts";
import { readSides } from "./sides.ts";

const exec = promisify(execFile);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "recense-hostile-git-"));
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
  await run("init", "-b", "main");
  await run("config", "user.name", "Synthetic");
  await run("config", "user.email", "synthetic@example.test");
  await writeFile(join(root, "file.txt"), "before\n");
  await run("add", ".");
  await run("commit", "-m", "synthetic");
  const base = (await run("rev-parse", "HEAD")).stdout.trim();
  const oid = (await run("rev-parse", "HEAD:file.txt")).stdout.trim();
  const marker = join(root, ".git", "marker");
  const script = join(root, ".git", "evil");
  await writeFile(script, `#!/bin/sh\nprintf executed > '${marker}'\ncat\n`);
  await chmod(script, 0o755);
  return { root, run, base, oid, marker, script, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("hostile hooks and info attributes never run and worktree collection leaves the index unchanged", async () => {
  const f = await fixture();
  try {
    await f.run("config", "core.hooksPath", ".git");
    await writeFile(join(f.root, ".git/post-index-change"), await readFile(f.script));
    await chmod(join(f.root, ".git/post-index-change"), 0o755);
    await f.run("config", "filter.evil.clean", f.script);
    await writeFile(join(f.root, ".git/info/attributes"), "* filter=evil\n");
    await writeFile(join(f.root, "file.txt"), "edited\n");
    const before = await readFile(join(f.root, ".git/index"));
    const run = createGitSession();
    const changes = await collectChanges(f.root, f.base, "worktree", async (cwd, call) => {
      const result = await run(cwd, call);
      await expect(access(f.marker), call.join(" ")).rejects.toMatchObject({ code: "ENOENT" });
      return result;
    });
    const change = changes.find((c) => c.path === "file.txt");
    if (!change) throw new Error("missing change");
    expect((await readSides(f.root, f.base, "worktree", change)).new).toEqual({ bytes: Buffer.from("edited\n") });
    expect(await readFile(join(f.root, ".git/index"))).toEqual(before);
    await expect(access(f.marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await f.cleanup();
  }
});

test("missing promisor objects cannot execute the repository sshCommand", async () => {
  const f = await fixture();
  try {
    await f.run("config", "extensions.partialClone", "origin");
    await f.run("config", "remote.origin.promisor", "true");
    await f.run("config", "remote.origin.url", "ssh://example.invalid/synthetic");
    await f.run("config", "core.sshCommand", f.script);
    await rm(join(f.root, ".git/objects", f.oid.slice(0, 2), f.oid.slice(2)));
    await writeFile(join(f.root, "file.txt"), "changed\n");
    const changes = await collectChanges(f.root, f.base, "worktree");
    const change = changes[0];
    if (!change) throw new Error("missing change");
    await expect(readSides(f.root, f.base, "worktree", change)).rejects.toThrow();
    await expect(access(f.marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await f.cleanup();
  }
});

test("stat-dirty unchanged files are dropped without touching the index", async () => {
  const f = await fixture();
  try {
    await utimes(join(f.root, "file.txt"), new Date(0), new Date(0));
    const before = await readFile(join(f.root, ".git/index"));
    expect(await collectChanges(f.root, f.base, "worktree")).toEqual([]);
    expect(await readFile(join(f.root, ".git/index"))).toEqual(before);
  } finally {
    await f.cleanup();
  }
});

test("a hostile nested gitlink executes no program and a submodule bump uses synthetic sides", async () => {
  const f = await fixture();
  try {
    const sub = join(f.root, "sub");
    await f.run("init", "-b", "main", sub);
    await f.run("-C", sub, "config", "user.name", "Synthetic");
    await f.run("-C", sub, "config", "user.email", "synthetic@example.test");
    await writeFile(join(sub, "tracked.txt"), "before\n");
    await f.run("-C", sub, "add", "tracked.txt");
    await f.run("-C", sub, "commit", "-m", "synthetic sub base");
    const old = (await f.run("-C", sub, "rev-parse", "HEAD")).stdout.trim();
    await f.run("update-index", "--add", "--cacheinfo", `160000,${old},sub`);
    await f.run("commit", "-m", "synthetic gitlink");
    const base = (await f.run("rev-parse", "HEAD")).stdout.trim();
    await f.run("-C", sub, "commit", "--allow-empty", "-m", "synthetic sub bump");
    const next = (await f.run("-C", sub, "rev-parse", "HEAD")).stdout.trim();
    await f.run("update-index", "--cacheinfo", `160000,${next},sub`);
    await f.run("-C", sub, "config", "core.fsmonitor", f.script);
    await f.run("-C", sub, "config", "core.hooksPath", ".git");
    await f.run("-C", sub, "config", "filter.evil.clean", f.script);
    await writeFile(join(sub, ".git/info/attributes"), "* filter=evil\n");
    await writeFile(join(sub, "tracked.txt"), "edited\n");
    await writeFile(join(sub, ".git/post-index-change"), await readFile(f.script));
    await chmod(join(sub, ".git/post-index-change"), 0o755);
    const change = (await collectChanges(f.root, base, "worktree")).find((c) => c.path === "sub");
    if (!change) throw new Error("missing submodule bump");
    expect(await readSides(f.root, base, "worktree", change)).toEqual({
      old: { bytes: Buffer.from(`Subproject commit ${old}\n`) },
      new: { bytes: Buffer.from(`Subproject commit ${next}\n`) },
    });
    await expect(access(f.marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await f.cleanup();
  }
});

test("pairs an unstaged exact rename and skips an untracked nested repository with one warning", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "renamed.txt"), await readFile(join(f.root, "file.txt")));
    await rm(join(f.root, "file.txt"));
    await f.run("init", join(f.root, "nested"));
    const warnings: string[] = [];
    const changes = await collectChanges(f.root, f.base, "worktree", undefined, (line) => warnings.push(line));
    expect(changes).toMatchObject([{ path: "renamed.txt", oldPath: "file.txt", status: "renamed" }]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("nested repository");
  } finally {
    await f.cleanup();
  }
});

test("post-index-change never runs and a modified worktree leaves the index unchanged", async () => {
  const f = await fixture();
  try {
    await f.run("config", "core.hooksPath", ".git");
    await writeFile(join(f.root, ".git/post-index-change"), await readFile(f.script));
    await chmod(join(f.root, ".git/post-index-change"), 0o755);
    await writeFile(join(f.root, "file.txt"), "edited\n");
    const before = await readFile(join(f.root, ".git/index"));
    expect(await collectChanges(f.root, f.base, "worktree")).toMatchObject([{ path: "file.txt", status: "modified" }]);
    expect(await readFile(join(f.root, ".git/index"))).toEqual(before);
    await expect(access(f.marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await f.cleanup();
  }
});

test("a racy same-size edit with the index timestamp never invokes an info-attributes filter", async () => {
  const f = await fixture();
  try {
    await f.run("config", "filter.evil.clean", f.script);
    await writeFile(join(f.root, ".git/info/attributes"), "* filter=evil\n");
    await writeFile(join(f.root, "file.txt"), "edited\n");
    const indexPath = join(f.root, ".git/index");
    const timestamp = Math.floor((await stat(indexPath)).mtimeMs / 1000);
    await utimes(indexPath, timestamp, timestamp);
    await utimes(join(f.root, "file.txt"), timestamp, timestamp);
    expect((await stat(join(f.root, "file.txt"))).mtimeMs).toBe((await stat(indexPath)).mtimeMs);
    const index = await readFile(indexPath);
    expect(await collectChanges(f.root, f.base, "worktree")).toMatchObject([{ path: "file.txt", status: "modified" }]);
    expect(await readFile(indexPath)).toEqual(index);
    await expect(access(f.marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await f.cleanup();
  }
});
