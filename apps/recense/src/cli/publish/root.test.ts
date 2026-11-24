import { lstat, mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import { worktreeRoot } from "./root.ts";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(process.env.RECENSE_HOME as string, "publish-root-")));
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(lstat)
    .mockReset()
    .mockImplementation(async (...args) => {
      const entry = String(args[0]);
      // Hide only host ancestors; all entries within the fixture are real synthetic files.
      if (entry.endsWith(`${sep}.git`) && !entry.startsWith(`${root}${sep}`))
        throw Object.assign(new Error("no synthetic repository entry"), { code: "ENOENT" });
      return actual.lstat(...args);
    });
});

test.each([
  "directory",
  "gitdir: ../.git/modules/sub",
  "gitdir: ../.git/modules/sub\n",
  "gitdir: ../.git/modules/sub\r\n",
])("publish keeps the nearest repository for .git entry %j, resolving the current directory", async (entry) => {
  const repo = join(root, "outer");
  const inner = join(repo, "sub");
  const cwd = join(inner, "nested");
  await mkdir(join(repo, ".git"), { recursive: true });
  await mkdir(cwd, { recursive: true });
  if (entry === "directory") await mkdir(join(inner, ".git"));
  else await writeFile(join(inner, ".git"), entry);
  const link = join(root, "cwd-link");
  await symlink(cwd, link);
  expect(await worktreeRoot(link)).toBe(inner);
});

test.each([
  "",
  "not a repository\n",
  "gitdir: \n",
  "gitdir: target\nextra\n",
  "gitdir: target\0\n",
  "symlink",
  "dangling symlink",
])("publish refuses invalid .git entry %j instead of falling through to an outer repository", async (entry) => {
  const inner = join(root, "sub");
  await mkdir(join(root, ".git"));
  await mkdir(inner);
  if (entry === "symlink" || entry === "dangling symlink")
    await symlink(join(root, entry === "symlink" ? ".git" : "missing"), join(inner, ".git"));
  else await writeFile(join(inner, ".git"), entry);
  await expect(worktreeRoot(inner)).rejects.toThrow("invalid repository entry");
});

test("publish finds an outer repository through directories without .git", async () => {
  const cwd = join(root, "nested/deeper");
  await mkdir(cwd, { recursive: true });
  await mkdir(join(root, ".git"));
  expect(await worktreeRoot(cwd)).toBe(root);
});

test("publish returns null only after checking every ancestor, including the filesystem root", async () => {
  expect(await worktreeRoot(root)).toBeNull();
  const expected: string[] = [];
  for (let directory = root; ; directory = dirname(directory)) {
    expected.push(join(directory, ".git"));
    if (directory === dirname(directory)) break;
  }
  expect(vi.mocked(lstat).mock.calls.map(([entry]) => String(entry))).toEqual(expected);
});
