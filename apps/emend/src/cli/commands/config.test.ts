import * as fs from "node:fs/promises";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { LIMITS } from "@emend/contract";
import { expect, onTestFinished, test, vi } from "vitest";
import { type Io, run } from "../../main.ts";
import * as stateFiles from "../../state/files.ts";
import { readConfig } from "../config.ts";
import { escapeReference } from "../escape.ts";
import { configCommand } from "./config.ts";

vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof import("node:fs/promises")>()) }));
vi.mock("node:os", async (original) => ({ ...(await original<typeof import("node:os")>()) }));

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "emend-config-command-")));
  const home = join(root, "home");
  const stateDir = join(root, "state");
  const configHome = join(root, "config");
  const configDir = join(configHome, "emend");
  const path = join(configDir, "config.json");
  const docs = join(root, "docs");
  await mkdir(docs);
  await mkdir(home);
  vi.spyOn(os, "userInfo").mockReturnValue({ homedir: home, username: "synthetic", uid: 1000, gid: 1000, shell: null });
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.spyOn(process, "cwd").mockReturnValue(root);
  const fetcher = vi.fn(() => {
    throw new Error("config must not contact a server");
  });
  vi.stubGlobal("fetch", fetcher);
  onTestFinished(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    home,
    stateDir,
    configDir,
    path,
    docs,
    async seed(data: string) {
      await mkdir(configDir, { mode: 0o700, recursive: true });
      await writeFile(path, data);
    },
    async run(args: string[] = [], state = stateDir) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const io: Io = {
        env: { EMEND_HOME: state, XDG_CONFIG_HOME: configHome, HOME: home, USERPROFILE: home },
        stdout: (line) => {
          stdout.push(line);
        },
        stderr: (line) => {
          stderr.push(line);
        },
      };
      const code = await run(["config", ...args], io);
      expect(fetcher).not.toHaveBeenCalled();
      return { code, stdout, stderr };
    },
  };
}

const success = (line: string) => ({ code: 0, stdout: [`${line}\n`], stderr: [] });
const failure = (message: string) => ({ code: 1, stdout: [], stderr: [`emend: ${message}\n`] });

test.each([{ args: [] }, { args: ["list"] }])(
  "config $args lists defaults without creating state",
  async ({ args }) => {
    const f = await fixture();
    expect(await f.run(args)).toEqual(success('{"docRoots":[],"openBrowser":false}'));
    await expect(stat(f.stateDir)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test.each([{}, { openBrowser: true }, { docRoots: ["/synthetic/docs"], future: { enabled: true } }])(
  "list always prints exactly the two settings: %j",
  async (document) => {
    const f = await fixture();
    const original = JSON.stringify(document);
    await f.seed(original);
    expect(await f.run(["list"])).toEqual(
      success(JSON.stringify({ docRoots: document.docRoots ?? [], openBrowser: document.openBrowser ?? false })),
    );
    expect(await readFile(f.path, "utf8")).toBe(original);
  },
);

test("add succeeds when the home folder does not exist", async () => {
  const f = await fixture();
  const missing = join(f.root, "nonexistent", "home");
  vi.stubEnv("HOME", missing);
  vi.stubEnv("USERPROFILE", missing);
  expect(await f.run(["add", "docRoots", f.docs])).toEqual(success(`emend: added ${f.docs} to docRoots`));
  expect(await readConfig(f.stateDir, f.configDir)).toEqual({ docRoots: [f.docs], openBrowser: false });
});

test("add resolves relative paths, creates a private config folder and writes readable settings without a server", async () => {
  const f = await fixture();
  expect(await f.run(["add", "docRoots", "./docs"])).toEqual(success(`emend: added ${f.docs} to docRoots`));
  expect(await readConfig(f.stateDir, f.configDir)).toEqual({ docRoots: [f.docs], openBrowser: false });
  expect(await readdir(f.configDir)).toEqual(["config.json"]);
  expect((await stat(f.configDir)).mode & 0o777).toBe(0o700);
  expect((await stat(f.path)).mode & 0o777).toBe(0o600);
});

test("add stores a symlink's real path and duplicates through either spelling leave the file unchanged", async () => {
  const f = await fixture();
  const alias = join(f.root, "alias");
  await symlink(f.docs, alias, "dir");
  expect(await f.run(["add", "docRoots", alias])).toEqual(success(`emend: added ${f.docs} to docRoots`));
  const original = await readFile(f.path, "utf8");
  const before = await stat(f.path);
  for (const folder of [f.docs, alias, "./docs/../alias"]) {
    expect(await f.run(["add", "docRoots", folder])).toEqual(success(`emend: ${f.docs} is already in docRoots`));
    expect(await readFile(f.path, "utf8")).toBe(original);
    const after = await stat(f.path);
    expect([after.ino, after.mtimeMs, after.ctimeMs]).toEqual([before.ino, before.mtimeMs, before.ctimeMs]);
  }
  expect(await readConfig(f.stateDir, f.configDir)).toEqual({ docRoots: [f.docs], openBrowser: false });
});

test.each(["relative", "symlink", "deleted"])("remove matches a %s folder", async (kind) => {
  const f = await fixture();
  const other = join(f.root, "other");
  await f.seed(JSON.stringify({ docRoots: [f.docs, other], openBrowser: true }));
  let path = "./docs";
  if (kind === "symlink") {
    path = join(f.root, "alias");
    await symlink(f.docs, path, "dir");
  } else if (kind === "deleted") await rm(f.docs, { recursive: true });
  expect(await f.run(["remove", "docRoots", path])).toEqual(success(`emend: removed ${f.docs} from docRoots`));
  expect(await readConfig(f.stateDir, f.configDir)).toEqual({ docRoots: [other], openBrowser: true });
});

test("remove matches a listed absolute alias even after its target was deleted", async () => {
  const f = await fixture();
  const alias = join(f.root, "alias");
  await symlink(f.docs, alias, "dir");
  await f.seed(JSON.stringify({ docRoots: [alias] }));
  await rm(f.docs, { recursive: true });
  expect(await f.run(["remove", "docRoots", "./alias"])).toEqual(success(`emend: removed ${alias} from docRoots`));
  expect(await readConfig(f.stateDir, f.configDir)).toEqual({ docRoots: [], openBrowser: false });
});

test("set accepts both boolean values and each invocation reads the latest file", async () => {
  const f = await fixture();
  for (const value of ["true", "false"]) {
    expect(await f.run(["set", "openBrowser", value])).toEqual(success(`emend: openBrowser is now ${value}`));
    expect(await readConfig(f.stateDir, f.configDir)).toEqual({ docRoots: [], openBrowser: value === "true" });
    expect(await f.run()).toEqual(success(`{"docRoots":[],"openBrowser":${value}}`));
  }
});

test.each(["add", "remove", "set"])(
  "%s preserves unknown keys and replaces a permissive file with mode 0600",
  async (action) => {
    const f = await fixture();
    const future = { enabled: true, list: [1, null, "synthetic"] };
    await f.seed(
      JSON.stringify({
        docRoots: action === "remove" ? [f.docs] : [],
        approvedActiveHours: 24,
        future,
        ["__proto__"]: { enabled: false },
      }),
    );
    await chmod(f.path, 0o644);
    const args = action === "set" ? ["set", "openBrowser", "true"] : [action, "docRoots", f.docs];
    expect((await f.run(args)).code).toBe(0);
    const document = JSON.parse(await readFile(f.path, "utf8"));
    expect(document.future).toEqual(future);
    expect(document.approvedActiveHours).toBe(24);
    expect(Object.hasOwn(document, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(document, "__proto__")?.value).toEqual({ enabled: false });
    expect((await stat(f.path)).mode & 0o777).toBe(0o600);
    expect(await readdir(f.configDir)).toEqual(["config.json"]);
    expect(await readConfig(f.stateDir, f.configDir)).toEqual({
      docRoots: action === "add" ? [f.docs] : [],
      openBrowser: action === "set",
    });
  },
);

test.each([
  ["list", "extra"],
  ["get"],
  ["add"],
  ["add", "docRoots"],
  ["add", "docRoots", ""],
  ["add", "openBrowser", "docs"],
  ["add", "docRoots", "docs", "extra"],
  ["remove"],
  ["remove", "docRoots"],
  ["remove", "docRoots", ""],
  ["remove", "other", "docs"],
  ["remove", "docRoots", "docs", "extra"],
  ["set"],
  ["set", "openBrowser"],
  ["set", "docRoots", "true"],
  ["set", "openBrowser", "TRUE"],
  ["set", "openBrowser", "1"],
  ["set", "openBrowser", ""],
  ["set", "openBrowser", "true", "extra"],
  ["--help"],
])("invalid arguments %j print the exact usage with exit 1 and no state", async (...args) => {
  const f = await fixture();
  expect(await f.run(args)).toEqual(
    failure(
      "Usage: emend config [list] | add docRoots <folder> | remove docRoots <folder> | set openBrowser true|false.",
    ),
  );
  await expect(stat(f.stateDir)).rejects.toMatchObject({ code: "ENOENT" });
});

test.each(["missing", "file", "file-child", "root", "root-symlink"])("add refuses %s", async (kind) => {
  const f = await fixture();
  const file = join(f.root, "file");
  await writeFile(file, "synthetic");
  let path = join(f.root, "missing");
  let message = `${path} does not exist`;
  if (kind === "file" || kind === "file-child") {
    path = kind === "file" ? file : join(file, "child");
    message = `${path} is not a folder`;
  } else if (kind === "root" || kind === "root-symlink") {
    path = parse(f.root).root;
    if (kind === "root-symlink") {
      const alias = join(f.root, "alias");
      await symlink(path, alias, "dir");
      path = alias;
    }
    message = "docRoots cannot be the filesystem root";
  }
  expect(await f.run(["add", "docRoots", path])).toEqual(failure(message));
  await expect(stat(f.stateDir)).rejects.toMatchObject({ code: "ENOENT" });
});

test.each(["docs", "missing"])("remove refuses an unlisted %s path without changing state", async (folder) => {
  const f = await fixture();
  const original = '{"docRoots":[],"future":true}\n';
  await f.seed(original);
  expect(await f.run(["remove", "docRoots", folder])).toEqual(failure(`${join(f.root, folder)} is not in docRoots`));
  expect(await readFile(f.path, "utf8")).toBe(original);
});

test("user paths are escaped on success and error lines, while list remains valid JSON", async () => {
  const f = await fixture();
  const docs = join(f.root, "docs\n\u001b[31m\u202e");
  const escaped = escapeReference(docs);
  await mkdir(docs);
  expect(await f.run(["add", "docRoots", docs])).toEqual(success(`emend: added ${escaped} to docRoots`));
  expect(await f.run(["add", "docRoots", docs])).toEqual(success(`emend: ${escaped} is already in docRoots`));
  const listed = await f.run();
  expect(listed).toEqual(success(`{"docRoots":["${f.root}/docs\\u000a\\u001b[31m\\u202e"],"openBrowser":false}`));
  expect(JSON.parse(listed.stdout.join(""))).toEqual({ docRoots: [docs], openBrowser: false });
  expect(await f.run(["remove", "docRoots", docs])).toEqual(success(`emend: removed ${escaped} from docRoots`));
  expect(await f.run(["remove", "docRoots", docs])).toEqual(failure(`${escaped} is not in docRoots`));
  await rm(docs, { recursive: true });
  expect(await f.run(["add", "docRoots", docs])).toEqual(failure(`${escaped} does not exist`));
  await writeFile(docs, "synthetic");
  expect(await f.run(["add", "docRoots", docs])).toEqual(failure(`${escaped} is not a folder`));
});

test.each([
  "null",
  "[]",
  "true",
  "42",
  '"config"',
  "{",
  '{"docRoots":null}',
  '{"docRoots":"docs"}',
  '{"docRoots":[42]}',
  '{"docRoots":["relative"]}',
  '{"openBrowser":null}',
  '{"openBrowser":"true"}',
  '{"openBrowser":1}',
  '{"openBrowser":[]}',
  '{"openBrowser":{}}',
  "{}".padEnd(LIMITS.publicJsonBytes + 1, " "),
])("invalid configuration is never listed or overwritten (case %#)", async (original) => {
  const f = await fixture();
  await f.seed(original);
  for (const args of [
    [],
    ["list"],
    ["add", "docRoots", f.docs],
    ["remove", "docRoots", f.docs],
    ["set", "openBrowser", "true"],
  ]) {
    expect(await f.run(args)).toEqual(failure(`invalid emend configuration in ${escapeReference(f.path)}`));
    expect(await readFile(f.path, "utf8")).toBe(original);
  }
});

test("a directory config is refused without replacement", async () => {
  const f = await fixture();
  await mkdir(f.path, { recursive: true, mode: 0o700 });
  expect(await f.run(["set", "openBrowser", "true"])).toEqual(failure(`invalid emend configuration in ${f.path}`));
  expect((await stat(f.path)).isDirectory()).toBe(true);
});

test.each(["folder", "file", "dangling file"])(
  "a symlinked config %s is read and updated without replacing the link",
  async (kind) => {
    const f = await fixture();
    const target = join(f.root, "dotfiles");
    await mkdir(target, { mode: 0o700 });
    const targetFile = join(target, "config.json");
    if (kind !== "dangling file") await writeFile(targetFile, '{"openBrowser":false,"approvedActiveHours":24}');
    const link = kind === "folder" ? f.configDir : f.path;
    await mkdir(kind === "folder" ? join(f.root, "config") : f.configDir, { recursive: true, mode: 0o700 });
    await symlink(kind === "folder" ? target : targetFile, link);
    expect(await f.run(["list"])).toEqual(success('{"docRoots":[],"openBrowser":false}'));
    expect(await f.run(["set", "openBrowser", "true"])).toEqual(success("emend: openBrowser is now true"));
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(targetFile, "utf8"))).toEqual({
      docRoots: [],
      openBrowser: true,
      ...(kind === "dangling file" ? {} : { approvedActiveHours: 24 }),
    });
    expect((await stat(targetFile)).mode & 0o777).toBe(0o600);
  },
);

test("an update cannot grow the configuration beyond readConfig's size limit", async () => {
  const f = await fixture();
  const base = JSON.stringify({ docRoots: [], openBrowser: false, future: "" });
  const original = base.replace('"future":""', `"future":"${"x".repeat(LIMITS.publicJsonBytes - base.length)}"`);
  await f.seed(original);
  expect(await readConfig(f.stateDir, f.configDir)).toEqual({ docRoots: [], openBrowser: false });
  expect(await f.run(["add", "docRoots", f.docs])).toEqual(failure("emend configuration would exceed its size limit"));
  expect(await readFile(f.path, "utf8")).toBe(original);
});

test.skipIf(process.getuid?.() === 0)(
  "an unwritable config folder fails without a sandbox exemption or partial write",
  async () => {
    const f = await fixture();
    const original = '{"openBrowser":false}';
    await f.seed(original);
    await chmod(f.configDir, 0o500);
    try {
      expect(await f.run(["set", "openBrowser", "true"])).toEqual({
        code: 1,
        stdout: [],
        stderr: [`emend: cannot write emend configuration in ${escapeReference(f.path)}: permission denied\n`],
      });
      expect(await readFile(f.path, "utf8")).toBe(original);
      expect(await readdir(f.configDir)).toEqual(["config.json"]);
    } finally {
      await chmod(f.configDir, 0o700);
    }
  },
);

test.each(["EACCES", "EPERM", "EROFS"])("a %s config write names the global file", async (code) => {
  const f = await fixture();
  vi.spyOn(fs, "rename").mockImplementationOnce(async () => {
    throw Object.assign(new Error("synthetic denial"), { code, path: f.path });
  });
  expect(await f.run(["set", "openBrowser", "true"])).toEqual({
    code: 1,
    stdout: [],
    stderr: [
      `emend: cannot write emend configuration in ${escapeReference(f.path)}: ${code === "EROFS" ? "read-only file system" : "permission denied"}\n`,
    ],
  });
});

test.each(["home", "home-parent", "home-symlink"])("add refuses %s before writing", async (kind) => {
  const f = await fixture();
  let folder = kind === "home-parent" ? f.root : f.home;
  if (kind === "home-symlink") {
    folder = join(f.root, "home-alias");
    await symlink(f.home, folder, "dir");
  }
  expect(await f.run(["add", "docRoots", folder])).toEqual(failure("docRoots cannot be the home folder or hold it"));
  await expect(stat(f.stateDir)).rejects.toMatchObject({ code: "ENOENT" });
});

test.each(["state", "state-child", "state-symlink", "custom-existing", "custom-missing"])(
  "add refuses %s before writing",
  async (kind) => {
    const f = await fixture();
    const state = kind.startsWith("custom-") ? join(f.docs, "state") : f.stateDir;
    if (kind !== "custom-missing") await mkdir(state, { mode: 0o700 });
    let folder = kind.startsWith("custom-") ? f.docs : state;
    if (kind === "state-child") {
      folder = join(state, "nested");
      await mkdir(folder);
    } else if (kind === "state-symlink") {
      folder = join(f.root, "state-alias");
      await symlink(state, folder, "dir");
    }
    expect(await f.run(["add", "docRoots", folder], state)).toEqual(
      failure("docRoots cannot hold or sit inside emend's state folder"),
    );
    await expect(stat(join(state, "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test("add permits a docs folder inside the temporary home", async () => {
  const f = await fixture();
  const docs = join(f.home, "docs");
  await mkdir(docs);
  expect(await f.run(["add", "docRoots", docs])).toEqual(success(`emend: added ${docs} to docRoots`));
  expect(await readConfig(f.stateDir, f.configDir)).toEqual({ docRoots: [docs], openBrowser: false });
});

test.each(["EACCES", "ELOOP", "EPERM", "EIO"])("folder %s failures identify an escaped path", async (code) => {
  const f = await fixture();
  const path = join(f.root, "unreadable\n\u001b[31m");
  const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  await mkdir(path);
  for (const { action, operation } of [
    { action: "add", operation: "realpath" },
    { action: "add", operation: "stat" },
    { action: "remove", operation: "realpath" },
  ] as const) {
    const spy = vi.spyOn(fs, operation).mockImplementation(async (...args: unknown[]) => {
      if (args[0] === path) throw Object.assign(new Error("synthetic read failure"), { code, path });
      return Reflect.apply(actualFs[operation], undefined, args);
    });
    try {
      expect(await f.run([action, "docRoots", path])).toEqual(failure(`${escapeReference(path)} cannot be read`));
      await expect(stat(f.stateDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      spy.mockRestore();
    }
  }
});

test("add and remove report an actual symlink loop as unreadable", async () => {
  const f = await fixture();
  const path = join(f.root, "loop");
  await symlink(path, path);
  for (const action of ["add", "remove"]) {
    expect(await f.run([action, "docRoots", path])).toEqual(failure(`${path} cannot be read`));
  }
});

test("config writes do not inspect an unrelated state folder's mode", async () => {
  const f = await fixture();
  await mkdir(f.stateDir, { mode: 0o755 });
  await chmod(f.stateDir, 0o755);
  expect(await f.run(["set", "openBrowser", "true"])).toEqual(success("emend: openBrowser is now true"));
  expect(await readdir(f.stateDir)).toEqual([]);
  expect((await stat(f.stateDir)).mode & 0o777).toBe(0o755);
});

test.each(["state", "ancestor"])("config add refuses a dangling %s symlink into its doc root", async (kind) => {
  const f = await fixture();
  const link = join(f.root, "dangling");
  await symlink("docs/emend-state", link, "dir");
  const state = kind === "state" ? link : join(link, "share", "state");
  const io: Io = { env: { EMEND_HOME: state, HOME: f.home }, stdout: vi.fn(), stderr: vi.fn() };
  // The command receives explicit temporary state, without the test-only defaultStateDir symlink guard.
  await expect(configCommand(state, f.configDir, ["add", "docRoots", f.docs], io, f.root)).rejects.toThrow(
    /^docRoots cannot hold or sit inside emend's state folder$/,
  );
  expect(io.stdout).not.toHaveBeenCalled();
  await expect(stat(join(f.docs, "emend-state"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("config add refuses a doc root containing the target of a dangling HOME symlink", async () => {
  const f = await fixture();
  const home = join(f.root, "dangling-home");
  await symlink("docs/home", home, "dir");
  vi.stubEnv("HOME", home);
  expect(await f.run(["add", "docRoots", f.docs])).toEqual(failure("docRoots cannot be the home folder or hold it"));
  await expect(stat(f.stateDir)).rejects.toMatchObject({ code: "ENOENT" });
});

test("config add refuses a relative dangling state link against its real parent before writing", async () => {
  const f = await fixture();
  const parent = join(f.root, "p");
  const docs = join(parent, "real", "docs");
  await mkdir(join(parent, "real", "deep"), { recursive: true });
  await mkdir(docs);
  await symlink("real/deep", join(parent, "sub"), "dir");
  await symlink("../docs/emend-state", join(parent, "real", "deep", "state"), "dir");
  const state = join(parent, "sub", "state");
  const io: Io = { env: { EMEND_HOME: state, HOME: f.home }, stdout: vi.fn(), stderr: vi.fn() };
  const write = vi.spyOn(stateFiles, "writeSecretFile");
  await expect(configCommand(state, f.configDir, ["add", "docRoots", docs], io, f.root)).rejects.toThrow(
    /^docRoots cannot hold or sit inside emend's state folder$/,
  );
  expect(write).not.toHaveBeenCalled();
  expect(io.stdout).not.toHaveBeenCalled();
  expect(await readdir(docs)).toEqual([]);
});

async function legacy(f: Awaited<ReturnType<typeof fixture>>, document: unknown) {
  await mkdir(f.stateDir, { mode: 0o700, recursive: true });
  const path = join(f.stateDir, "config.json");
  const text = JSON.stringify(document);
  await writeFile(path, text);
  return { path, text };
}

test("an old config migrates once, keeping unknown keys and private modes", async () => {
  const f = await fixture();
  const document = { docRoots: [f.docs], openBrowser: true, approvedActiveHours: 24 };
  const old = await legacy(f, document);
  expect(await f.run()).toEqual(success(JSON.stringify({ docRoots: [f.docs], openBrowser: true })));
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(document);
  expect(await readFile(`${old.path}.migrated`, "utf8")).toBe(old.text);
  await expect(stat(old.path)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await stat(f.configDir)).mode & 0o777).toBe(0o700);
  expect((await stat(f.path)).mode & 0o777).toBe(0o600);
  expect(await f.run(["remove", "docRoots", f.docs])).toEqual(success(`emend: removed ${f.docs} from docRoots`));
  expect(await f.run()).toEqual(success('{"docRoots":[],"openBrowser":true}'));
});

test.each([{}, { openBrowser: false }, { openBrowser: true }])(
  "an existing global file wins without merging legacy keys: %j",
  async (browser) => {
    const f = await fixture();
    const document = { docRoots: [], approvedActiveHours: null, ...browser };
    await f.seed(JSON.stringify(document));
    const old = await legacy(f, { docRoots: [f.docs], openBrowser: true, oldOnly: true });
    const warning = `emend: ${old.path} was not copied because ${f.path} already exists; it is kept as ${old.path}.migrated\n`;
    expect(await f.run()).toEqual({
      code: 0,
      stdout: [`${JSON.stringify({ docRoots: [], openBrowser: browser.openBrowser ?? false })}\n`],
      stderr: [warning],
    });
    expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(document);
    expect(await readFile(`${old.path}.migrated`, "utf8")).toBe(old.text);
    expect((await f.run()).stderr).toEqual([]);
  },
);

test.each(["EACCES", "EPERM", "EROFS"])("migration uses legacy values when creation fails with %s", async (code) => {
  const f = await fixture();
  const old = await legacy(f, { docRoots: [f.docs], openBrowser: true, future: true });
  vi.spyOn(fs, "link").mockRejectedValueOnce(Object.assign(new Error("synthetic denial"), { code }));
  expect(await f.run()).toEqual(success(JSON.stringify({ docRoots: [f.docs], openBrowser: true })));
  expect(await readFile(old.path, "utf8")).toBe(old.text);
  await expect(stat(f.path)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(`${old.path}.migrated`)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readdir(f.configDir)).toEqual([]);
});

test.skipIf(process.getuid?.() === 0)("a read-only config folder leaves migration pending", async () => {
  const f = await fixture();
  await mkdir(f.configDir, { recursive: true, mode: 0o700 });
  const old = await legacy(f, { openBrowser: true });
  await chmod(f.configDir, 0o500);
  try {
    expect(await f.run()).toEqual(success('{"docRoots":[],"openBrowser":true}'));
    expect(await readFile(old.path, "utf8")).toBe(old.text);
    await expect(stat(f.path)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await chmod(f.configDir, 0o700);
  }
});

test.each(["{", '{"docRoots":["relative"]}', '{"openBrowser":null}', "[]"])(
  "an invalid old file refuses migration without changing either file: %s",
  async (invalid) => {
    const f = await fixture();
    const old = await legacy(f, {});
    await writeFile(old.path, invalid);
    expect(await f.run()).toEqual(failure(`invalid emend configuration in ${old.path}`));
    await expect(stat(f.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(old.path, "utf8")).toBe(invalid);
  },
);

test("migration tolerates another process renaming the old file first", async () => {
  const f = await fixture();
  const old = await legacy(f, { openBrowser: true });
  const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.spyOn(fs, "rename").mockImplementationOnce(async () => {
    await actualFs.rename(old.path, `${old.path}.migrated`);
    throw Object.assign(new Error("already migrated"), { code: "ENOENT" });
  });
  expect(await f.run()).toEqual(success('{"docRoots":[],"openBrowser":true}'));
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual({ openBrowser: true });
});

test("migration through a dangling global file preserves its link", async () => {
  const f = await fixture();
  const target = join(f.root, "dotfiles", "config.json");
  await mkdir(f.configDir, { recursive: true });
  await symlink(target, f.path);
  await legacy(f, { docRoots: [f.docs], openBrowser: true });
  expect(await f.run()).toEqual(success(JSON.stringify({ docRoots: [f.docs], openBrowser: true })));
  expect((await lstat(f.path)).isSymbolicLink()).toBe(true);
  expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ docRoots: [f.docs], openBrowser: true });
});

test.each([false, true])("a shared state and config folder does not migrate itself (alias=%s)", async (alias) => {
  const f = await fixture();
  await f.seed('{"openBrowser":true}');
  const state = alias ? join(f.root, "state-alias") : f.configDir;
  if (alias) await symlink(f.configDir, state, "dir");
  expect(await f.run([], state)).toEqual(success('{"docRoots":[],"openBrowser":true}'));
  expect(await readFile(f.path, "utf8")).toBe('{"openBrowser":true}');
});

test("two state folders migrate concurrently without combining or overwriting values", async () => {
  const f = await fixture();
  const first = { docRoots: [f.docs], openBrowser: true, future: "first" };
  const second = { docRoots: [join(f.root, "other-docs")], future: "second" };
  const old = await legacy(f, first);
  const otherState = join(f.root, "other-state");
  await mkdir(otherState);
  await writeFile(join(otherState, "config.json"), JSON.stringify(second));
  const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const ready = Promise.withResolvers<void>();
  let arrivals = 0;
  vi.spyOn(fs, "link").mockImplementation(async (source, target) => {
    if (++arrivals === 2) ready.resolve();
    await ready.promise;
    return actualFs.link(source, target);
  });
  const warn = vi.fn();
  const results = await Promise.all(
    [f.stateDir, otherState].map((state) => readConfig(state, f.configDir, { cwd: f.root, warn })),
  );
  const stored = JSON.parse(await readFile(f.path, "utf8"));
  expect([first, second]).toContainEqual(stored);
  expect(results).toEqual([0, 1].map(() => ({ docRoots: stored.docRoots, openBrowser: stored.openBrowser ?? false })));
  expect(warn).toHaveBeenCalledTimes(1);
  expect(await readFile(`${old.path}.migrated`, "utf8")).toBe(JSON.stringify(first));
  expect(await readFile(join(otherState, "config.json.migrated"), "utf8")).toBe(JSON.stringify(second));
  expect(await readdir(f.configDir)).toEqual(["config.json"]);
});

test("failed legacy rename never reimports a root removed from the global file", async () => {
  const f = await fixture();
  const old = await legacy(f, { docRoots: [f.docs], openBrowser: true });
  const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (from === old.path) throw Object.assign(new Error("synthetic denial"), { code: "EACCES" });
    return actualFs.rename(from, to);
  });
  expect(await f.run()).toEqual(success(JSON.stringify({ docRoots: [f.docs], openBrowser: true })));
  expect(await f.run(["remove", "docRoots", f.docs])).toEqual(success(`emend: removed ${f.docs} from docRoots`));
  expect(await f.run()).toEqual(success('{"docRoots":[],"openBrowser":true}'));
  expect(await readFile(old.path, "utf8")).toBe(old.text);
});

test("an invalid legacy file is archived without reading it when the global file exists", async () => {
  const f = await fixture();
  await f.seed("{}");
  const old = await legacy(f, {});
  await writeFile(old.path, "{");
  const result = await f.run();
  expect(result.code).toBe(0);
  expect(result.stderr).toHaveLength(1);
  expect(await readFile(`${old.path}.migrated`, "utf8")).toBe("{");
});

test.each(["folder", "file link", "folder link"])("updates and migration keep a 0755 %s", async (kind) => {
  const f = await fixture();
  const target = kind === "folder" ? f.configDir : join(f.root, "dotfiles");
  await mkdir(target, { recursive: true, mode: 0o755 });
  await chmod(target, 0o755);
  if (kind !== "folder") {
    await mkdir(kind === "file link" ? f.configDir : join(f.root, "config"), { recursive: true });
    await symlink(
      kind === "file link" ? join(target, "config.json") : target,
      kind === "file link" ? f.path : f.configDir,
    );
  }
  await legacy(f, { openBrowser: false });
  expect(await f.run()).toEqual(success('{"docRoots":[],"openBrowser":false}'));
  expect(await f.run(["set", "openBrowser", "true"])).toEqual(success("emend: openBrowser is now true"));
  expect((await stat(target)).mode & 0o777).toBe(0o755);
  expect((await stat(f.path)).mode & 0o777).toBe(0o600);
  if (kind !== "folder") expect((await lstat(kind === "file link" ? f.path : f.configDir)).isSymbolicLink()).toBe(true);
});

test.each(["global", "legacy"])("a %s config symlink loop has a one-line config error", async (which) => {
  const f = await fixture();
  await mkdir(f.configDir, { recursive: true });
  await mkdir(f.stateDir);
  const path = which === "global" ? f.path : join(f.stateDir, "config.json");
  await symlink(path, path);
  expect(await f.run()).toEqual(failure(`cannot check emend configuration in ${path}`));
});

test("config path check failures name the escaped path", async () => {
  const f = await fixture();
  const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.spyOn(fs, "realpath").mockImplementation(async (...args: unknown[]) => {
    if (args[0] === f.path) throw Object.assign(new Error("sensitive\nreason"), { code: "EACCES" });
    return Reflect.apply(actualFs.realpath, undefined, args);
  });
  expect(await f.run()).toEqual(failure(`cannot check emend configuration in ${f.path}`));
});
