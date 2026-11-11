import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { promisify } from "node:util";
import { expect, onTestFinished, test, vi } from "vitest";
import { type Io, run } from "../../main.ts";
import { readDocRoots } from "../config.ts";
import { escapeReference, quoteShellArgument } from "../escape.ts";
import * as reader from "./read.ts";
import { publishContext, resolvePublish } from "./resolve.ts";
import * as roots from "./root.ts";

const { git } = vi.hoisted(() => ({ git: vi.fn() }));
vi.mock("node:os", async (original) => ({ ...(await original<typeof import("node:os")>()) }));
vi.mock("../git.ts", async (original) => ({
  ...(await original<typeof import("../git.ts")>()),
  createGitSession: () => git,
}));

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "emend-publish-roots-")));
  const repo = join(root, "repo");
  const stateParent = join(root, "data");
  const state = join(stateParent, "state");
  const configHome = join(root, "config");
  const configDir = join(configHome, "emend");
  const homeParent = join(root, "homes");
  const home = join(homeParent, "reviewer");
  const accountParent = join(root, "accounts");
  const account = join(accountParent, "reviewer");
  const docs = join(root, "docs");
  for (const folder of [join(repo, ".git"), state, home, account, docs]) {
    await mkdir(folder, { recursive: true, mode: 0o700 });
  }
  await writeFile(join(repo, "plan.md"), "# Synthetic worktree doc");
  vi.spyOn(os, "homedir").mockReturnValue(home);
  vi.spyOn(os, "userInfo").mockReturnValue({
    homedir: account,
    username: "synthetic",
    uid: 1000,
    gid: 1000,
    shell: null,
  });
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(repo);
  git.mockReset().mockImplementation(async (cwd: string, call: string[]) => {
    const root = await roots.worktreeRoot(cwd);
    if (!root) throw new Error("missing synthetic repository");
    return Buffer.from(call[1] === "--git-common-dir" ? join(root, ".git") : root);
  });
  const reads = vi.spyOn(reader, "readRegular");
  const fetcher = vi.fn(() => {
    throw new Error("publish must stay local");
  });
  vi.stubGlobal("fetch", fetcher);
  onTestFinished(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const config = join(configDir, "config.json");
  const manifest = join(repo, "review.json");
  async function command(args: string[]) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io: Io = {
      env: { EMEND_HOME: state, XDG_CONFIG_HOME: configHome, HOME: home },
      stdout: (line) => {
        stdout.push(line);
      },
      stderr: (line) => {
        stderr.push(line);
      },
    };
    const code = await run(args, io);
    expect(fetcher).not.toHaveBeenCalled();
    return { code, stdout, stderr };
  }
  return {
    root,
    repo,
    state,
    configDir,
    stateParent,
    home,
    homeParent,
    account,
    accountParent,
    docs,
    config,
    cwd,
    manifest,
    reads,
    command,
    store: (entries: string[]) => writeFile(config, JSON.stringify({ docRoots: entries })),
    async publish(source?: string, code = false) {
      await writeFile(
        manifest,
        JSON.stringify({
          version: 1,
          title: "Synthetic roots review",
          ...(code ? { base: "a".repeat(40), head: "worktree" } : {}),
          topics: [],
          files: [{ path: "plan.md", role: "doc", ...(source ? { source } : {}) }],
          writeup: { overview: "", tldr: "", decisions: null, topics: {} },
        }),
      );
      return command(["publish", "--manifest", manifest, "--key", "roots"]);
    },
  };
}

const refusal = (entry: string, problem: string) => {
  const escaped = escapeReference(entry);
  const quoted = quoteShellArgument(entry);
  return {
    code: 1,
    stdout: [],
    stderr: [`emend: docRoots entry ${escaped} ${problem}; remove it with emend config remove docRoots ${quoted}\n`],
  };
};

for (const code of [false, true]) {
  test.each(["home", "home-parent", "account-home", "account-parent", "state", "state-parent", "state-child"] as const)(
    `${code ? "code" : "docs-only"} publish refuses a %s repository before reading the manifest or running git`,
    async (kind) => {
      const f = await fixture();
      const entry = {
        home: f.home,
        "home-parent": f.homeParent,
        "account-home": f.account,
        "account-parent": f.accountParent,
        state: f.state,
        "state-parent": f.stateParent,
        "state-child": join(f.state, "repo"),
      }[kind];
      const problem = kind.startsWith("state")
        ? "holds or sits inside emend's state folder"
        : "is the home folder or holds it";
      await mkdir(join(entry, ".git"), { recursive: true });
      const cwd = join(entry, "Downloads");
      await mkdir(cwd);
      f.cwd.mockReturnValue(cwd);
      expect(f.home).not.toBe(f.account);
      expect(await f.publish(undefined, code)).toEqual({
        code: 1,
        stdout: [],
        stderr: [`emend: the repository at ${entry} ${problem}, so emend does not publish from it\n`],
      });
      expect(git).not.toHaveBeenCalled();
      expect(f.reads).not.toHaveBeenCalled();
      await expect(stat(join(f.state, "emend.db"))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
}

test("publish refuses a linked-worktree git file at home before running git", async () => {
  const f = await fixture();
  const gitDir = join(f.repo, ".git", "worktrees", "home");
  const entry = join(f.home, ".git");
  const cwd = join(f.home, "Downloads");
  await mkdir(gitDir, { recursive: true });
  await writeFile(entry, `gitdir: ${gitDir}\n`);
  await mkdir(cwd);
  f.cwd.mockReturnValue(cwd);
  expect(await f.publish()).toEqual({
    code: 1,
    stdout: [],
    stderr: [`emend: the repository at ${f.home} is the home folder or holds it, so emend does not publish from it\n`],
  });
  expect(git).not.toHaveBeenCalled();
  expect(f.reads.mock.calls.every(([path]) => path === entry)).toBe(true);
});

test("publish refuses a home repository reached through a symlink before running git", async () => {
  const f = await fixture();
  const cwd = join(f.home, "Downloads");
  const alias = join(f.root, "downloads-link");
  await mkdir(join(f.home, ".git"));
  await mkdir(cwd);
  await symlink(cwd, alias, "dir");
  f.cwd.mockReturnValue(alias);
  expect(await f.publish()).toEqual({
    code: 1,
    stdout: [],
    stderr: [`emend: the repository at ${f.home} is the home folder or holds it, so emend does not publish from it\n`],
  });
  expect(git).not.toHaveBeenCalled();
  expect(f.reads).not.toHaveBeenCalled();
});

test("publish refuses a filesystem-root repository before reading the manifest or running git", async () => {
  const f = await fixture();
  const root = parse(f.root).root;
  vi.spyOn(roots, "worktreeRoot").mockResolvedValue(root);
  expect(await f.publish()).toEqual({
    code: 1,
    stdout: [],
    stderr: [`emend: the repository at ${root} is the filesystem root, so emend does not publish from it\n`],
  });
  expect(git).not.toHaveBeenCalled();
  expect(f.reads).not.toHaveBeenCalled();
});

test("publish escapes a refused repository path on one line", async () => {
  const f = await fixture();
  const home = join(f.root, "reviewer's\n\u001b[31m");
  await mkdir(join(home, ".git"), { recursive: true });
  vi.mocked(os.homedir).mockReturnValue(home);
  f.cwd.mockReturnValue(home);
  const result = await f.publish();
  expect(result).toEqual({
    code: 1,
    stdout: [],
    stderr: [
      `emend: the repository at ${f.root}/reviewer's\\u{a}\\u{1b}[31m is the home folder or holds it, so emend does not publish from it\n`,
    ],
  });
  expect(result.stderr.join("").split("\n")).toHaveLength(2);
  expect(git).not.toHaveBeenCalled();
  expect(f.reads).not.toHaveBeenCalled();
});

test("resolvePublish checks the worktree when no context is supplied", async () => {
  const f = await fixture();
  await mkdir(join(f.home, ".git"));
  await expect(
    resolvePublish(
      {
        version: 1,
        title: "Synthetic roots review",
        topics: [],
        files: [],
        writeup: { overview: "", tldr: "", decisions: null, topics: {} },
      },
      { manifest: f.manifest, key: "roots" },
      f.state,
      f.configDir,
      null,
      f.home,
      () => {},
    ),
  ).rejects.toThrow(`the repository at ${f.home} is the home folder or holds it, so emend does not publish from it`);
  expect(git).not.toHaveBeenCalled();
  expect(f.reads).not.toHaveBeenCalled();
});

test("resolvePublish refuses a repository holding state when no context is supplied", async () => {
  const f = await fixture();
  await mkdir(join(f.stateParent, ".git"));
  await expect(
    resolvePublish(
      {
        version: 1,
        title: "Synthetic roots review",
        topics: [],
        files: [],
        writeup: { overview: "", tldr: "", decisions: null, topics: {} },
      },
      { manifest: f.manifest, key: "roots" },
      f.state,
      f.configDir,
      null,
      f.stateParent,
      () => {},
    ),
  ).rejects.toThrow(
    `the repository at ${f.stateParent} holds or sits inside emend's state folder, so emend does not publish from it`,
  );
  expect(git).not.toHaveBeenCalled();
  expect(f.reads).not.toHaveBeenCalled();
});

test("publishContext preserves an unreadable home error", async () => {
  const f = await fixture();
  const home = join(f.root, "loop");
  await symlink(home, home);
  vi.mocked(os.homedir).mockReturnValue(home);
  await expect(publishContext(f.repo, f.state)).rejects.toThrow(`cannot check docRoots: ${home} cannot be read`);
  expect(git).not.toHaveBeenCalled();
  expect(f.reads).not.toHaveBeenCalled();
});

test.each(["ordinary", "nested"])("publish still accepts the %s repository", async (kind) => {
  const f = await fixture();
  const root = kind === "nested" ? join(f.home, "projects", "repo") : f.repo;
  if (kind === "nested") {
    await mkdir(join(f.home, ".git"));
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, "plan.md"), "# Synthetic nested worktree doc");
  }
  const cwd = join(root, "src");
  await mkdir(cwd);
  f.cwd.mockReturnValue(cwd);
  const result = await f.publish();
  expect(result.code).toBe(0);
  expect(result.stdout).toHaveLength(1);
  expect(JSON.parse(result.stdout.join(""))).toMatchObject({ revision: 1, unrendered: [] });
  expect(git).toHaveBeenCalledWith(cwd, ["rev-parse", "--show-toplevel"]);
  expect(git).toHaveBeenCalledWith(root, ["rev-parse", "--git-common-dir"]);
  expect(f.reads.mock.calls.some(([path]) => path === join(root, "plan.md"))).toBe(true);
});

test.each(["symlink", "filesystem", "home", "home-parent", "state", "state-parent", "state-child", "controls"])(
  "publish refuses a stored %s before reading any doc",
  async (kind) => {
    const f = await fixture();
    let entry = f.docs;
    let problem = "is not a real path";
    if (kind === "symlink" || kind === "controls") {
      entry = join(f.root, kind === "controls" ? "reviewer's\n\u001b[31m" : "alias");
      await symlink(f.docs, entry, "dir");
    } else if (kind === "filesystem") {
      entry = parse(f.root).root;
      problem = "is the filesystem root";
    } else if (kind === "home" || kind === "home-parent") {
      entry = kind === "home" ? f.home : f.homeParent;
      problem = "is the home folder or holds it";
    } else {
      entry = kind === "state-parent" ? f.stateParent : kind === "state-child" ? join(f.state, "nested") : f.state;
      if (kind === "state-child") await mkdir(entry);
      problem = "holds or sits inside emend's state folder";
    }
    await f.store([f.docs, entry]);
    const result = await f.publish();
    expect(result).toEqual(refusal(entry, problem));
    expect(result.stderr.join("").split("\n")).toHaveLength(2);
    expect(f.reads.mock.calls.some(([path]) => path === join(f.repo, "plan.md"))).toBe(false);
    await expect(stat(join(f.state, "emend.db"))).rejects.toMatchObject({ code: "ENOENT" });
    if (kind === "controls") {
      expect(result.stderr).toEqual([
        "emend: docRoots entry " +
          f.root +
          "/reviewer's\\u{a}\\u{1b}[31m is not a real path; remove it with emend config remove docRoots $'" +
          f.root +
          "/reviewer\\'s\\x0a\\x1b[31m'\n",
      ]);
    }
  },
);

test.each(["folder", "filesystem", "home"])(
  "publish refuses a doc root replaced by a symlink to %s",
  async (target) => {
    const f = await fixture();
    await f.store([f.docs]);
    await rm(f.docs, { recursive: true });
    await symlink(target === "filesystem" ? parse(f.root).root : target === "home" ? f.home : f.repo, f.docs, "dir");
    expect(await f.publish()).toEqual(refusal(f.docs, "is not a real path"));
  },
);

test("stored entries are checked in order", async () => {
  const f = await fixture();
  const alias = join(f.root, "alias");
  await symlink(f.docs, alias, "dir");
  const root = parse(f.root).root;
  await f.store([root, alias]);
  expect(await f.publish()).toEqual(refusal(root, "is the filesystem root"));
  await f.store([alias, root]);
  expect(await f.publish()).toEqual(refusal(alias, "is not a real path"));
});

test.each(["symlink", "dot-segment"])(
  "the suggested remove command removes a non-real %s entry literally",
  async (kind) => {
    const f = await fixture();
    const entry = kind === "symlink" ? join(f.root, "alias") : `${f.docs}/.`;
    if (kind === "symlink") await symlink(f.docs, entry, "dir");
    await f.store([entry]);
    expect(await f.publish()).toEqual(refusal(entry, "is not a real path"));
    expect(await f.command(["config", "remove", "docRoots", entry])).toEqual({
      code: 0,
      stdout: [`emend: removed ${entry} from docRoots\n`],
      stderr: [],
    });
    expect(JSON.parse(await readFile(f.config, "utf8")).docRoots).toEqual([]);
  },
);

test.each(["ENOENT", "ENOTDIR"])("publish skips a %s entry and still publishes a worktree doc", async (code) => {
  const f = await fixture();
  const parent = join(f.root, "missing");
  if (code === "ENOTDIR") await writeFile(parent, "Synthetic non-directory");
  const missing = join(parent, "docs");
  await f.store([missing, f.docs]);
  expect(await readDocRoots(f.state, f.configDir, f.root, undefined, f.home, () => f.account)).toEqual([f.docs]);
  const result = await f.publish();
  expect(result.code).toBe(0);
  expect(result.stdout).toHaveLength(1);
  expect(JSON.parse(result.stdout.join(""))).toMatchObject({ revision: 1, unrendered: [] });
});

for (const [name, character, literalEscape, quotedEscape] of [
  ["newline", "\n", "\\u{a}", "\\x0a"],
  ["U+202E", "\u202e", "\\u202E", "\\xe2\\x80\\xae"],
] as const) {
  test(`the printed remove argument under LC_ALL=C selects the ${name} entry and keeps its literal twin`, async ({
    skip,
  }) => {
    const f = await fixture();
    const entry = join(f.root, `a${character}b`);
    const literal = join(f.root, `a${literalEscape}b`);
    await symlink(f.docs, entry, "dir");
    await mkdir(literal);
    await f.store([entry, literal]);
    const result = await f.publish();
    expect(result).toEqual(refusal(entry, "is not a real path"));
    const argument = result.stderr.join("").split("; remove it with emend config remove docRoots ")[1]?.trimEnd();
    expect(argument).toBe(`$'${f.root}/a${quotedEscape}b'`);
    let decoded: string;
    try {
      const result = await promisify(execFile)("bash", ["--norc", "--noprofile", "-c", `printf %s ${argument}`], {
        env: { PATH: process.env.PATH, HOME: f.home, LC_ALL: "C" },
      });
      decoded = result.stdout;
      expect(result.stderr).toBe("");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return skip("bash is not on PATH");
      throw error;
    }
    expect(decoded).toBe(entry);
    expect(await f.command(["config", "remove", "docRoots", decoded])).toEqual({
      code: 0,
      stdout: [`emend: removed ${escapeReference(entry)} from docRoots\n`],
      stderr: [],
    });
    expect(JSON.parse(await readFile(f.config, "utf8")).docRoots).toEqual([literal]);
  });
}

test("a doc beneath a missing stored root still reports doc not found", async () => {
  const f = await fixture();
  const missing = join(f.root, "missing");
  const source = join(missing, "plan.md");
  await f.store([missing]);
  expect(await f.publish(source)).toEqual({
    code: 1,
    stdout: [],
    stderr: [`emend: doc not found: ${source}\n`],
  });
});

test.skipIf(process.getuid?.() === 0)("publish refuses an EACCES entry with its removal command", async () => {
  const f = await fixture();
  const denied = join(f.root, "denied");
  const entry = join(denied, "docs");
  await mkdir(entry, { recursive: true });
  await f.store([entry]);
  await chmod(denied, 0o000);
  try {
    expect(await f.publish()).toEqual(refusal(entry, "cannot be read"));
  } finally {
    await chmod(denied, 0o700);
  }
});

test("publish refuses a symlink loop as unreadable", async () => {
  const f = await fixture();
  const entry = join(f.root, "loop");
  await symlink(entry, entry);
  await f.store([entry]);
  expect(await f.publish()).toEqual(refusal(entry, "cannot be read"));
});

test.skipIf(process.getuid?.() === 0).each(["HOME", "account home"])(
  "config add and publish refuse an unreadable %s before source reads",
  async (kind) => {
    const f = await fixture();
    const parent = kind === "HOME" ? f.homeParent : f.accountParent;
    const folder = kind === "HOME" ? f.home : f.account;
    await f.store([f.docs]);
    const original = await readFile(f.config, "utf8");
    await chmod(parent, 0o000);
    try {
      const expected = {
        code: 1,
        stdout: [],
        stderr: [`emend: cannot check docRoots: ${folder} cannot be read\n`],
      };
      expect(await f.command(["config", "add", "docRoots", f.docs])).toEqual(
        kind === "HOME"
          ? { ...expected, stderr: [`emend: cannot check emend configuration in ${f.config}\n`] }
          : expected,
      );
      expect(await f.publish()).toEqual(expected);
      expect(git).not.toHaveBeenCalled();
      expect(f.reads.mock.calls.some(([path]) => path === f.manifest)).toBe(false);
      expect(await readFile(f.config, "utf8")).toBe(original);
      expect(f.reads.mock.calls.some(([path]) => path === join(f.repo, "plan.md"))).toBe(false);
      await expect(stat(join(f.state, "emend.db"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await chmod(parent, 0o700);
    }
  },
);

test("config add and publish protect the passwd home even when HOME differs", async () => {
  const f = await fixture();
  expect(f.home).not.toBe(f.account);
  expect(await f.command(["config", "add", "docRoots", f.accountParent])).toEqual({
    code: 1,
    stdout: [],
    stderr: ["emend: docRoots cannot be the home folder or hold it\n"],
  });
  await f.store([f.accountParent]);
  expect(await f.publish()).toEqual(refusal(f.accountParent, "is the home folder or holds it"));
});

test("both callers use HOME alone when userInfo throws", async () => {
  const f = await fixture();
  vi.mocked(os.userInfo).mockImplementation(() => {
    throw new Error("no passwd entry");
  });
  expect((await f.command(["config", "add", "docRoots", f.docs])).code).toBe(0);
  expect((await f.publish()).code).toBe(0);
  expect(await f.command(["config", "add", "docRoots", f.homeParent])).toEqual({
    code: 1,
    stdout: [],
    stderr: ["emend: docRoots cannot be the home folder or hold it\n"],
  });
  await f.store([f.homeParent]);
  expect(await f.publish()).toEqual(refusal(f.homeParent, "is the home folder or holds it"));
});
