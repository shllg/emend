import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { LIMITS, type PublishManifest } from "@emend/contract";
import { expect, test, vi } from "vitest";
import { collectChanges } from "./collect.ts";
import { projectKey } from "./key.ts";
import { resolvePublish } from "./resolve.ts";
import * as roots from "./root.ts";
import { readSides, readWorktree } from "./sides.ts";
import * as worktree from "./worktree.ts";
import { hashWorktreeFile, statWorktree } from "./worktree.ts";

vi.mock("./worktree.ts", async (original) => ({ ...(await original<typeof import("./worktree.ts")>()) }));
vi.mock("./root.ts", async (original) => ({ ...(await original<typeof import("./root.ts")>()) }));

const exec = promisify(execFile);

const projectManifest = (base?: string): PublishManifest => ({
  version: 1,
  title: "Synthetic",
  ...(base ? { base, head: base } : {}),
  topics: [],
  files: [{ path: "plan.md", role: "doc" }],
  writeup: { overview: "", tldr: "", decisions: null, topics: {} },
});

test.each(["folder", "remote"])("a 230-character %s name is shortened for pubs and code reviews", async (kind) => {
  const longName = "x".repeat(230);
  const f = await fixture("sha1", "base\n", kind === "folder" ? longName : "repo");
  try {
    if (kind === "remote") await f.run("config", "remote.origin.url", `https://example.test/org/${longName}.git`);
    await writeFile(join(f.root, "plan.md"), "# Synthetic plan");
    const identity = kind === "remote" ? `https://example.test/org/${longName}` : await realpath(join(f.root, ".git"));
    for (const base of [undefined, f.base]) {
      const result = await resolvePublish(
        projectManifest(base),
        { key: "plan" },
        f.state,
        f.configDir,
        "instance",
        f.root,
        () => {},
      );
      expect(result.request.repo).toEqual({
        key: createHash("sha256").update(identity).digest("hex"),
        name: "x".repeat(200),
      });
    }
  } finally {
    await f.cleanup();
  }
});

test("a pub falls back to the folder for an invalid remote while a code review still refuses it", async () => {
  const f = await fixture();
  try {
    await f.run("config", "remote.origin.url", "https://example.invalid:99999/x");
    await writeFile(join(f.root, "plan.md"), "# Synthetic plan");
    const collect = (base?: string) =>
      resolvePublish(projectManifest(base), { key: "plan" }, f.state, f.configDir, "instance", f.root, () => {});
    expect((await collect()).request.repo).toEqual({
      key: createHash("sha256")
        .update(await realpath(join(f.root, ".git")))
        .digest("hex"),
      name: "repo",
    });
    await expect(collect(f.base)).rejects.toThrow("invalid origin URL");
  } finally {
    await f.cleanup();
  }
});

test.each([
  { kind: "separate", folder: "metadata" },
  { kind: "separate", folder: "metadata.git" },
  { kind: "separate", folder: "metadata/.git" },
  { kind: "bare", folder: "orchard" },
  { kind: "bare", folder: "orchard.git" },
])(
  "a $kind git directory named $folder uses the right folder for its name and keeps its key",
  async ({ kind, folder }) => {
    const f = await fixture("sha1", "base\n", kind === "separate" ? "orchard" : "repo");
    try {
      const common = join(f.root, "..", folder);
      const root = kind === "bare" ? join(f.root, "..", "pr-42") : f.root;
      if (kind === "bare") {
        await f.run("clone", "--bare", f.root, common);
        await f.run("--git-dir", common, "config", "--unset", "remote.origin.url");
        await f.run("--git-dir", common, "worktree", "add", "-b", "linked", root);
      } else {
        await mkdir(dirname(common), { recursive: true });
        await f.run("init", "--separate-git-dir", common);
      }
      await writeFile(join(root, "plan.md"), "# Synthetic plan");
      for (const base of [undefined, f.base]) {
        const result = await resolvePublish(
          projectManifest(base),
          { key: "plan" },
          f.state,
          f.configDir,
          "instance",
          root,
          () => {},
        );
        expect(result.request.repo).toEqual({
          key: createHash("sha256")
            .update(await realpath(common))
            .digest("hex"),
          name: "orchard",
        });
      }
    } finally {
      await f.cleanup();
    }
  },
);

test.each(["remote", "local", "linked"])(
  "reviews and pubs use the %s repository's name and stable key",
  async (kind) => {
    const f = await fixture();
    try {
      const root = kind === "linked" ? `${f.root}-linked` : f.root;
      if (kind === "linked") await f.run("worktree", "add", "-b", "linked", root);
      if (kind === "remote") await f.run("config", "remote.origin.url", "https://example.test/org/remote-project.git");
      await writeFile(join(root, "plan.md"), "# Synthetic plan");
      for (const code of [true, false]) {
        const manifest: PublishManifest = {
          version: 1,
          title: "Synthetic",
          ...(code ? { base: f.base, head: f.base } : {}),
          topics: [],
          files: [{ path: "plan.md", role: "doc" }],
          writeup: { overview: "", tldr: "", decisions: null, topics: {} },
        };
        const collect = (project?: string) =>
          resolvePublish(manifest, { key: "plan", project }, f.state, f.configDir, "instance", root, () => {});
        const identity =
          kind === "remote" ? "https://example.test/org/remote-project" : await realpath(join(f.root, ".git"));
        const result = await collect();
        expect(result.request.repo).toEqual({
          key: createHash("sha256").update(identity).digest("hex"),
          name: kind === "remote" ? "remote-project" : basename(f.root),
        });
        const repoUrl = code && kind === "remote" ? "https://example.test/org/remote-project" : undefined;
        expect(result.request.repoUrl).toBe(repoUrl);
        const explicit = await collect("Synthetic project");
        expect(explicit.request.repo).toEqual({ key: projectKey("Synthetic project"), name: "Synthetic project" });
        expect(explicit.request.repoUrl).toBe(repoUrl);
      }
    } finally {
      await f.cleanup();
    }
  },
);

test("a pub uses its working directory's repository even when its doc is in an external doc root", async () => {
  const f = await fixture();
  try {
    const docs = `${f.root}-docs`;
    await mkdir(docs);
    await mkdir(f.state);
    await mkdir(f.configDir, { recursive: true, mode: 0o700 });
    await writeFile(join(f.configDir, "config.json"), JSON.stringify({ docRoots: [docs] }));
    await writeFile(join(docs, "plan.md"), "# Synthetic plan");
    const manifest: PublishManifest = {
      version: 1,
      title: "Synthetic",
      topics: [],
      files: [{ path: "plan.md", role: "doc", source: join(docs, "plan.md") }],
      writeup: { overview: "", tldr: "", decisions: null, topics: {} },
    };
    const collect = (cwd: string, project?: string) =>
      resolvePublish(manifest, { key: "plan", project }, f.state, f.configDir, "instance", cwd, () => {});
    expect((await collect(f.root)).request.repo?.name).toBe(basename(f.root));
    // A sandbox may place a .git marker above the temporary folders.
    const noRepo = vi.spyOn(roots, "worktreeRoot").mockResolvedValue(null);
    try {
      expect((await collect(docs)).request.repo).toBeNull();
      expect((await collect(docs, "Synthetic project")).request.repo).toEqual({
        key: projectKey("Synthetic project"),
        name: "Synthetic project",
      });
    } finally {
      noRepo.mockRestore();
    }
  } finally {
    await f.cleanup();
  }
});
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
      f.configDir,
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
      f.configDir,
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
async function fixture(format = "sha1", content = "base\n", name = "repo") {
  const dir = await mkdtemp(join(tmpdir(), "emend-worktree-listing-"));
  const root = join(dir, name);
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
    return {
      root,
      state: join(dir, "state"),
      configDir: join(dir, "config", "emend"),
      run,
      base,
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
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
      f.configDir,
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
          f.configDir,
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
