import { spawn } from "node:child_process";
import { access, lstat, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { delimiter, join, relative, sep } from "node:path";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { filterExecutablePath, findExecutable } from "./executable.ts";

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

async function fallbackGit(root: string) {
  const directory = join(root, "fallback");
  await mkdir(directory);
  await writeFile(join(directory, "git"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  return directory;
}

async function fixture() {
  const parent = await realpath(await mkdtemp(join(process.env.EMEND_HOME as string, "executables-")));
  const root = join(parent, "fixture");
  await mkdir(root);
  onTestFinished(() => rm(parent, { recursive: true, force: true }));
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(lstat)
    .mockReset()
    .mockImplementation(async (...args) => {
      const path = String(args[0]);
      // Only synthetic repositories belong to this fixture.
      if (path.endsWith(`${sep}.git`) && !path.startsWith(`${parent}${sep}`))
        throw Object.assign(new Error("no synthetic repository entry"), { code: "ENOENT" });
      return actual.lstat(...args);
    });
  const home = join(root, "home");
  const cwd = join(home, "repo");
  const bin = join(cwd, "bin");
  const outside = join(home, "tools");
  await mkdir(bin, { recursive: true });
  await gitDirectory(cwd);
  await mkdir(outside);
  const marker = join(root, "ran");
  await writeFile(join(bin, "git"), `#!/bin/sh\nprintf ran > '${marker.replaceAll("'", "'\\''")}'\n`, { mode: 0o700 });
  await writeFile(join(outside, "helper"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  return { parent, root, cwd, home, bin, outside, marker };
}

test("repository bin/git is skipped in favor of system git and never runs", async () => {
  const f = await fixture();
  const system = await findExecutable("git", ["/usr/bin", "/bin"].join(delimiter), f);
  const found = await findExecutable("git", [f.bin, system.path].join(delimiter), f);
  expect(found.file).toBe(system.file);
  expect(found.path.split(delimiter)).not.toContain(f.bin);
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(found.file, ["--version"], {
      cwd: f.cwd,
      stdio: "ignore",
      env: { PATH: found.path, HOME: f.home, LC_ALL: "C" },
    });
    child.once("error", reject);
    child.once("close", resolve);
  });
  expect(code).toBe(0);
  await expect(access(f.marker)).rejects.toMatchObject({ code: "ENOENT" });
});

test.each(["directory", "symlinked-directory", "symlinked-file"])(
  "only a %s inside the repository gives a clear refusal",
  async (kind) => {
    const f = await fixture();
    let path = f.bin;
    if (kind === "symlinked-directory") {
      path = join(f.root, "linked-bin");
      await symlink(f.bin, path);
    } else if (kind === "symlinked-file") {
      path = f.outside;
      await symlink(join(f.bin, "git"), join(path, "git"));
    }
    await expect(findExecutable("git", path, f)).rejects.toThrow(
      "git on PATH sits inside the current repository; emend does not run it.",
    );
    await expect(access(f.marker)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test("an outside PATH entry still works", async () => {
  const f = await fixture();
  expect(await findExecutable("helper", f.outside, f)).toEqual({ file: join(f.outside, "helper"), path: f.outside });
});

test("a commondir repository refuses its own helper", async () => {
  const f = await fixture();
  const git = join(f.cwd, ".git");
  const common = join(git, "common");
  await mkdir(common);
  await rename(join(git, "objects"), join(common, "objects"));
  await rename(join(git, "refs"), join(common, "refs"));
  await writeFile(join(common, "config"), "[core]\nrepositoryformatversion = 0\n");
  await writeFile(join(git, "commondir"), "common");
  await expect(findExecutable("git", f.bin, f)).rejects.toThrow(
    "git on PATH sits inside the current repository; emend does not run it.",
  );
});

test("a relative helper link through .. into a repository is skipped for the next helper", async () => {
  const f = await fixture();
  const entry = join(f.home, "outside/bin");
  await mkdir(entry, { recursive: true });
  await symlink("../../repo/bin/git", join(entry, "git"));
  const next = await fallbackGit(f.root);
  expect(await findExecutable("git", [entry, next].join(delimiter), f)).toEqual({
    file: join(next, "git"),
    path: next,
  });
});

test.each(["missing", "not executable"])(
  "a helper link to a %s repository target drops its PATH entry",
  async (kind) => {
    const f = await fixture();
    const target = join(f.bin, "restricted");
    if (kind === "not executable") await writeFile(target, "synthetic helper\n", { mode: 0o600 });
    await symlink(target, join(f.outside, "git"));
    const next = await fallbackGit(f.root);
    expect(await findExecutable("git", [f.outside, next].join(delimiter), f)).toEqual({
      file: join(next, "git"),
      path: next,
    });
    await expect(findExecutable("git", f.outside, f)).rejects.toThrow(
      "git on PATH sits inside the current repository; emend does not run it.",
    );
  },
);

test.each(["loop (walk)", "EACCES on the helper", "EPERM on the helper", "EACCES in the walk"])(
  "a helper that cannot be checked (%s) drops its PATH entry",
  async (kind) => {
    const f = await fixture();
    const file = join(f.outside, "git");
    if (kind === "loop (walk)") await symlink("git", file);
    else {
      const blocked = kind === "EACCES in the walk" ? join(f.outside, "deeper") : file;
      if (kind === "EACCES in the walk") {
        await mkdir(blocked);
        const target = join(blocked, "git");
        await writeFile(target, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
        await symlink(target, file);
      } else await writeFile(file, "synthetic helper\n", { mode: 0o600 });
      const read = vi.mocked(lstat).getMockImplementation();
      if (!read) throw new Error("missing fixture lstat");
      vi.mocked(lstat).mockImplementation(async (...args) => {
        if (args[0] === blocked)
          throw Object.assign(new Error("synthetic helper failure"), {
            code: kind === "EPERM on the helper" ? "EPERM" : "EACCES",
          });
        return read(...args);
      });
    }
    const next = await fallbackGit(f.root);
    expect(await findExecutable("git", [f.outside, next].join(delimiter), f)).toEqual({
      file: join(next, "git"),
      path: next,
    });
  },
);

test.each(["ENOENT", "ENOTDIR"])("an entry without the helper (%s) stays on the child PATH", async (code) => {
  const f = await fixture();
  if (code === "ENOTDIR") {
    const read = vi.mocked(lstat).getMockImplementation();
    if (!read) throw new Error("missing fixture lstat");
    vi.mocked(lstat).mockImplementation(async (...args) => {
      if (args[0] === join(f.outside, "git")) throw Object.assign(new Error("synthetic missing helper"), { code });
      return read(...args);
    });
  }
  const next = await fallbackGit(f.root);
  const path = [f.outside, next].join(delimiter);
  expect(await findExecutable("git", path, f)).toEqual({ file: join(next, "git"), path });
});

test.each(["folder", "not executable", "dangling link"])(
  "a safe %s is no match but stays on the child PATH",
  async (kind) => {
    const f = await fixture();
    const file = join(f.outside, "git");
    if (kind === "folder") await mkdir(file);
    else if (kind === "not executable") await writeFile(file, "synthetic helper\n", { mode: 0o600 });
    else await symlink(join(f.root, "missing"), file);
    const next = await fallbackGit(f.root);
    const path = [f.outside, next].join(delimiter);
    expect(await findExecutable("git", path, f)).toEqual({ file: join(next, "git"), path });
  },
);

test("an empty .git in the fixture parent does not hide a safe helper", async () => {
  const f = await fixture();
  await mkdir(join(f.parent, ".git"));
  expect(await findExecutable("helper", f.outside, f)).toEqual({ file: join(f.outside, "helper"), path: f.outside });
  await expect(findExecutable("git", f.bin, f)).rejects.toThrow(
    "git on PATH sits inside the current repository; emend does not run it.",
  );
});

test("an outside user symlink keeps its original executable and PATH spelling", async () => {
  const f = await fixture();
  const path = join(f.root, "user-tools");
  await symlink(f.outside, path);
  expect(await findExecutable("helper", path, f)).toEqual({ file: join(path, "helper"), path });
});

test.each(["absolute", "relative"])(
  "a symlink chain with %s targets through the repository is skipped",
  async (kind) => {
    const f = await fixture();
    const middle = join(f.cwd, "tools");
    const entry = join(f.root, "tools");
    await symlink(kind === "absolute" ? "/usr/bin" : relative(f.cwd, "/usr/bin"), middle);
    await symlink(kind === "absolute" ? middle : relative(f.root, middle), entry);
    await expect(findExecutable("git", entry, f)).rejects.toThrow(
      "git on PATH sits inside the current repository; emend does not run it.",
    );
    expect(await findExecutable("git", [entry, "/usr/bin"].join(delimiter), f)).toEqual(
      await findExecutable("git", "/usr/bin", f),
    );
  },
);

test.each(["absolute", "relative"])(
  "an executable chain with %s targets through the repository is skipped",
  async (kind) => {
    const f = await fixture();
    const middle = join(f.cwd, "git-link");
    await symlink(kind === "absolute" ? "/usr/bin/git" : relative(f.cwd, "/usr/bin/git"), middle);
    await symlink(kind === "absolute" ? middle : relative(f.outside, middle), join(f.outside, "git"));
    await expect(findExecutable("git", f.outside, f)).rejects.toThrow(
      "git on PATH sits inside the current repository; emend does not run it.",
    );
    expect(await findExecutable("git", [f.outside, "/usr/bin"].join(delimiter), f)).toEqual(
      await findExecutable("git", "/usr/bin", f),
    );
  },
);

test("a non-link component is checked again after realpath canonicalizes its case", async () => {
  const f = await fixture();
  const alias = join(f.home, "Repo");
  const entry = join(alias, "bin");
  await mkdir(entry, { recursive: true });
  await symlink(join(f.outside, "helper"), join(entry, "helper"));
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.spyOn(await import("node:fs/promises"), "realpath").mockImplementation(async (...args) => {
    if (args[0] === alias) return f.cwd;
    return actual.realpath(...args);
  });
  await expect(findExecutable("helper", entry, f)).rejects.toThrow(
    "helper on PATH sits inside the current repository; emend does not run it.",
  );
  expect(await findExecutable("helper", [entry, f.outside].join(delimiter), f)).toEqual({
    file: join(f.outside, "helper"),
    path: f.outside,
  });
});

test.each(["dot", "parent"])("a PATH entry with a %s component is untrusted", async (kind) => {
  const f = await fixture();
  await mkdir(join(f.home, "spare"));
  const entry = kind === "dot" ? `${f.home}/./tools` : `${f.home}/spare/../tools`;
  await expect(findExecutable("helper", entry, f)).rejects.toThrow();
  expect(await findExecutable("helper", [entry, f.outside].join(delimiter), f)).toEqual({
    file: join(f.outside, "helper"),
    path: f.outside,
  });
});

test("a PATH entry with .. is ignored", async () => {
  const f = await fixture();
  const safe = join(f.root, "safe2");
  const out = join(f.root, "out");
  await mkdir(join(safe, "tools"), { recursive: true });
  await mkdir(join(f.root, "tools"));
  await mkdir(out);
  await symlink(out, join(safe, "link"));
  for (const folder of [safe, f.root])
    await writeFile(join(folder, "tools/helper"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const entry = `${safe}/link/../tools`;
  await expect(findExecutable("helper", entry, f)).rejects.toThrow();
  expect(await findExecutable("helper", [entry, f.outside].join(delimiter), f)).toEqual({
    file: join(f.outside, "helper"),
    path: f.outside,
  });
});

test("an outside relative symlink chain keeps its original executable and PATH spelling", async () => {
  const f = await fixture();
  const middle = join(f.root, "middle");
  const entry = join(f.root, "tools");
  await symlink(relative(f.root, f.outside), middle);
  await symlink("middle", entry);
  expect(await findExecutable("helper", entry, f)).toEqual({ file: join(entry, "helper"), path: entry });
});

test("a symlink loop is not a trusted PATH entry", async () => {
  const f = await fixture();
  const entry = join(f.root, "tools");
  await symlink("other-tools", entry);
  await symlink("tools", join(f.root, "other-tools"));
  await expect(findExecutable("helper", entry, f)).rejects.toThrow();
  expect(await findExecutable("helper", [entry, f.outside].join(delimiter), f)).toEqual({
    file: join(f.outside, "helper"),
    path: f.outside,
  });
});

test.each([39, 41])("a non-looping chain of %i links respects the whole-walk limit", async (count) => {
  const f = await fixture();
  for (let i = 0; i < count; i++)
    await symlink(i + 1 === count ? f.outside : `link-${i + 1}`, join(f.root, `link-${i}`));
  const entry = join(f.root, "link-0");
  if (count === 39)
    expect(await findExecutable("helper", entry, f)).toEqual({ file: join(entry, "helper"), path: entry });
  else {
    await expect(findExecutable("helper", entry, f)).rejects.toThrow();
    expect(await findExecutable("helper", [entry, f.outside].join(delimiter), f)).toEqual({
      file: join(f.outside, "helper"),
      path: f.outside,
    });
  }
});

test.each([false, true])("a repository tools symlink to /usr/bin is skipped (fallback=%s)", async (fallback) => {
  const f = await fixture();
  const path = join(f.cwd, "tools");
  await symlink("/usr/bin", path);
  if (fallback) {
    const system = await findExecutable("git", "/usr/bin", f);
    expect(await findExecutable("git", [path, "/usr/bin"].join(delimiter), f)).toEqual(system);
  } else
    await expect(findExecutable("git", path, f)).rejects.toThrow(
      "git on PATH sits inside the current repository; emend does not run it.",
    );
});

test.each(["repository", "parent"])("a deeper PATH component through a linked %s is skipped", async (kind) => {
  const f = await fixture();
  await symlink("/usr/bin", join(f.cwd, "tools"));
  const link = join(f.root, "user-link");
  await symlink(kind === "repository" ? f.cwd : f.home, link);
  const path = kind === "repository" ? join(link, "tools") : join(link, "repo", "tools");
  await expect(findExecutable("git", path, f)).rejects.toThrow(
    "git on PATH sits inside the current repository; emend does not run it.",
  );
});

test("a dotfiles repository at home does not block installed helpers", async () => {
  const f = await fixture();
  await gitDirectory(f.home);
  expect(await findExecutable("helper", f.outside, f)).toEqual({ file: join(f.outside, "helper"), path: f.outside });
});

test.each(["missing", "non-directory"])(
  "a %s home permits outside helpers and still refuses repository helpers",
  async (kind) => {
    const f = await fixture();
    const parent = join(f.root, "unavailable");
    if (kind === "non-directory") await writeFile(parent, "synthetic file");
    f.home = join(parent, "home");
    expect(await findExecutable("helper", f.outside, f)).toEqual({ file: join(f.outside, "helper"), path: f.outside });
    await expect(findExecutable("git", f.bin, f)).rejects.toThrow(
      "git on PATH sits inside the current repository; emend does not run it.",
    );
  },
);

test("an unresolved cwd fails closed for helpers", async () => {
  const f = await fixture();
  f.cwd = join(f.root, "missing");
  await expect(findExecutable("helper", f.outside, f)).rejects.toThrow();
});

test("an invalid repository entry fails closed before resolving helpers", async () => {
  const f = await fixture();
  await rm(join(f.cwd, ".git"), { recursive: true });
  await symlink(".git", join(f.cwd, ".git"));
  await expect(findExecutable("git", f.bin, f)).rejects.toThrow(
    "Could not check where git on PATH runs; emend does not run it.",
  );
  await expect(findExecutable("helper", f.outside, f)).rejects.toThrow(
    "Could not check where helper on PATH runs; emend does not run it.",
  );
});

test.each(["missing", "non-directory"])("a %s home inside the repository grants no helper exemption", async (kind) => {
  const f = await fixture();
  const parent = join(f.cwd, "unavailable");
  if (kind === "non-directory") await writeFile(parent, "synthetic file");
  f.home = join(parent, "home");
  await expect(findExecutable("git", f.bin, f)).rejects.toThrow(
    "git on PATH sits inside the current repository; emend does not run it.",
  );
});

test("a relative HOME grants no helper exemption", async () => {
  const f = await fixture();
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.spyOn(await import("node:fs/promises"), "realpath").mockImplementation(async (...args) => {
    if (args[0] === ".") return f.cwd;
    return actual.realpath(...args);
  });
  await expect(findExecutable("git", f.bin, { ...f, home: "." })).rejects.toThrow(
    "git on PATH sits inside the current repository; emend does not run it.",
  );
  expect(realpath).not.toHaveBeenCalledWith(".");
});

test("an existing home inside the repository grants no helper exemption", async () => {
  const f = await fixture();
  const home = join(f.cwd, ".home");
  await mkdir(home);
  await expect(findExecutable("git", f.bin, { ...f, home })).rejects.toThrow(
    "git on PATH sits inside the current repository; emend does not run it.",
  );
});

test.each([
  ["a trailing slash", (dir: string) => `${dir}${sep}`],
  ["a doubled slash", (dir: string) => dir.replace(/bin$/, `${sep}bin`)],
])("a PATH entry with %s is found and stays on the child PATH", async (_label, spell) => {
  const f = await fixture();
  const dir = join(f.home, "x", "bin");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "helper"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const entry = spell(dir);
  expect(entry).not.toBe(dir);
  const found = await findExecutable("helper", entry, f);
  expect(found.file).toBe(join(dir, "helper"));
  expect(found.path).toBe(entry);
});

test.each(["x/./bin", "x/../x/bin"])("a PATH entry with a %s part is rejected", async (tail) => {
  const f = await fixture();
  const dir = join(f.home, "x", "bin");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "helper"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const entry = `${f.home}${sep}${tail}`;
  await expect(findExecutable("helper", entry, f)).rejects.toThrow("helper was not found on PATH");
  await expect(findExecutable("helper", [entry, f.outside].join(delimiter), f)).resolves.toEqual({
    file: join(f.outside, "helper"),
    path: f.outside,
  });
});

test.each(["node", "npm", "systemctl"])("extra %s repository links drop the whole PATH entry", async (name) => {
  const f = await fixture();
  await symlink(join(f.bin, "git"), join(f.outside, name));
  const next = await fallbackGit(f.root);
  expect(await filterExecutablePath(["node", "npm", "systemctl"], [f.outside, next].join(delimiter), [f.cwd])).toBe(
    next,
  );
});

test("absent extra names preserve a safe PATH entry", async () => {
  const f = await fixture();
  expect(await filterExecutablePath(["node", "npm", "systemctl"], f.outside, [f.cwd])).toBe(f.outside);
});

test.each(["loop", "EACCES"])("an uncheckable extra name (%s) drops the PATH entry", async (kind) => {
  const f = await fixture();
  const file = join(f.outside, "node");
  if (kind === "loop") await symlink("node", file);
  else {
    const read = vi.mocked(lstat).getMockImplementation();
    if (!read) throw new Error("missing fixture lstat");
    vi.mocked(lstat).mockImplementation(async (...args) => {
      if (args[0] === file) throw Object.assign(new Error("synthetic failure"), { code: "EACCES" });
      return read(...args);
    });
  }
  expect(await filterExecutablePath(["node"], f.outside, [f.cwd])).toBe("");
});
