import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { THEME_SCALE_STEPS, THEME_TOKENS } from "@emend/contract";
import { themeCopyDocument } from "@emend/core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { type Io, run } from "../../main.ts";
import { escapeReference } from "../escape.ts";
import { CliSignalExit } from "../http.ts";
import { themeCommand } from "./theme.ts";

let root: string;
let dir: string;
let io: Io;
let stdout: string[];
let stderr: string[];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "emend-theme-command-"));
  vi.spyOn(process, "cwd").mockReturnValue(root);
  const configHome = join(root, "config");
  const state = join(root, "state");
  vi.stubEnv("XDG_CONFIG_HOME", configHome);
  vi.stubEnv("EMEND_HOME", state);
  dir = join(configHome, "emend", "themes");
  stdout = [];
  stderr = [];
  io = {
    env: { XDG_CONFIG_HOME: configHome, EMEND_HOME: state },
    stdout: (line) => {
      stdout.push(line);
    },
    stderr: (line) => {
      stderr.push(line);
    },
  };
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
async function command(...args: string[]) {
  stdout.length = 0;
  stderr.length = 0;
  const code = await run(["theme", ...args], io);
  return { code, stdout: [...stdout], stderr: [...stderr] };
}
async function seed(name: string, document: unknown) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.json`), JSON.stringify(document));
}

test("list of an absent folder names it and explains how to copy a theme", async () => {
  expect(await command("list")).toEqual({
    code: 0,
    stdout: [`emend: no themes in ${dir}; use emend theme copy dark <name>\n`],
    stderr: [],
  });
  await expect(stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
});

test("list shows valid and refused themes with their base and remaining problem count", async () => {
  await seed("zeta", { version: 1, base: "light" });
  await seed("alpha", { version: 2, base: "dark", extra: true });
  await seed("broken", null);
  expect(await command("list")).toEqual({
    code: 0,
    stdout: [
      "alpha\tdark\trefused: version must be 1. (1 more)\n",
      "broken\t-\trefused: The file must hold a JSON object.\n",
      "zeta\tlight\tvalid\n",
    ],
    stderr: [],
  });
});

test.each(["dark", "light"] as const)(
  "copy %s fills every colour, creates private files, and passes check",
  async (base) => {
    expect(await command("copy", base, "mine")).toEqual({
      code: 0,
      stdout: [`emend: wrote ${dir}/mine.json\n`],
      stderr: [],
    });
    const path = join(dir, "mine.json");
    const text = await readFile(path, "utf8");
    const document = JSON.parse(text);
    expect(Object.keys(document.scales)).toEqual([...THEME_SCALE_STEPS]);
    expect(Object.keys(document.tokens)).toEqual([...THEME_TOKENS]);
    expect(document).toEqual(themeCopyDocument(base));
    expect(text).toBe(`${JSON.stringify(document, null, 2)}\n`);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect(await command("check", "mine")).toEqual({ code: 0, stdout: ["emend: mine is valid\n"], stderr: [] });
  },
);

test("copy accepts an existing valid theme and retains its colours and fonts", async () => {
  await seed("source", { version: 1, base: "dark", fonts: { text: "Example Font" }, tokens: { "border-1": "#abc" } });
  expect((await command("copy", "source", "mine")).code).toBe(0);
  const document = JSON.parse(await readFile(join(dir, "mine.json"), "utf8"));
  expect(document.tokens["border-1"]).toBe("#aabbcc");
  expect(document.fonts.text).toBe("Example Font");
  expect((await command("check", "mine")).code).toBe(0);
});

test.each(["file", "link", "dangling link", "directory"])(
  "copy refuses an existing %s without replacing it",
  async (kind) => {
    await mkdir(dir, { recursive: true });
    const path = join(dir, "mine.json");
    const target = join(root, "target.json");
    if (kind === "file") await writeFile(path, "kept");
    else if (kind === "directory") await mkdir(path);
    else {
      if (kind === "link") await writeFile(target, "kept");
      await symlink(target, path);
    }
    expect(await command("copy", "dark", "mine")).toEqual({
      code: 1,
      stdout: [],
      stderr: [`emend: ${path} already exists\n`],
    });
    if (kind === "file") expect(await readFile(path, "utf8")).toBe("kept");
    if (kind.includes("link")) expect((await lstat(path)).isSymbolicLink()).toBe(true);
    if (kind === "link") expect(await readFile(target, "utf8")).toBe("kept");
  },
);

test.each(["system", "dark", "light", "Bad", "../escape", "bad\nname", "x".repeat(41)])(
  "copy refuses bad destination %j",
  async (name) => {
    const result = await command("copy", "dark", name);
    expect(result.code).toBe(2);
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toHaveLength(1);
    expect(result.stderr[0]).toContain(escapeReference(name));
    expect(result.stderr[0]?.split("\n")).toHaveLength(2);
    await expect(stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test("copy refuses a missing or refused source", async () => {
  expect(await command("copy", "missing", "mine")).toEqual({
    code: 1,
    stdout: [],
    stderr: ["emend: unknown theme missing\n"],
  });
  await seed("refused", { version: 2, base: "dark" });
  expect(await command("copy", "refused", "mine")).toEqual({
    code: 1,
    stdout: [],
    stderr: ["emend: theme refused is refused: version must be 1.\n"],
  });
  await expect(stat(join(dir, "mine.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("check names faint pairs on stdout and uses a silent exit 1", async () => {
  await seed("faint", { version: 1, base: "dark", tokens: { "fg-1": "#111" } });
  const result = await command("check", "faint");
  expect(result.code).toBe(1);
  expect(result.stderr).toEqual([]);
  expect(result.stdout).toContainEqual(expect.stringMatching(/^emend: faint: fg-1 on bg-app: .*needs 4\.5 to 1\.\n$/));
  await expect(themeCommand(join(root, "config", "emend"), ["check", "faint"], io)).rejects.toBeInstanceOf(
    CliSignalExit,
  );
});

test("check unknown names emits one escaped stderr line", async () => {
  expect(await command("check", "missing\nname")).toEqual({
    code: 1,
    stdout: [],
    stderr: ["emend: unknown theme missing\\u{a}name\n"],
  });
});

test.each([
  [],
  ["list", "extra"],
  ["check"],
  ["check", "mine", "extra"],
  ["copy"],
  ["copy", "dark"],
  ["copy", "dark", "mine", "extra"],
  ["unknown"],
])("bad arguments %j exit 2", async (...args) => {
  const result = await command(...args);
  expect(result).toEqual({
    code: 2,
    stdout: [],
    stderr: ["emend: Usage: emend theme list | copy <source> <name> | check <name>.\n"],
  });
});

test.each(["config folder", "themes link", "intermediate link", "repository link pointing outside"])(
  "theme commands refuse a repository %s without writing and escape the refusal",
  async (kind) => {
    const repo = join(root, "reviewed\nrepo");
    await mkdir(join(repo, ".git"), { recursive: true });
    await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    vi.spyOn(process, "cwd").mockReturnValue(repo);
    const outside = join(root, "outside");
    if (kind === "config folder" || kind === "repository link pointing outside") {
      io.env.XDG_CONFIG_HOME = join(repo, "config");
      dir = join(io.env.XDG_CONFIG_HOME, "emend", "themes");
      if (kind === "repository link pointing outside") {
        await mkdir(join(io.env.XDG_CONFIG_HOME, "emend"), { recursive: true });
        await mkdir(outside);
        await symlink(outside, dir);
      }
    } else {
      const target = join(repo, "themes");
      await mkdir(join(root, "config", "emend"), { recursive: true });
      if (kind === "themes link") await mkdir(target);
      else {
        await mkdir(outside);
        await symlink(outside, target);
      }
      await symlink(target, dir);
    }
    for (const args of [["list"], ["check", "mine"], ["copy", "dark", "mine"]]) {
      expect(await command(...args)).toEqual({
        code: 1,
        stdout: [],
        stderr: [
          `emend: the emend themes folder ${escapeReference(dir)} sits inside the repository at ${escapeReference(repo)}; run emend theme outside it\n`,
        ],
      });
      await expect(stat(join(dir, "mine.json"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(join(outside, "mine.json"))).rejects.toMatchObject({ code: "ENOENT" });
    }
    if (kind === "config folder") await expect(stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test("paths and displayed names use terminal escaping, and help includes theme", async () => {
  io.env.XDG_CONFIG_HOME = join(root, "config\nfolder");
  const escaped = escapeReference(join(io.env.XDG_CONFIG_HOME, "emend", "themes"));
  expect((await command("list")).stdout[0]).toContain(escaped);
  expect((await command("copy", "dark", "mine")).stdout).toEqual([`emend: wrote ${escaped}/mine.json\n`]);
  io.env.XDG_CONFIG_HOME = join(root, "config");
  await seed("name\u2028line", { version: 1, base: "dark" });
  expect((await command("list")).stdout[0]).toContain("name\\u{2028}line");
  stdout.length = 0;
  expect(await run(["--help"], io)).toBe(0);
  expect(stdout[0]).toContain("emend theme list | copy <source> <name> | check <name>");
});
