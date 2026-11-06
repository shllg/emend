import { lstat, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { afterEach, beforeEach, expect, onTestFinished, test, vi } from "vitest";
import type { CliRuntime } from "./runtime.ts";
import { repositoryRoots, runtimeInRepository } from "./runtime-repository.ts";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});
afterEach(() => vi.restoreAllMocks());

async function gitDirectory(directory: string) {
  const git = join(directory, ".git");
  await mkdir(join(git, "objects"), { recursive: true });
  await mkdir(join(git, "refs"));
  await writeFile(join(git, "HEAD"), "ref: refs/heads/main\n");
}

let root: string;
let repo: string;
let cwd: string;
let noHome: string;
let runtime: CliRuntime;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(process.env.EMEND_HOME as string, "runtime-repository-")));
  noHome = join(root, "no-home");
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(lstat)
    .mockReset()
    .mockImplementation(async (...args) => {
      const entry = String(args[0]);
      // Only synthetic repositories belong to this fixture.
      if (entry.endsWith(`${sep}.git`) && !entry.startsWith(`${root}${sep}`))
        throw Object.assign(new Error("no synthetic repository entry"), { code: "ENOENT" });
      return actual.lstat(...args);
    });
  repo = join(root, "repo");
  cwd = join(repo, "nested");
  await mkdir(cwd, { recursive: true });
  await gitDirectory(repo);
  const install = join(root, "repo-install");
  await mkdir(install);
  runtime = { node: join(install, "node"), entry: join(install, "emend.mjs") };
  await writeFile(runtime.node, "synthetic node");
  await writeFile(runtime.entry, "synthetic entry");
});

test.each([
  { key: "node", linked: false },
  { key: "node", linked: true },
  { key: "entry", linked: false },
  { key: "entry", linked: true },
] as const)("finds $key resolved inside the repository (symlink=$linked)", async ({ key, linked }) => {
  const path = join(repo, key);
  await writeFile(path, "synthetic runtime");
  if (linked) {
    const link = join(root, `${key}-link`);
    await symlink(path, link);
    runtime[key] = link;
  } else runtime[key] = path;
  expect(await runtimeInRepository(runtime, cwd, noHome)).toBe(path);
});

test("allows both runtime paths outside, including a sibling with the repository prefix", async () => {
  expect(await runtimeInRepository(runtime, cwd, noHome)).toBeNull();
});

test.each(["missing", "non-directory"])("a %s home still checks cwd inside and outside a repository", async (kind) => {
  const parent = join(root, "unavailable");
  if (kind === "non-directory") await writeFile(parent, "synthetic file");
  const home = join(parent, "home");
  expect(await runtimeInRepository(runtime, cwd, home)).toBeNull();
  runtime.entry = join(repo, "emend.mjs");
  await writeFile(runtime.entry, "synthetic entry");
  expect(await runtimeInRepository(runtime, cwd, home)).toBe(runtime.entry);
  const outside = join(root, "outside");
  await mkdir(outside);
  expect(await runtimeInRepository(runtime, outside, home)).toBeNull();
});

test.each(["EACCES", "EPERM", "ELOOP"])("a home realpath failure with %s still fails closed", async (code) => {
  const home = join(root, "blocked-home");
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const error = Object.assign(new Error("synthetic home failure"), { code });
  vi.spyOn(await import("node:fs/promises"), "realpath").mockImplementation(async (...args) => {
    if (args[0] === home) throw error;
    return actual.realpath(...args);
  });
  await expect(runtimeInRepository(runtime, cwd, home)).rejects.toBe(error);
});

test.each(["missing", "non-directory"])("a %s home inside the repository grants no runtime exemption", async (kind) => {
  const parent = join(repo, "unavailable");
  if (kind === "non-directory") await writeFile(parent, "synthetic file");
  runtime.entry = join(repo, "emend.mjs");
  await writeFile(runtime.entry, "synthetic entry");
  expect(await runtimeInRepository(runtime, cwd, join(parent, "home"))).toBe(runtime.entry);
});

test("ignores a dotfiles repository whose root equals the resolved home folder", async () => {
  const home = join(root, "home-link");
  await symlink(repo, home);
  runtime.node = join(repo, "node");
  await writeFile(runtime.node, "synthetic node");
  expect(await runtimeInRepository(runtime, cwd, home)).toBeNull();
});

test.each([".home", "nested/home"])(
  "a home folder at %s inside the repository grants no runtime exemption",
  async (path) => {
    const home = join(repo, path);
    await mkdir(home, { recursive: true });
    runtime.node = join(repo, "node");
    await writeFile(runtime.node, "synthetic node");
    expect(await runtimeInRepository(runtime, cwd, home)).toBe(runtime.node);
  },
);

test("a relative HOME grants no runtime exemption", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.spyOn(await import("node:fs/promises"), "realpath").mockImplementation(async (...args) => {
    if (args[0] === ".") return repo;
    return actual.realpath(...args);
  });
  runtime.entry = join(repo, "emend.mjs");
  await writeFile(runtime.entry, "synthetic entry");
  expect(await runtimeInRepository(runtime, cwd, ".")).toBe(runtime.entry);
  expect(realpath).not.toHaveBeenCalledWith(".");
});

test("a repository below the resolved home still refuses its own runtime", async () => {
  const home = join(root, "home-link");
  await symlink(root, home);
  await gitDirectory(root);
  runtime.entry = join(repo, "emend.mjs");
  await writeFile(runtime.entry, "synthetic entry");
  expect(await runtimeInRepository(runtime, cwd, home)).toBe(runtime.entry);
});

test("resolves a symlinked working directory before looking for repositories", async () => {
  const link = join(root, "cwd-link");
  await symlink(cwd, link);
  runtime.entry = join(repo, "emend.mjs");
  await writeFile(runtime.entry, "synthetic entry");
  expect(await runtimeInRepository(runtime, link, noHome)).toBe(runtime.entry);
});

test.each(["node", "entry"] as const)("allows %s inside cwd when there is no repository", async (key) => {
  cwd = join(root, "plain");
  await mkdir(cwd);
  runtime[key] = join(cwd, key);
  await writeFile(runtime[key], "synthetic runtime");
  expect(await runtimeInRepository(runtime, cwd, noHome)).toBeNull();
});

for (const nested of ["sub", ".worktrees/feat"]) {
  test.each(["node", "entry"] as const)(`from ${nested}, finds %s inside the outer repository`, async (key) => {
    const inner = join(repo, nested);
    cwd = join(inner, "nested");
    await mkdir(cwd, { recursive: true });
    if (nested === "sub") await gitDirectory(inner);
    else {
      await mkdir(join(repo, ".git/worktrees/feat"), { recursive: true });
      await writeFile(join(inner, ".git"), "gitdir: ../../.git/worktrees/feat\n");
    }
    const link = join(root, "cwd-link");
    await symlink(cwd, link);
    runtime[key] = join(repo, key);
    await writeFile(runtime[key], "synthetic runtime");
    expect(await runtimeInRepository(runtime, link, noHome)).toBe(runtime[key]);
  });
}

test("an empty .git above a repository does not count, while the repository still does", async () => {
  await mkdir(join(root, ".git"));
  expect(await repositoryRoots(cwd, noHome)).toEqual([repo]);
  expect(await runtimeInRepository(runtime, cwd, noHome)).toBeNull();
});

test("a .git folder with HEAD, objects and refs counts", async () => {
  expect(await repositoryRoots(cwd, noHome)).toEqual([repo]);
});

test.each(["empty", "hooks and config", "objects and refs"])(
  "a .git folder with %s but no HEAD does not count",
  async (kind) => {
    const git = join(repo, ".git");
    await rm(git, { recursive: true });
    await mkdir(git);
    if (kind === "hooks and config") {
      await mkdir(join(git, "hooks"));
      await writeFile(join(git, "config"), "[core]\nrepositoryformatversion = 0\n");
    } else if (kind === "objects and refs") {
      await mkdir(join(git, "objects"));
      await mkdir(join(git, "refs"));
    }
    expect(await repositoryRoots(cwd, noHome)).toEqual([]);
  },
);

test.each(["objects", "refs"])("a .git folder with HEAD counts without %s", async (entry) => {
  await rm(join(repo, ".git", entry), { recursive: true });
  expect(await repositoryRoots(cwd, noHome)).toEqual([repo]);
});

test("a .git folder with HEAD counts when objects is a dangling symlink", async () => {
  await rm(join(repo, ".git/objects"), { recursive: true });
  await symlink("missing-objects", join(repo, ".git/objects"));
  expect(await repositoryRoots(cwd, noHome)).toEqual([repo]);
});

test("a commondir layout counts and refuses its own runtime", async () => {
  const git = join(repo, ".git");
  const common = join(git, "common");
  await mkdir(common);
  await rename(join(git, "objects"), join(common, "objects"));
  await rename(join(git, "refs"), join(common, "refs"));
  await writeFile(join(common, "config"), "[core]\nrepositoryformatversion = 0\n");
  await writeFile(join(git, "commondir"), "common");
  runtime.entry = join(repo, "emend.mjs");
  await writeFile(runtime.entry, "synthetic entry");
  expect(await repositoryRoots(cwd, noHome)).toEqual([repo]);
  expect(await runtimeInRepository(runtime, cwd, noHome)).toBe(runtime.entry);
});

test("a valid gitfile counts", async () => {
  await rm(join(repo, ".git"), { recursive: true });
  await writeFile(join(repo, ".git"), "gitdir: ../git-data\n");
  expect(await repositoryRoots(cwd, noHome)).toEqual([repo]);
});

test.each(["not a repository\n", ""])("an invalid gitfile refuses discovery: %j", async (content) => {
  await rm(join(repo, ".git"), { recursive: true });
  await writeFile(join(repo, ".git"), content);
  await expect(repositoryRoots(cwd, noHome)).rejects.toThrow("invalid repository entry");
});

test.each(["directory", "file"])("a .git symlink to a %s refuses discovery", async (kind) => {
  const target = join(root, "git-data");
  if (kind === "directory") await rename(join(repo, ".git"), target);
  else {
    await rm(join(repo, ".git"), { recursive: true });
    await writeFile(target, "gitdir: ../git-data\n");
  }
  await symlink(target, join(repo, ".git"));
  await expect(repositoryRoots(cwd, noHome)).rejects.toThrow("invalid repository entry");
});

test("a symlink HEAD counts without following its target", async () => {
  await rm(join(repo, ".git/HEAD"));
  await symlink("refs/heads/main", join(repo, ".git/HEAD"));
  expect(await repositoryRoots(cwd, noHome)).toEqual([repo]);
});

test("a dangling .git symlink refuses discovery", async () => {
  await rm(join(repo, ".git"), { recursive: true });
  await symlink("missing", join(repo, ".git"));
  await expect(repositoryRoots(cwd, noHome)).rejects.toThrow("invalid repository entry");
});

test("a looping .git symlink refuses discovery", async () => {
  await rm(join(repo, ".git"), { recursive: true });
  await symlink(".git", join(repo, ".git"));
  await expect(repositoryRoots(cwd, noHome)).rejects.toThrow("invalid repository entry");
});

test.each(["HEAD", "objects", "refs"])("an unexpected type for %s in a real .git directory counts", async (entry) => {
  const path = join(repo, ".git", entry);
  await rm(path, { recursive: true });
  if (entry === "HEAD") await mkdir(path);
  else await writeFile(path, "unexpected file");
  expect(await repositoryRoots(cwd, noHome)).toEqual([repo]);
});

test.each(["ENOENT", "ENOTDIR"])("a .git lookup failing with %s does not count", async (code) => {
  const read = vi.mocked(lstat).getMockImplementation();
  if (!read) throw new Error("missing fixture lstat");
  vi.mocked(lstat).mockImplementation(async (...args) => {
    if (args[0] === join(repo, ".git")) throw Object.assign(new Error("synthetic missing entry"), { code });
    return read(...args);
  });
  expect(await repositoryRoots(cwd, noHome)).toEqual([]);
});

test.each(["cwd", "node", "entry"] as const)("propagates a %s realpath failure", async (key) => {
  const missing = join(root, "missing");
  if (key === "cwd") cwd = missing;
  else runtime[key] = missing;
  await expect(runtimeInRepository(runtime, cwd, noHome)).rejects.toMatchObject({ code: "ENOENT" });
});

test("an unreadable .git propagates the permission error", async () => {
  const path = join(repo, ".git");
  const failure = Object.assign(new Error("synthetic permission failure"), { code: "EACCES" });
  const read = vi.mocked(lstat).getMockImplementation();
  if (!read) throw new Error("missing fixture lstat");
  vi.mocked(lstat).mockImplementation(async (...args) => {
    if (args[0] === path) throw failure;
    return read(...args);
  });
  await expect(repositoryRoots(cwd, noHome)).rejects.toBe(failure);
  expect(lstat).toHaveBeenCalledWith(path);
});

test.each(["EACCES", "EPERM", "ENOTDIR"])(
  "a HEAD lookup failing with %s still counts as a repository",
  async (code) => {
    const path = join(repo, ".git/HEAD");
    const read = vi.mocked(lstat).getMockImplementation();
    if (!read) throw new Error("missing fixture lstat");
    vi.mocked(lstat).mockImplementation(async (...args) => {
      if (args[0] === path) throw Object.assign(new Error("synthetic HEAD failure"), { code });
      return read(...args);
    });
    expect(await repositoryRoots(cwd, noHome)).toEqual([repo]);
    expect(lstat).toHaveBeenCalledWith(path);
  },
);
