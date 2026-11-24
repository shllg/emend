import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIMITS } from "@recense/contract";
import { applyHtmlLook, stripHtmlLook } from "@recense/core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { type Io, run } from "../../main.ts";
import * as stylesheet from "../../server/content/look.ts";
import * as themes from "../../state/themes.ts";
import { escapeReference } from "../escape.ts";
import { lookCommand } from "./look.ts";

vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof import("node:fs/promises")>()) }));
vi.mock("../../server/content/look.ts", async (original) => ({
  ...(await original<typeof import("../../server/content/look.ts")>()),
}));
vi.mock("../../state/themes.ts", async (original) => ({
  ...(await original<typeof import("../../state/themes.ts")>()),
}));

const css =
  '@layer recense-file,recense;@font-face{font-family:Example;src:url("data:font/woff2;base64,AA==")}@layer recense{body{color:CanvasText}}';
let root: string;
let configDir: string;
let webRoot: string;
let io: Io;
let stdout: string[];
let stderr: string[];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "recense-look-command-"));
  configDir = join(root, "config", "recense");
  webRoot = join(root, "web");
  await mkdir(webRoot);
  await writeFile(join(webRoot, "pub-frame.css"), css);
  vi.spyOn(process, "cwd").mockReturnValue(root);
  vi.stubEnv("RECENSE_HOME", join(root, "state"));
  vi.stubEnv("XDG_CONFIG_HOME", join(root, "config"));
  // Exercise run() with real stylesheet reads confined to the fixture web build.
  const read = stylesheet.readPubStylesheet;
  vi.spyOn(stylesheet, "readPubStylesheet").mockImplementation(() => read(webRoot));
  stdout = [];
  stderr = [];
  io = {
    env: { RECENSE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config") },
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
  const code = await run(["look", ...args], io);
  return { code, stdout: [...stdout], stderr: [...stderr] };
}
async function seed(name: string, document: unknown) {
  const dir = join(configDir, "themes", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "theme.json"), JSON.stringify(document));
}
async function page(text = "<!doctype html><p>Seeds</p>", name = "page.html") {
  const path = join(root, name);
  await writeFile(path, text);
  return path;
}

test("styles a UTF-8 file with its BOM and page content intact, then writes nothing on a second run", async () => {
  const original = '\uFEFF<!doctype html>\n<html lang="en"><meta charset="utf-8"><p>Säen</p></html>';
  const path = await page(original);
  expect(await command("page.html")).toEqual({
    code: 0,
    stdout: ["recense: gave page.html recense's look\n"],
    stderr: [],
  });
  const styled = await readFile(path, "utf8");
  expect(styled.startsWith('\uFEFF<!doctype html>\n<meta charset="utf-8"><style data-recense-look>')).toBe(true);
  expect(styled).toContain(css);
  expect(stripHtmlLook(styled)).toBe(original);
  const before = await lstat(path);
  expect(await command("page.html")).toEqual({
    code: 0,
    stdout: ["recense: page.html already has recense's look\n"],
    stderr: [],
  });
  expect(await readFile(path, "utf8")).toBe(styled);
  const after = await lstat(path);
  expect(after.ino).toBe(before.ino);
  expect(after.mtimeMs).toBe(before.mtimeMs);
});

test.each([false, true])("custom files keep their exact bytes, including an old chunk: %s", async (chunk) => {
  const original = '<!doctype html><meta name="recense-look" content="custom"><p>Seeds</p>';
  const text = chunk ? applyHtmlLook(original, { css, lightOnly: false }) : original;
  const path = await page(text);
  const before = await lstat(path);
  expect(await command("page.html")).toEqual({
    code: 0,
    stdout: [
      'recense: left page.html unchanged: it is marked custom with <meta name="recense-look" content="custom">\n',
    ],
    stderr: [],
  });
  expect(await readFile(path, "utf8")).toBe(text);
  expect((await lstat(path)).ino).toBe(before.ino);
});

test("a page exceeding the parser depth stays unchanged with its explanation", async () => {
  const original = "<div>".repeat(600);
  const path = await page(original);
  expect(await command("page.html")).toEqual({
    code: 0,
    stdout: ["recense: left page.html unchanged: recense could not read its structure, so it shows as a custom page\n"],
    stderr: [],
  });
  expect(await readFile(path, "utf8")).toBe(original);
});

test.each([false, true])("uses one valid theme, explicitly picked=%s", async (explicit) => {
  const path = await page();
  await seed("mine", { version: 1, base: "dark", tokens: { "border-1": "#123456" } });
  await seed("refused", { version: 2, base: "light" });
  expect(await command("page.html", ...(explicit ? ["--theme", "mine"] : []))).toEqual({
    code: 0,
    stdout: ["recense: gave page.html recense's look and the colours of theme mine\n"],
    stderr: [],
  });
  expect(await readFile(path, "utf8")).toContain("--border-1:#123456;");
});

test("several valid themes use recense colours and one warning, while --theme picks one", async () => {
  const path = await page();
  for (const name of ["first", "second"])
    await seed(name, { version: 1, base: "dark", tokens: { "border-1": "#123456" } });
  expect(await command("page.html")).toEqual({
    code: 0,
    stdout: ["recense: gave page.html recense's look\n"],
    stderr: ["recense: several themes are valid; used recense's own colours. Pick one with --theme <name>\n"],
  });
  expect(await readFile(path, "utf8")).not.toContain("--border-1:");
  expect((await command("--theme", "second", "page.html")).stdout).toEqual([
    "recense: gave page.html recense's look and the colours of theme second\n",
  ]);
});

test("unknown and refused themes fail without touching the file", async () => {
  const path = await page();
  await seed("broken", { version: 2, base: "dark" });
  for (const [name, message] of [
    ["missing", "unknown theme missing"],
    ["broken", "theme broken is refused: version must be 1."],
  ])
    expect(await command("page.html", "--theme", name ?? "")).toEqual({
      code: 1,
      stdout: [],
      stderr: [`recense: ${message}\n`],
    });
  expect(await readFile(path, "utf8")).toBe("<!doctype html><p>Seeds</p>");
});

test("a repository themes folder refuses look with its own command name", async () => {
  const path = await page();
  const before = await readFile(path);
  await mkdir(join(root, ".git"));
  await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  const list = vi.spyOn(themes, "listThemes");
  const read = vi.spyOn(themes, "readTheme");
  expect(await command("page.html")).toEqual({
    code: 1,
    stdout: [],
    stderr: [
      `recense: the recense themes folder ${escapeReference(join(configDir, "themes"))} sits inside the repository at ${escapeReference(root)}; run recense look outside it\n`,
    ],
  });
  expect(list).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  expect(await readFile(path)).toEqual(before);
});

test("--no-theme skips even a repository themes folder and removes old theme colours", async () => {
  const path = await page();
  await seed("mine", { version: 1, base: "dark", tokens: { "border-1": "#123456" } });
  expect((await command("page.html")).code).toBe(0);
  const list = vi.spyOn(themes, "listThemes");
  const read = vi.spyOn(themes, "readTheme");
  await mkdir(join(root, ".git"));
  await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  expect((await command("page.html", "--no-theme")).code).toBe(0);
  expect(list).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  expect(await readFile(path, "utf8")).not.toContain("--border-1:");
});

test.each(["dark", "light"] as const)("light-only files keep light mode with a %s-base theme", async (base) => {
  const path = await page("<!doctype html><style>p{color:#222}</style><p>Seeds</p>");
  await seed("mine", { version: 1, base, tokens: { "border-1": "#123456" } });
  expect(await command("page.html")).toEqual({
    code: 0,
    stdout: [
      `recense: gave page.html recense's look${base === "light" ? " and the colours of theme mine" : ""}\n`,
      "recense: page.html stays in light mode: its styles set colours but have no dark-mode rule\n",
    ],
    stderr: [],
  });
  const text = await readFile(path, "utf8");
  expect(text).toContain('<!doctype html><html data-theme="light">');
  if (base === "dark") {
    expect(text).toContain(":root:not([data-theme=light]){--border-1:#123456;}");
    expect(text).not.toContain(":root[data-theme=light]{--border-1:");
  } else expect(text).toContain(":root[data-theme=light]{--border-1:#123456;}");
});

test.each([
  ["missing.html", "cannot read missing.html"],
  ["link.html", "link.html is not a regular file"],
  ["folder.html", "folder.html is not a regular file"],
  ["page.txt", "page.txt is not an HTML file"],
  ["invalid.html", "invalid.html is not UTF-8 text"],
  ["nul.html", "nul.html is not UTF-8 text"],
  ["large.html", "large.html is larger than 8 MiB"],
])("refuses %s without stdout", async (name, message) => {
  const target = await page();
  await symlink(target, join(root, "link.html"));
  await mkdir(join(root, "folder.html"));
  await page("<p>Seeds</p>", "page.txt");
  await writeFile(join(root, "invalid.html"), Buffer.from([0xff]));
  await page("<p>\0</p>", "nul.html");
  await page("", "large.html");
  await truncate(join(root, "large.html"), LIMITS.htmlDocBytes + 1);
  expect(await command(name)).toEqual({ code: 1, stdout: [], stderr: [`recense: ${message}\n`] });
});

test("refuses a page that fits on input but exceeds the UTF-8 byte limit with the look", async () => {
  const path = await page(`<p>${"é".repeat(Math.floor((LIMITS.htmlDocBytes - 7) / 2))}</p>`);
  const before = await readFile(path);
  expect(before.byteLength).toBeLessThanOrEqual(LIMITS.htmlDocBytes);
  expect(await command("page.html", "--no-theme")).toEqual({
    code: 1,
    stdout: [],
    stderr: ["recense: page.html would be larger than 8 MiB with recense's look\n"],
  });
  expect((await readFile(path)).equals(before)).toBe(true);
  expect((await readdir(root)).filter((name) => name.startsWith(".recense-look-"))).toEqual([]);
});

test.each([null, "</style><script>bad()</script>", "body{background:url(https://example.com/a)}"])(
  "a missing or damaged installed stylesheet refuses the command: %s",
  async (source) => {
    const path = await page();
    const before = await readFile(path);
    if (source === null) await rm(join(webRoot, "pub-frame.css"));
    else await writeFile(join(webRoot, "pub-frame.css"), source);
    expect(await command("page.html")).toEqual({
      code: 1,
      stdout: [],
      stderr: ["recense: recense's page stylesheet is missing or damaged; reinstall recense\n"],
    });
    expect(await readFile(path)).toEqual(before);
  },
);

test.each([
  [],
  ["--no-theme"],
  ["page.html", "--theme"],
  ["page.html", "--theme", "--no-theme"],
  ["page.html", "--no-theme", "--no-theme"],
  ["page.html", "--theme", "mine", "--theme", "mine"],
  ["page.html", "--theme", "mine", "--no-theme"],
  ["page.html", "--no-theme", "--theme", "mine"],
  ["page.html", "--unknown"],
  ["page.html", "--theme", "dark"],
  ["page.html", "--theme", "../bad"],
])("usage error %j exits 2", async (...args) => {
  expect(await command(...args)).toEqual({
    code: 2,
    stdout: [],
    stderr: ["recense: Usage: recense look <file.html>... [--theme <name> | --no-theme].\n"],
  });
});

test("keeps mode and group, accepts case-insensitive HTML extensions and stops in argument order", async () => {
  const first = await page("<p>First</p>", "first.HTM");
  const last = await page("<p>Last</p>", "last.HTML");
  await chmod(first, 0o764);
  const before = await lstat(first);
  expect(await command("first.HTM", "missing.html", "last.HTML")).toEqual({
    code: 1,
    stdout: ["recense: gave first.HTM recense's look\n"],
    stderr: ["recense: cannot read missing.html\n"],
  });
  const after = await lstat(first);
  expect(after.mode & 0o7777).toBe(0o764);
  expect(after.uid).toBe(before.uid);
  expect(after.gid).toBe(before.gid);
  expect(await readFile(last, "utf8")).toBe("<p>Last</p>");
  expect((await command("last.HTML")).code).toBe(0);
});

test("refuses a read-only file without changing it", async () => {
  const path = await page();
  await chmod(path, 0o444);
  const before = await readFile(path);
  const info = await lstat(path);
  expect(await command("page.html", "--no-theme")).toEqual({
    code: 1,
    stdout: [],
    stderr: ["recense: page.html is read-only\n"],
  });
  expect(await readFile(path)).toEqual(before);
  expect((await lstat(path)).ino).toBe(info.ino);
});

test.skipIf(!process.getuid)("refuses a file owned by another user without changing it", async () => {
  const path = await page();
  const before = await readFile(path);
  const info = await lstat(path);
  vi.spyOn(process, "getuid").mockReturnValue(info.uid + 1);
  expect(await command("page.html", "--no-theme")).toEqual({
    code: 1,
    stdout: [],
    stderr: ["recense: page.html belongs to another user; recense look changes only your own files\n"],
  });
  expect(await readFile(path)).toEqual(before);
  expect((await lstat(path)).ino).toBe(info.ino);
});

test.each([
  [applyHtmlLook("<p>Seeds</p>", { css, lightOnly: false }), "recense: page.html already has recense's look\n"],
  [
    '<meta name="recense-look" content="custom"><p>Seeds</p>',
    'recense: left page.html unchanged: it is marked custom with <meta name="recense-look" content="custom">\n',
  ],
  [
    "<div>".repeat(600),
    "recense: left page.html unchanged: recense could not read its structure, so it shows as a custom page\n",
  ],
])("does not require write permission or ownership for a page it leaves alone: %s", async (text, message) => {
  const path = await page(text);
  await chmod(path, 0o444);
  const info = await lstat(path);
  if (process.getuid) vi.spyOn(process, "getuid").mockReturnValue(info.uid + 1);
  expect(await command("page.html", "--no-theme")).toEqual({ code: 0, stdout: [message], stderr: [] });
  expect(await readFile(path, "utf8")).toBe(text);
  expect((await lstat(path)).ino).toBe(info.ino);
});

test.each([false, true])("restores group before mode on a private temporary file: chown fails=%s", async (fails) => {
  const path = await page();
  await chmod(path, 0o2764);
  const before = await readFile(path);
  const info = await lstat(path);
  const original = fs.open;
  const chown = vi.fn();
  const setMode = vi.fn();
  const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await original(...args);
    if (String(args[0]).includes(".recense-look-")) {
      const temporaryInfo = await handle.stat();
      temporaryInfo.gid = info.gid + 1;
      vi.spyOn(handle, "stat").mockResolvedValueOnce(temporaryInfo);
      const changeOwner = handle.chown.bind(handle);
      vi.spyOn(handle, "chown").mockImplementation(async (uid, gid) => {
        chown(uid, gid);
        if (fails) throw new Error("sensitive chown failure");
        await changeOwner(uid, gid);
      });
      const changeMode = handle.chmod.bind(handle);
      vi.spyOn(handle, "chmod").mockImplementation(async (mode) => {
        setMode(mode);
        await changeMode(mode);
      });
    }
    return handle;
  });
  const result = await command("page.html", "--no-theme");
  expect(open).toHaveBeenCalledWith(expect.stringContaining(".recense-look-"), expect.any(Number), 0o600);
  expect(chown).toHaveBeenCalledExactlyOnceWith(info.uid, info.gid);
  const after = await lstat(path);
  expect(after.mode & 0o7777).toBe(info.mode & 0o7777);
  expect(after.uid).toBe(info.uid);
  expect(after.gid).toBe(info.gid);
  if (fails) {
    expect(setMode).not.toHaveBeenCalled();
    expect(result).toEqual({
      code: 1,
      stdout: [],
      stderr: ["recense: cannot write page.html: cannot keep its group\n"],
    });
    expect(await readFile(path)).toEqual(before);
    expect(after.ino).toBe(info.ino);
  } else {
    expect(setMode).toHaveBeenCalledExactlyOnceWith(info.mode & 0o7777);
    expect(chown).toHaveBeenCalledBefore(setMode);
    expect(result).toEqual({ code: 0, stdout: ["recense: gave page.html recense's look\n"], stderr: [] });
    expect(stripHtmlLook(await readFile(path, "utf8"))).toBe(before.toString("utf8"));
    expect(after.ino).not.toBe(info.ino);
  }
  expect((await readdir(root)).filter((name) => name.startsWith(".recense-look-"))).toEqual([]);
});

test("failed replacement cleans its temporary file and keeps the original", async () => {
  const path = await page();
  const before = await readFile(path);
  vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("sensitive rename failure"));
  expect(await command("page.html")).toEqual({ code: 1, stdout: [], stderr: ["recense: cannot write page.html\n"] });
  expect(await readFile(path)).toEqual(before);
  expect((await readdir(root)).filter((name) => name.startsWith(".recense-look-"))).toEqual([]);
});

test("opens the named file with non-blocking reads", async () => {
  const path = await page();
  const open = vi.spyOn(fs, "open");
  expect((await command("page.html", "--no-theme")).code).toBe(0);
  expect(open).toHaveBeenCalledWith(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
});

test("a file that grows after the descriptor stat is refused without changing it", async () => {
  const source = "<!doctype html><p>Seeds</p>";
  const appended = "<p>Added while reading</p>";
  const path = await page(source);
  const original = fs.open;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await original(...args);
    if (args[0] === path) {
      const stat = handle.stat.bind(handle);
      vi.spyOn(handle, "stat").mockImplementation(async (options) => {
        const info = await stat(options);
        if (options?.bigint) await appendFile(path, appended);
        return info;
      });
    }
    return handle;
  });
  expect(await command("page.html", "--no-theme")).toEqual({
    code: 1,
    stdout: [],
    stderr: ["recense: cannot read page.html: it changed while recense look read it\n"],
  });
  expect(await readFile(path, "utf8")).toBe(source + appended);
  expect((await readdir(root)).filter((name) => name.startsWith(".recense-look-"))).toEqual([]);
});

test("a file replaced by a symlink before open is refused without reading its target", async () => {
  const path = await page();
  const target = await page("<p>Kept</p>", "target.html");
  const original = fs.open;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    if (args[0] === path) {
      await rm(path);
      await symlink(target, path);
    }
    return original(...args);
  });
  expect(await command("page.html", "--no-theme")).toEqual({
    code: 1,
    stdout: [],
    stderr: ["recense: cannot read page.html\n"],
  });
  expect(await readFile(target, "utf8")).toBe("<p>Kept</p>");
});

test("a replaced original is never overwritten", async () => {
  const path = await page();
  const original = fs.open;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await original(...args);
    if (String(args[0]).includes(".recense-look-")) {
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementationOnce(async () => {
        await sync();
        await rm(path);
        await symlink(join(root, "missing-target"), path);
      });
    }
    return handle;
  });
  expect(await command("page.html", "--no-theme")).toEqual({
    code: 1,
    stdout: [],
    stderr: ["recense: cannot write page.html: it changed while recense look ran\n"],
  });
  expect((await lstat(path)).isSymbolicLink()).toBe(true);
  expect((await readdir(root)).filter((name) => name.startsWith(".recense-look-"))).toEqual([]);
});

test("an original edited in place is never overwritten", async () => {
  const path = await page();
  const past = new Date(2000, 0, 1);
  await utimes(path, past, past);
  const before = await lstat(path);
  const edited = "<!doctype html><p>Trees</p>";
  expect(Buffer.byteLength(edited, "utf8")).toBe(before.size);
  const original = fs.open;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await original(...args);
    if (String(args[0]).includes(".recense-look-")) await writeFile(path, edited);
    return handle;
  });
  expect(await command("page.html", "--no-theme")).toEqual({
    code: 1,
    stdout: [],
    stderr: ["recense: cannot write page.html: it changed while recense look ran\n"],
  });
  expect(await readFile(path, "utf8")).toBe(edited);
  expect((await lstat(path)).ino).toBe(before.ino);
  expect((await readdir(root)).filter((name) => name.startsWith(".recense-look-"))).toEqual([]);
});

test("escapes paths and honours an explicit cwd and web root", async () => {
  const name = "page\nname.html";
  await page("<p>Seeds</p>", name);
  const escaped = escapeReference(name);
  await lookCommand(configDir, [name, "--no-theme"], io, { cwd: root, webRoot });
  expect(stdout).toEqual([`recense: gave ${escaped} recense's look\n`]);
  expect(stylesheet.readPubStylesheet).toHaveBeenCalledWith(webRoot);
  expect((await command("missing\npage.html")).stderr).toEqual(["recense: cannot read missing\\u{a}page.html\n"]);
  stdout.length = 0;
  expect(await run(["--help"], io)).toBe(0);
  expect(stdout[0]).toContain(
    "recense look <file.html>... [--theme <name> | --no-theme]  Give HTML files recense's look",
  );
});
