import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { LIMITS, type PreparedFile, PublishManifest } from "@recense/contract";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { run } from "../../main.ts";
import * as executor from "../../server/publish/executor.ts";
import * as collection from "../publish/collect.ts";
import { resolvePublish } from "../publish/resolve.ts";
import * as roots from "../publish/root.ts";
import { prepareCommand } from "./prepare.ts";

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
const skeleton = async () => PublishManifest.parse(JSON.parse(await readFile(path, "utf8")));
const withLimits = (base: string, head: string, limits: NonNullable<Parameters<typeof prepareCommand>[5]>) =>
  prepareCommand(
    join(dir, "state"),
    join(dir, "config"),
    ["--base", base, "--head", head, "--dir", folder],
    { stdout: vi.fn(), stderr: vi.fn(), env: {} },
    root,
    limits,
  );

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
    ["large.md", "refused"],
    ["matching.MARKDOWN", "included"],
    ["matching.MARKDOWN", "doc"],
    ["missing.htm", "refused"],
    ["redirect.html", "refused"],
  ]);
  expect(files.filter((file) => file.prepared?.doc === "refused").map((file) => file.prepared?.docRefusal)).toEqual([
    "file exceeds its size limit: large.md",
    "doc not found: missing.htm",
    "doc source must end in .md, .markdown, .html or .htm, like its path.",
  ]);
});

test("counts a repeated object pair once on the worker and skips fresh pairs after exhausting the budget", async () => {
  await git("init", "-b", "topic");
  const base = await commit();
  for (const [file, bytes] of [
    ["a", "same"],
    ["b", "same"],
    ["c", "different"],
    ["d", "\0"],
  ] as const)
    await writeFile(join(root, file), bytes);
  const head = await commit();
  const worker = executor.workerExecutor();
  const execute = Object.assign(vi.fn(worker), { close: vi.fn(worker.close) });
  vi.spyOn(executor, "workerExecutor").mockReturnValue(execute);
  await withLimits(base, head, { countBudgetMs: Number.MIN_VALUE });
  expect(execute).toHaveBeenCalledExactlyOnceWith({ kind: "diff-counts", old: null, next: expect.any(ArrayBuffer) });
  expect(execute.close).toHaveBeenCalledOnce();
  expect((await skeleton()).files).toEqual([
    diff("a", { status: "added", added: 1, removed: 0 }),
    diff("b", { status: "added", added: 1, removed: 0 }),
    diff("c", { status: "added" }),
    diff("d", { status: "added", flag: "binary" }),
  ]);
});

test("distinguishes size-changing worktree sides when collection omits their new object ids", async () => {
  await git("init", "-b", "topic");
  for (const name of ["a.md", "b.md"]) await writeFile(join(root, name), "old\n");
  const base = await commit();
  await writeFile(join(root, "a.md"), "one new line\n");
  await writeFile(join(root, "b.md"), "two\nlines\n");
  expect((await prepare(base, "worktree")).code).toBe(0);
  expect((await skeleton()).files).toEqual([
    diff("a.md", { status: "modified", added: 1, removed: 1, doc: "included" }),
    doc("a.md"),
    diff("b.md", { status: "modified", added: 2, removed: 1, doc: "included" }),
    doc("b.md"),
  ]);
});

test.each(["commit", "worktree"])("refuses a changed symlink doc at a %s head", async (kind) => {
  await git("init", "-b", "topic");
  await writeFile(join(root, "target.md"), "# Target");
  const base = await commit();
  await symlink("target.md", join(root, "alias.md"));
  const head = kind === "commit" ? await commit() : "worktree";
  expect((await prepare(base, head)).code).toBe(0);
  expect((await skeleton()).files).toEqual([
    diff("alias.md", {
      status: "added",
      added: 1,
      removed: 0,
      doc: "refused",
      docRefusal: "the changed doc is not a regular file",
    }),
  ]);
});

test("compares the publishable doc bytes with the collected worktree object", async () => {
  await git("init", "--object-format=sha256", "-b", "topic");
  const base = await commit();
  const file = join(root, "changed.md");
  await writeFile(file, "collected\n");
  const collect = collection.collectChanges;
  vi.spyOn(collection, "collectChanges").mockImplementationOnce(async (...args) => {
    const changes = await collect(...args);
    await writeFile(file, "later\n");
    return changes;
  });
  expect((await prepare(base, "worktree")).code).toBe(0);
  expect((await skeleton()).files).toEqual([
    diff("changed.md", {
      status: "added",
      added: 1,
      removed: 0,
      doc: "differs-from-head",
    }),
  ]);
});

test("refuses a changed doc when publish rejects its oversized local asset", async () => {
  await git("init", "-b", "topic");
  const base = await commit();
  await writeFile(join(root, "guide.html"), '<img src="picture.png">');
  const head = await commit();
  const asset = join(root, "picture.png");
  await writeFile(asset, "");
  await truncate(asset, LIMITS.assetBytes + 1);
  expect((await prepare(base, head)).code).toBe(0);
  expect((await skeleton()).files).toEqual([
    diff("guide.html", {
      status: "added",
      added: 1,
      removed: 0,
      doc: "refused",
      docRefusal: "asset exceeds its size limit",
    }),
  ]);
});

test.skipIf(!process.getuid || process.getuid() === 0)("records publish's refusal for an unreadable doc", async () => {
  await git("init", "-b", "topic");
  const base = await commit();
  await writeFile(join(root, "locked.md"), "text");
  const head = await commit();
  await chmod(join(root, "locked.md"), 0);
  expect((await prepare(base, head)).code).toBe(0);
  expect((await skeleton()).files).toEqual([
    diff("locked.md", {
      status: "added",
      added: 1,
      removed: 0,
      doc: "refused",
      docRefusal: "unreadable: locked.md",
    }),
  ]);
});

test("records a fixed refusal when a doc read encounters a symlink loop", async () => {
  await git("init", "-b", "topic");
  const base = await commit();
  await writeFile(join(root, "loop.md"), "text");
  const head = await commit();
  await rm(join(root, "loop.md"));
  await symlink("loop.md", join(root, "loop.md"));
  expect((await prepare(base, head)).code).toBe(0);
  expect((await skeleton()).files).toEqual([
    diff("loop.md", {
      status: "added",
      added: 1,
      removed: 0,
      doc: "refused",
      docRefusal: "the doc could not be read",
    }),
  ]);
});

test("truncates long publish refusals with a closing ellipsis", async () => {
  await git("init", "-b", "topic");
  const base = await commit();
  const parent = Array(5).fill("a".repeat(200)).join("/");
  await mkdir(join(root, parent), { recursive: true });
  const name = join(parent, "missing.md");
  await writeFile(join(root, name), "text");
  const head = await commit();
  await rm(join(root, name));
  expect((await prepare(base, head)).code).toBe(0);
  expect((await skeleton()).files[0]?.prepared?.docRefusal).toBe(`${`doc not found: ${name}`.slice(0, 999)}…`);
});

test("reserves a slot for every diff before including docs", async () => {
  await git("init", "-b", "topic");
  const base = await commit();
  for (const name of ["a.md", "b.md", "z.txt"]) await writeFile(join(root, name), "text");
  await withLimits(base, "worktree", { filesPerRevision: 4 });
  expect((await skeleton()).files).toEqual([
    diff("a.md", { status: "added", added: 1, removed: 0, doc: "included" }),
    doc("a.md"),
    diff("b.md", { status: "added", added: 1, removed: 0, doc: "refused", docRefusal: "too many files in the review" }),
    diff("z.txt", { status: "added", added: 1, removed: 0 }),
  ]);
});

test("rejects folders inside a linked worktree's git directories before checking commits", async () => {
  await git("init", "-b", "topic");
  await commit();
  const linked = join(dir, "linked");
  await git("worktree", "add", "-b", "linked", linked);
  vi.spyOn(process, "cwd").mockReturnValue(linked);
  for (const gitDir of [join(root, ".git"), join(root, ".git/worktrees/linked")]) {
    const dest = join(gitDir, "review");
    await mkdir(dest, { mode: 0o700 });
    expect(await prepare("a".repeat(40), "worktree", dest)).toEqual({
      code: 1,
      stdout: "",
      stderr: "recense: review folder must be outside the repository's git folders\n",
    });
    await expect(stat(join(dest, "review.json"))).rejects.toMatchObject({ code: "ENOENT" });
  }
});

test("cleans the branch title and visibly escapes hidden code points in paths without changing them", async () => {
  await git("init", "-b", "top\u202eic");
  const base = await commit();
  const name = "a \u{e0041}\ue123\u0378\u00a0\u2800\ufe0f\u{e0100}.txt";
  await writeFile(join(root, name), "text");
  const head = await commit();
  expect((await prepare(base, head)).code).toBe(0);
  const raw = await readFile(path, "utf8");
  expect(raw).toContain(String.raw`a \udb40\udc41\ue123\u0378\u00a0\u2800\ufe0f\udb40\udd00.txt`);
  const manifest = await skeleton();
  expect(manifest.title).toBe("topic");
  expect(manifest.files[0]?.path).toBe(name);
  await git("branch", "-m", "\u202e");
  await rm(path);
  expect((await prepare(base, head)).code).toBe(0);
  expect((await skeleton()).title).toBe("Review");
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
