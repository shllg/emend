import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { type Io, run } from "../../main.ts";
import { cliRuntime } from "../runtime.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, symlinkSync: vi.fn(actual.symlinkSync) };
});

vi.mock("../runtime.ts", async (original) => {
  const actual = await original<typeof import("../runtime.ts")>();
  return { ...actual, cliRuntime: vi.fn(actual.cliRuntime) };
});

const names = ["recense-feedback", "recense-publish", "recense-review"] as const;
let root: string;
let home: string;
let source: string;
let destination: string;
let io: Io;
let stdout: string;
let stderr: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "recense-skills-")));
  home = join(root, "home with spaces");
  source = join(root, "package/dist/skills");
  destination = join(home, ".agents/skills");
  fs.mkdirSync(home);
  for (const name of names) {
    fs.mkdirSync(join(source, name), { recursive: true });
    fs.writeFileSync(join(source, name, "SKILL.md"), `---\nname: ${name}\ndescription: Synthetic skill.\n---\n`);
  }
  stdout = "";
  stderr = "";
  io = {
    env: { HOME: home, RECENSE_HOME: join(root, "state") },
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    skills: { source, cwd: root },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(fs.symlinkSync).mockReset();
  vi.mocked(cliRuntime).mockReset();
  fs.rmSync(root, { recursive: true, force: true });
});

const invoke = (...args: string[]) => run(["skills", "install", ...args], io);
const refusal = (target: string) =>
  `recense: ${target} exists and was not made by recense; move it away, then run recense skills install again\n`;

test("links both skills into temporary HOME and preserves link inodes on a second run", async () => {
  expect(await invoke()).toBe(0);
  expect(stderr).toBe("");
  expect(stdout).toBe(names.map((name) => `linked ~/.agents/skills/${name} -> ${source}/${name}\n`).join(""));
  const before = names.map((name) => fs.lstatSync(join(destination, name)));
  const directory = fs.lstatSync(destination);
  stdout = "";
  expect(await invoke()).toBe(0);
  expect(stdout).toBe(names.map((name) => `~/.agents/skills/${name} already linked\n`).join(""));
  for (const [index, name] of names.entries()) {
    expect(fs.readlinkSync(join(destination, name))).toBe(join(source, name));
    expect(fs.lstatSync(join(destination, name)).ino).toBe(before[index]?.ino);
    expect(fs.lstatSync(join(destination, name)).mtimeMs).toBe(before[index]?.mtimeMs);
  }
  expect(fs.lstatSync(destination).mtimeMs).toBe(directory.mtimeMs);
  expect(fs.existsSync(join(root, "state"))).toBe(false);
});

test("default sources come from beside the running entry", async () => {
  io.skills = { cwd: root };
  vi.mocked(cliRuntime).mockReturnValueOnce({ node: process.execPath, entry: join(dirname(source), "recense.mjs") });
  expect(await invoke()).toBe(0);
  for (const name of names) expect(fs.readlinkSync(join(destination, name))).toBe(join(source, name));
});

test("dry-run leaves matching links and their directory untouched", async () => {
  expect(await invoke()).toBe(0);
  const before = names.map((name) => fs.lstatSync(join(destination, name)).ino);
  const directory = fs.lstatSync(destination);
  stdout = "";
  expect(await invoke("--dry-run")).toBe(0);
  expect(stdout).toBe(names.map((name) => `~/.agents/skills/${name} already linked\n`).join(""));
  expect(names.map((name) => fs.lstatSync(join(destination, name)).ino)).toEqual(before);
  expect(fs.lstatSync(destination).mtimeMs).toBe(directory.mtimeMs);
});

test.each(["relative", "absolute", "dot relative"])("--dir accepts a %s destination", async (kind) => {
  const dir =
    kind === "relative" ? "custom skills" : kind === "dot relative" ? "./custom skills" : join(root, "custom skills");
  expect(await invoke("--dir", dir)).toBe(0);
  for (const name of names) expect(fs.readlinkSync(join(root, "custom skills", name))).toBe(join(source, name));
  expect(stdout).toContain(`linked ${join(root, "custom skills", names[0])} ->`);
});

test.each([undefined, "", "relative-home"])("refuses default installation with HOME=%j", async (value) => {
  io.env.HOME = value;
  const before = fs.readdirSync(root);
  for (const args of [[], ["--dry-run"]]) {
    stderr = "";
    expect(await invoke(...args)).toBe(1);
    expect(stderr).toBe("recense: HOME must be an absolute path; pass --dir\n");
    expect(stdout).toBe("");
    expect(fs.readdirSync(root)).toEqual(before);
  }
  expect(await invoke("--dir", "custom")).toBe(0);
  expect(stdout).toContain(`linked ${join(root, "custom", names[0])} ->`);
});

test.each(["~/custom", "home with spaces-sibling/skills"])(
  "prints the resolved destination for literal --dir %s without a false home abbreviation",
  async (dir) => {
    expect(await invoke("--dir", dir)).toBe(0);
    expect(stdout).toBe(names.map((name) => `linked ${join(root, dir, name)} -> ${source}/${name}\n`).join(""));
    for (const name of names) expect(fs.readlinkSync(join(root, dir, name))).toBe(join(source, name));
    expect(fs.readdirSync(home)).toEqual([]);
  },
);

test.each(["file", "file/x"])("refuses --dir %s before any writes, including dry-run", async (dir) => {
  fs.writeFileSync(join(root, "file"), "keep");
  const before = fs.readdirSync(root);
  for (const args of [[], ["--dry-run"]]) {
    stderr = "";
    expect(await invoke("--dir", dir, ...args)).toBe(1);
    expect(stderr).toBe(`recense: ${join(root, dir)} is not a folder recense can write to\n`);
    expect(stdout).toBe("");
    expect(fs.readdirSync(root)).toEqual(before);
    expect(fs.readFileSync(join(root, "file"), "utf8")).toBe("keep");
    expect(fs.readdirSync(home)).toEqual([]);
  }
});

test("dry-run lists two links without creating the target directory", async () => {
  const target = join(root, "absent/skills");
  expect(await invoke("--dry-run", "--dir", target)).toBe(0);
  expect(stdout).toBe(names.map((name) => `would link ${target}/${name} -> ${source}/${name}\n`).join(""));
  expect(fs.existsSync(dirname(target))).toBe(false);
  expect(fs.readdirSync(home)).toEqual([]);
});

test("resolves source symlinks and abbreviates paths under HOME", async () => {
  const actual = join(home, "package/dist/skills");
  fs.mkdirSync(dirname(actual), { recursive: true });
  fs.renameSync(source, actual);
  fs.symlinkSync(actual, source);
  expect(await invoke()).toBe(0);
  for (const name of names) expect(fs.readlinkSync(join(destination, name))).toBe(join(actual, name));
  expect(stdout).toContain("-> ~/package/dist/skills/");
});

test.each(["ENOENT", "ENOTDIR"])(
  "a %s dangling install is relinked atomically, but dry-run leaves it untouched",
  async (kind) => {
    fs.mkdirSync(destination, { recursive: true });
    if (kind === "ENOTDIR") fs.writeFileSync(join(root, "old-node"), "synthetic removed install");
    const old = join(root, "old-node/dist/skills", names[0]);
    const target = join(destination, names[0]);
    fs.symlinkSync(old, target);
    const before = fs.lstatSync(target);
    expect(await invoke("--dry-run")).toBe(0);
    expect(fs.readlinkSync(target)).toBe(old);
    expect(fs.lstatSync(target).ino).toBe(before.ino);
    const rename = vi.spyOn(fs, "renameSync");
    expect(await invoke()).toBe(0);
    expect(fs.readlinkSync(target)).toBe(join(source, names[0]));
    expect(rename).toHaveBeenCalledOnce();
    expect(dirname(String(rename.mock.calls[0]?.[0]))).toBe(destination);
    expect(rename.mock.calls[0]?.[1]).toBe(target);
    expect(fs.readdirSync(destination).sort()).toEqual(names);
  },
);

test.each(["absolute", "relative"])("relinks a %s link into a package named @shllg/recense", async (kind) => {
  const oldRoot = join(root, "old-package");
  const old = join(oldRoot, "dist/skills", names[1]);
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(join(oldRoot, "package.json"), JSON.stringify({ name: "@shllg/recense", version: "0.0.1" }));
  fs.mkdirSync(destination, { recursive: true });
  const target = join(destination, names[1]);
  const previous = kind === "relative" ? relative(destination, old) : old;
  fs.symlinkSync(previous, target);
  const before = fs.lstatSync(target);
  expect(await invoke("--dry-run")).toBe(0);
  expect(fs.readlinkSync(target)).toBe(previous);
  expect(fs.lstatSync(target).ino).toBe(before.ino);
  expect(await invoke()).toBe(0);
  for (const name of names) expect(fs.readlinkSync(join(destination, name))).toBe(join(source, name));
  expect(fs.readFileSync(join(oldRoot, "package.json"), "utf8")).toContain("@shllg/recense");
});

test.each([
  "unrelated",
  "missing",
  "invalid JSON",
  "null",
  "directory",
  "symlink",
  "unreadable",
  "skill file",
  "oversized",
])("refuses a dist/skills link with %s package evidence before changing any link", async (kind) => {
  const oldRoot = join(root, "other-package");
  const old = join(oldRoot, "dist/skills", names[1]);
  fs.mkdirSync(old, { recursive: true });
  const metadata = join(oldRoot, "package.json");
  if (kind === "directory") fs.mkdirSync(metadata);
  else if (kind === "symlink") {
    fs.writeFileSync(join(root, "metadata.json"), JSON.stringify({ name: "@shllg/recense" }));
    fs.symlinkSync(join(root, "metadata.json"), metadata);
  } else if (kind !== "missing") {
    fs.writeFileSync(
      metadata,
      kind === "invalid JSON"
        ? "invalid"
        : kind === "null"
          ? "null"
          : JSON.stringify({ name: kind === "unrelated" ? "unrelated-package" : "@shllg/recense" }),
    );
  }
  if (kind === "unreadable") {
    const original = fs.openSync;
    vi.spyOn(fs, "openSync").mockImplementation((...args) => {
      if (args[0] === metadata) throw Object.assign(new Error("synthetic read refusal"), { code: "EACCES" });
      return original(...args);
    });
  }
  if (kind === "oversized") fs.appendFileSync(metadata, " ".repeat(1024 * 1024));
  if (kind === "skill file") {
    fs.rmdirSync(old);
    fs.writeFileSync(old, "keep");
  }
  fs.mkdirSync(destination, { recursive: true });
  const target = join(destination, names[1]);
  fs.symlinkSync(old, target);
  const before = fs.lstatSync(target);
  for (const args of [[], ["--dry-run"]]) {
    stderr = "";
    expect(await invoke(...args)).toBe(1);
    expect(stderr).toBe(refusal(`~/.agents/skills/${names[1]}`));
    expect(stdout).toBe("");
    expect(fs.readlinkSync(target)).toBe(old);
    expect(fs.lstatSync(target).ino).toBe(before.ino);
    expect(fs.readdirSync(destination)).toEqual([names[1]]);
  }
});

test("a failed rename keeps the old link and removes the temporary link", async () => {
  fs.mkdirSync(destination, { recursive: true });
  const old = join(root, "old-node/dist/skills", names[0]);
  const target = join(destination, names[0]);
  fs.symlinkSync(old, target);
  const before = fs.lstatSync(target);
  vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
    throw new Error("synthetic rename failure");
  });
  expect(await invoke()).toBe(1);
  expect(fs.readlinkSync(target)).toBe(old);
  expect(fs.lstatSync(target).ino).toBe(before.ino);
  expect(fs.readdirSync(destination)).toEqual([names[0]]);
  expect(stdout).toBe("");
});

test.each(["file", "folder", "foreign symlink", "relative symlink", "wrong skill symlink"])(
  "refuses a %s before changing either skill, including dry-run",
  async (kind) => {
    fs.mkdirSync(destination, { recursive: true });
    if (kind === "relative symlink") fs.symlinkSync(source, join(root, "source-alias"));
    const target = join(destination, names[1]);
    if (kind === "file") fs.writeFileSync(target, "keep");
    else if (kind === "folder") fs.mkdirSync(target);
    else
      fs.symlinkSync(
        kind === "relative symlink"
          ? relative(destination, join(root, "source-alias", names[1]))
          : kind === "wrong skill symlink"
            ? join(source, names[0])
            : join(root, "foreign"),
        target,
      );
    const before = fs.lstatSync(target);
    for (const args of [[], ["--dry-run"]]) {
      stdout = "";
      stderr = "";
      expect(await invoke(...args)).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toBe(refusal(`~/.agents/skills/${names[1]}`));
      expect(fs.readdirSync(destination)).toEqual([names[1]]);
      expect(fs.lstatSync(target).ino).toBe(before.ino);
    }
    fs.symlinkSync(join(root, "older/dist/skills", names[0]), join(destination, names[0]));
    const other = fs.lstatSync(join(destination, names[0]));
    expect(await invoke()).toBe(1);
    expect(fs.lstatSync(join(destination, names[0])).ino).toBe(other.ino);
    if (kind === "file") expect(fs.readFileSync(target, "utf8")).toBe("keep");
  },
);

test("a live foreign link reached through jump/.. cannot use the lexical recense package as evidence", async () => {
  const parent = join(root, "a");
  const foreign = join(root, "foreign");
  fs.mkdirSync(join(parent, "dist/skills", names[1]), { recursive: true });
  fs.writeFileSync(join(parent, "package.json"), JSON.stringify({ name: "@shllg/recense" }));
  fs.mkdirSync(join(foreign, "sub"), { recursive: true });
  fs.mkdirSync(join(foreign, "dist/skills", names[1]), { recursive: true });
  fs.writeFileSync(join(foreign, "package.json"), JSON.stringify({ name: "foreign-package" }));
  fs.symlinkSync(join(foreign, "sub"), join(parent, "jump"));
  fs.mkdirSync(destination, { recursive: true });
  const target = join(destination, names[1]);
  const previous = `${parent}/jump/../dist/skills/${names[1]}`;
  fs.symlinkSync(previous, target);
  const before = fs.lstatSync(target);
  for (const args of [[], ["--dry-run"]]) {
    stderr = "";
    expect(await invoke(...args)).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe(refusal(`~/.agents/skills/${names[1]}`));
    expect(fs.readdirSync(destination)).toEqual([names[1]]);
    expect(fs.readlinkSync(target)).toBe(previous);
    expect(fs.lstatSync(target).ino).toBe(before.ino);
  }
});

test("package metadata reads are bounded by the handle's size even if the file grows", async () => {
  const oldRoot = join(root, "old-package");
  const old = join(oldRoot, "dist/skills", names[1]);
  fs.mkdirSync(old, { recursive: true });
  const metadata = join(oldRoot, "package.json");
  fs.writeFileSync(metadata, JSON.stringify({ name: "@shllg/recense" }));
  fs.mkdirSync(destination, { recursive: true });
  fs.symlinkSync(old, join(destination, names[1]));
  const original = fs.fstatSync;
  const inspected = vi.spyOn(fs, "fstatSync").mockImplementationOnce((handle) => {
    const info = original(handle);
    fs.appendFileSync(metadata, "x".repeat(1024 * 1024));
    return info;
  });
  expect(await invoke()).toBe(0);
  expect(inspected).toHaveBeenCalledOnce();
  expect(stderr).toBe("");
  for (const name of names) expect(fs.readlinkSync(join(destination, name))).toBe(join(source, name));
});

test.each(["before open", "after open"])(
  "package metadata swapped %s cannot authorize a foreign install",
  async (when) => {
    const oldRoot = join(root, "foreign");
    const old = join(oldRoot, "dist/skills", names[1]);
    fs.mkdirSync(old, { recursive: true });
    const metadata = join(oldRoot, "package.json");
    fs.writeFileSync(metadata, JSON.stringify({ name: "foreign-package" }));
    const recense = join(root, "recense.json");
    fs.writeFileSync(recense, JSON.stringify({ name: "@shllg/recense" }));
    fs.mkdirSync(destination, { recursive: true });
    fs.symlinkSync(old, join(destination, names[1]));
    const original = fs.openSync;
    vi.spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
      if (path !== metadata) return original(path, flags, mode);
      const handle = when === "after open" ? original(path, flags, mode) : undefined;
      fs.renameSync(metadata, join(oldRoot, "saved.json"));
      fs.symlinkSync(recense, metadata);
      return handle ?? original(path, flags, mode);
    });
    expect(await invoke()).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe(refusal(`~/.agents/skills/${names[1]}`));
    expect(fs.readdirSync(destination)).toEqual([names[1]]);
    expect(fs.readlinkSync(join(destination, names[1]))).toBe(old);
  },
);

test("refusal prints the resolved absolute --dir", async () => {
  fs.mkdirSync(join(root, "custom"));
  fs.writeFileSync(join(root, "custom", names[0]), "keep");
  expect(await invoke("--dir", "custom")).toBe(1);
  expect(stderr).toBe(refusal(join(root, "custom", names[0])));
});

test("EEXIST at symlink creation is a foreign target and is never overwritten", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  vi.mocked(fs.symlinkSync).mockImplementationOnce((from, to, type) => {
    fs.writeFileSync(to, "racing file");
    return actual.symlinkSync(from, to, type);
  });
  expect(await invoke()).toBe(1);
  expect(stderr).toBe(refusal(`~/.agents/skills/${names[0]}`));
  expect(stdout).toBe("");
  expect(fs.readFileSync(join(destination, names[0]), "utf8")).toBe("racing file");
});

test("EEXIST on the second skill preserves the first link and the racing file", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  vi.mocked(fs.symlinkSync).mockImplementation((from, to, type) => {
    if (to === join(destination, names[1])) fs.writeFileSync(to, "racing file");
    return actual.symlinkSync(from, to, type);
  });
  expect(await invoke()).toBe(1);
  expect(stderr).toBe(refusal(`~/.agents/skills/${names[1]}`));
  expect(stdout).toBe("");
  expect(fs.readlinkSync(join(destination, names[0]))).toBe(join(source, names[0]));
  expect(fs.readFileSync(join(destination, names[1]), "utf8")).toBe("racing file");
});

test.each(["missing", "empty"])("%s packaged skills report the build instruction without writes", async (kind) => {
  fs.rmSync(source, { recursive: true });
  if (kind === "empty") fs.mkdirSync(source);
  expect(await invoke()).toBe(1);
  expect(stderr).toBe("recense: no skills found next to this recense; run pnpm build in the checkout\n");
  expect(stdout).toBe("");
  expect(fs.readdirSync(home)).toEqual([]);
});

test.each([
  [],
  ["remove"],
  ["install", "extra"],
  ["install", "--unknown"],
  ["install", "--dir"],
  ["install", "--dir", "--dry-run"],
  ["install", "--dry-run", "--dry-run"],
  ["install", "--dir", "a", "--dir", "b"],
])("rejects invalid arguments %j without touching HOME", async (...args) => {
  expect(await run(["skills", ...args], io)).toBe(2);
  expect(stderr).toBe("recense: Usage: recense skills install [--dir <path>] [--dry-run].\n");
  expect(stdout).toBe("");
  expect(fs.readdirSync(home)).toEqual([]);
});

test("CLI help includes the skills installer", async () => {
  expect(await run(["--help"], io)).toBe(0);
  expect(stdout).toContain("recense skills install [--dir <path>] [--dry-run]");
  expect(stderr).toBe("");
});

function oldInstall(name: string, packageName = "@shllg/emend") {
  const old = join(root, "old", packageName, "lib/node_modules", packageName);
  fs.mkdirSync(join(old, "dist/skills", name), { recursive: true });
  fs.writeFileSync(join(old, "package.json"), JSON.stringify({ name: packageName }));
  return join(old, "dist/skills", name);
}

test("replaces the links the package made before the rename and keeps foreign ones", async () => {
  fs.mkdirSync(destination, { recursive: true });
  const stale = ["emend-feedback", "emend-publish"] as const;
  for (const name of stale) fs.symlinkSync(oldInstall(name), join(destination, name));
  // A link into some other package that happens to use the name stays.
  fs.symlinkSync(oldInstall("emend-review", "@someone/else"), join(destination, "emend-review"));
  expect(await invoke("--dry-run")).toBe(0);
  expect(stdout).toContain("would remove ~/.agents/skills/emend-feedback (the old emend link)\n");
  for (const name of stale) expect(fs.lstatSync(join(destination, name)).isSymbolicLink()).toBe(true);
  stdout = "";
  expect(await invoke()).toBe(0);
  expect(stdout).toContain("removed ~/.agents/skills/emend-publish (the old emend link)\n");
  for (const name of stale) expect(fs.existsSync(join(destination, name))).toBe(false);
  expect(fs.lstatSync(join(destination, "emend-review")).isSymbolicLink()).toBe(true);
  for (const name of names) expect(fs.readlinkSync(join(destination, name))).toBe(join(source, name));
});

test("removes an old link whose install is already gone", async () => {
  fs.mkdirSync(destination, { recursive: true });
  const target = oldInstall("emend-publish");
  fs.symlinkSync(target, join(destination, "emend-publish"));
  fs.rmSync(join(root, "old"), { recursive: true });
  expect(await invoke()).toBe(0);
  expect(fs.existsSync(join(destination, "emend-publish"))).toBe(false);
  expect(fs.lstatSync(join(destination, "emend-publish"), { throwIfNoEntry: false })).toBeUndefined();
});
