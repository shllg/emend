import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { LIMITS, type PreparedFile, PublishManifest } from "@recense/contract";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { run } from "../../main.ts";
import { resolvePublish } from "../publish/resolve.ts";
import * as roots from "../publish/root.ts";

const exec = promisify(execFile);
let dir: string;
let root: string;
let folder: string;
let path: string;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "recense-prepare-")));
  root = join(dir, "repo");
  folder = join(dir, "review");
  path = join(folder, "review.json");
  await mkdir(root);
  await mkdir(folder, { mode: 0o700 });
  vi.spyOn(process, "cwd").mockReturnValue(root);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

async function git(...args: string[]) {
  const result = await exec(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "user.name=Synthetic",
      "-c",
      "user.email=synthetic@example.test",
      ...args,
    ],
    {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" },
    },
  );
  return result.stdout.trim();
}
async function commit() {
  await git("add", ".");
  await git("commit", "--allow-empty", "-m", "synthetic snapshot");
  return git("rev-parse", "HEAD");
}
async function command(...args: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await run(["prepare", ...args], {
    env: { RECENSE_HOME: join(dir, "state"), XDG_CONFIG_HOME: join(dir, "config") },
    stdout: (line) => {
      stdout += line;
    },
    stderr: (line) => {
      stderr += line;
    },
  });
  return { code, stdout, stderr };
}
const prepare = (base: string, head: string, dest = folder) => command("--base", base, "--head", head, "--dir", dest);
const diff = (path: string, prepared: PreparedFile) => ({
  path,
  role: "diff",
  prepared,
});
const doc = (path: string) => ({ path, role: "doc" });

test("prepares a committed branch in listing order and resolves the same files as a handwritten manifest", async () => {
  await git("init", "-b", "topic");
  await writeFile(join(root, "delete.md"), "removed\n");
  await writeFile(join(root, "edit.txt"), "stable\nbefore\n");
  await writeFile(join(root, "old.txt"), "renamed\n");
  const base = await commit();
  await rm(join(root, "delete.md"));
  // The server decoder drops the UTF-8 BOM on the first (unchanged) line.
  await writeFile(join(root, "edit.txt"), "\ufeffstable\nafter\nextra\n");
  await rename(join(root, "old.txt"), join(root, "moved.txt"));
  await writeFile(join(root, "plan.md"), "# Plan\n");
  await writeFile(join(root, "binary.bin"), Buffer.from([1, 0, 2]));
  const head = await commit();
  await mkdir(join(root, "subdir"));
  vi.spyOn(process, "cwd").mockReturnValue(join(root, "subdir"));
  expect(await prepare(base, head, "../../review")).toEqual({
    code: 0,
    stderr: "",
    stdout: `${JSON.stringify({ manifest: path, diff: 5, doc: 1 })}\n`,
  });
  const text = await readFile(path, "utf8");
  const skeleton = PublishManifest.parse(JSON.parse(text));
  expect(text).toBe(`${JSON.stringify(skeleton, null, 2)}\n`);
  if (process.getuid) expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(skeleton).toEqual({
    version: 1,
    title: "topic",
    base,
    head,
    topics: [],
    files: [
      diff("binary.bin", { status: "added", flag: "binary" }),
      diff("delete.md", { status: "deleted", added: 0, removed: 1, doc: "deleted" }),
      diff("edit.txt", { status: "modified", added: 2, removed: 1 }),
      diff("moved.txt", { status: "renamed", oldPath: "old.txt", added: 0, removed: 0 }),
      diff("plan.md", { status: "added", added: 1, removed: 0, doc: "included" }),
      doc("plan.md"),
    ],
    writeup: { overview: "", tldr: "", decisions: null, topics: {} },
  });

  const topics = [{ slug: "plan", title: "Plan", summary: "New plan.", importance: 5 }];
  const writeup = {
    overview: "A new plan.",
    tldr: "Read the plan.",
    decisions: null,
    topics: { plan: { why: "New scope." } },
  };
  const resolve = async (manifest: PublishManifest) =>
    (
      await resolvePublish(
        manifest,
        { manifest: path },
        join(dir, "state"),
        join(dir, "config/recense"),
        "instance",
        root,
        () => {},
      )
    ).request.files;
  const files = await resolve({ ...skeleton, topics, writeup });
  const handwritten = PublishManifest.parse({
    version: 1,
    title: "Handwritten",
    base,
    head,
    topics,
    writeup,
    files: ["binary.bin", "delete.md", "edit.txt", "moved.txt", "plan.md"]
      .map((path) => ({ path, role: "diff" }))
      .concat(doc("plan.md")),
  });
  expect(files).toEqual(await resolve(handwritten));
  expect(files.every((file) => !("prepared" in file))).toBe(true);
});

test("worktree preparation includes untracked files, flags, lockfiles and collection warnings", async () => {
  await git("init", "-b", "topic");
  const base = await commit();
  await git("checkout", "--detach");
  await writeFile(join(root, "guide.htm"), "<p>Guide</p>");
  await writeFile(join(root, "large.txt"), Buffer.alloc(LIMITS.diffSideBytes + 1, 65));
  await writeFile(join(root, "yarn.lock"), "sample\n");
  await git("init", "-b", "nested", "nested");
  const result = await prepare(base, "worktree");
  expect(result).toEqual({
    code: 0,
    stdout: `${JSON.stringify({ manifest: path, diff: 3, doc: 1 })}\n`,
    stderr: "recense: skipped nested/: nested repository\n",
  });
  const skeleton = JSON.parse(await readFile(path, "utf8"));
  expect(skeleton.title).toBe("repo");
  expect(skeleton.files).toEqual([
    diff("guide.htm", { status: "added", added: 1, removed: 0, doc: "included" }),
    doc("guide.htm"),
    diff("large.txt", { status: "added", flag: "oversized" }),
    diff("yarn.lock", { status: "added", added: 1, removed: 0, lockfile: true }),
  ]);
});

test("checks docs on disk against the SHA-256 head and records each reason for omission", async () => {
  await git("init", "--object-format=sha256", "-b", "topic");
  const base = await commit();
  for (const file of ["changed.md", "large.md", "matching.MARKDOWN", "missing.htm", "redirect.html"])
    await writeFile(join(root, file), "original\n");
  const head = await commit();
  await writeFile(join(root, "changed.md"), "different\n");
  await writeFile(join(root, "large.md"), Buffer.alloc(LIMITS.markdownDocBytes + 1, 65));
  await rm(join(root, "missing.htm"));
  await rm(join(root, "redirect.html"));
  await symlink("matching.MARKDOWN", join(root, "redirect.html"));
  expect(await prepare(base, head)).toEqual({
    code: 0,
    stderr: "",
    stdout: `${JSON.stringify({ manifest: path, diff: 5, doc: 1 })}\n`,
  });
  const { files } = PublishManifest.parse(JSON.parse(await readFile(path, "utf8")));
  expect(files.map((file) => [file.path, file.prepared?.doc ?? file.role])).toEqual([
    ["changed.md", "differs-from-head"],
    ["large.md", "too-large"],
    ["matching.MARKDOWN", "included"],
    ["matching.MARKDOWN", "doc"],
    ["missing.htm", "missing"],
    ["redirect.html", "refused"],
  ]);
});

test("refuses existing output and invalid revisions with one error line", async () => {
  await git("init", "-b", "topic");
  const base = await commit();
  const absent = "a".repeat(40);
  expect(await prepare(absent, "worktree")).toEqual({
    code: 1,
    stdout: "",
    stderr: `recense: base is not a commit in this clone: ${absent}\n`,
  });
  expect(await prepare(base, absent)).toEqual({
    code: 1,
    stdout: "",
    stderr: `recense: head is not a commit in this clone: ${absent}\n`,
  });
  expect(await prepare("short", "worktree")).toEqual({
    code: 1,
    stdout: "",
    stderr: "recense: base must be a full commit hash\n",
  });
  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  await writeFile(path, "original");
  expect(await prepare(base, base)).toEqual({
    code: 1,
    stdout: "",
    stderr: `recense: review.json already exists in ${folder}; nothing was written\n`,
  });
  expect(await readFile(path, "utf8")).toBe("original");
});

test("checks the destination before git and rejects unsafe folders and dangling output links", async () => {
  // Worktree discovery succeeds on disk, but any git lookup would fail.
  await mkdir(join(root, ".git"));
  await mkdir(join(root, "inside"));
  await symlink(root, join(dir, "alias"));
  const check = (dest: string) => prepare("a".repeat(40), "worktree", dest);
  expect(await check(join(dir, "alias/inside"))).toEqual({
    code: 1,
    stdout: "",
    stderr: "recense: review folder must be outside the worktree\n",
  });
  await symlink(folder, join(dir, "link"));
  await writeFile(join(dir, "file"), "ordinary file");
  for (const name of ["link", "missing", "file"]) {
    expect(await check(join(dir, name))).toEqual({
      code: 1,
      stdout: "",
      stderr: expect.stringMatching(/^recense: [^\n]+\n$/),
    });
  }
  if (process.getuid) {
    await chmod(folder, 0o770);
    expect(await check(folder)).toEqual({
      code: 1,
      stdout: "",
      stderr: expect.stringContaining("writable only by that user"),
    });
    await chmod(folder, 0o755);
  }
  await symlink("missing.json", path);
  expect(await check(folder)).toEqual({
    code: 1,
    stdout: "",
    stderr: `recense: review.json already exists in ${folder}; nothing was written\n`,
  });
  await expect(stat(join(folder, "missing.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("concurrent prepares create exactly one manifest", async () => {
  await git("init", "-b", "topic");
  const base = await commit();
  const results = await Promise.all([prepare(base, base), prepare(base, base)]);
  expect(results.sort((a, b) => a.code - b.code)).toEqual([
    { code: 0, stdout: `${JSON.stringify({ manifest: path, diff: 0, doc: 0 })}\n`, stderr: "" },
    { code: 1, stdout: "", stderr: `recense: review.json already exists in ${folder}; nothing was written\n` },
  ]);
  expect(PublishManifest.parse(JSON.parse(await readFile(path, "utf8"))).files).toEqual([]);
});

test("requires a repository and each of the three flags exactly once", async () => {
  const flags = ["--head", "worktree", "--base", "a".repeat(40), "--dir", folder];
  vi.spyOn(roots, "worktreeRoot").mockResolvedValueOnce(null);
  expect(await command(...flags)).toEqual({ code: 1, stderr: "recense: not a git repository\n", stdout: "" });
  for (const args of [[], flags.slice(2), flags.slice(0, -1), [...flags, "--dir", folder], [...flags, "--new"]])
    expect(await command(...args)).toEqual({
      code: 2,
      stdout: "",
      stderr: expect.stringMatching(/^recense: usage: [^\n]+\n$/),
    });
});
