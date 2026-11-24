import { execFile } from "node:child_process";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { LIMITS, ThemeList, type ThemeValid } from "@recense/contract";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { readConfigJson } from "./read-config.ts";
import { readThemeFont, themeFontProblems } from "./theme-fonts.ts";
import { listThemeFolders, listThemes, readTheme } from "./themes.ts";

vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof import("node:fs/promises")>()) }));

let root: string;
let dir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "recense-themes-"));
  vi.stubEnv("XDG_CONFIG_HOME", join(root, "config"));
  vi.stubEnv("RECENSE_HOME", join(root, "state"));
  dir = join(root, "config", "recense", "themes");
  await mkdir(dir, { recursive: true });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
async function seed(name: string, document: unknown = { version: 1, base: "dark" }) {
  await mkdir(join(dir, name));
  await writeFile(join(dir, name, "theme.json"), JSON.stringify(document));
}

test("lists normalized valid themes and fixed refusal reasons in name order", async () => {
  await seed("zeta", { version: 1, base: "light", density: "roomy", tokens: { "border-1": "#ABC" } });
  await seed("alpha", { version: 1, base: "dark", tokens: { "fg-1": "#111" } });
  const list = ThemeList.parse(await listThemes(dir));
  expect(list.folderError).toBe(false);
  expect(list.themes.map((entry) => entry.name)).toEqual(["alpha", "zeta"]);
  expect(list.themes[0]).toMatchObject({
    valid: false,
    base: "dark",
    problems: expect.arrayContaining([expect.stringContaining("fg-1 on bg-app:")]),
  });
  expect(list.themes[1]).toMatchObject({
    valid: true,
    base: "light",
    density: "roomy",
    tokens: { "border-1": "#aabbcc" },
  });
  expect(await readTheme(dir, "zeta")).toEqual(list.themes[1]);
});

test("refuses displayable bad names and skips dot folders, top-level files and undisplayable names", async () => {
  for (const name of ["Bad Name", "dark", ".hidden", "bad\nname", "x".repeat(81)]) await seed(name);
  await writeFile(join(dir, "x.json"), JSON.stringify({ version: 1, base: "dark" }));
  await writeFile(join(dir, "plain"), "{}");
  await writeFile(join(dir, "other.txt"), "{}");
  const list = ThemeList.parse(await listThemes(dir));
  expect(list.themes.map((entry) => entry.name)).toEqual(["Bad Name", "dark"]);
  for (const entry of list.themes)
    expect(entry).toMatchObject({
      valid: false,
      problems: [
        "The folder name must use lowercase letters, digits and hyphens, at most 40, and not system, dark, light or fonts.",
      ],
    });
});

test.each([
  ["large", " ".repeat(LIMITS.themeFileBytes + 1), "theme.json is larger than 32 KiB."],
  ["broken", "{ sensitive content", "theme.json is not valid JSON."],
  ["array", "[]", "The file must hold a JSON object."],
])("refuses %s files without exposing content", async (name, content, problem) => {
  await mkdir(join(dir, name));
  await writeFile(join(dir, name, "theme.json"), content);
  expect(await readTheme(dir, name)).toEqual({ valid: false, name, base: null, problems: [problem] });
});

test("lists and reads symlinked theme folders and follows links to theme.json and the themes folder", async () => {
  await seed("original");
  await symlink(join(dir, "original"), join(dir, "linked"));
  await mkdir(join(dir, "file-link"));
  await symlink(join(dir, "original", "theme.json"), join(dir, "file-link", "theme.json"));
  await symlink(dir, join(root, "theme-link"));
  const list = ThemeList.parse(await listThemes(dir));
  expect(list.themes.map((entry) => [entry.name, entry.valid])).toEqual([
    ["file-link", true],
    ["linked", true],
    ["original", true],
  ]);
  expect(await readTheme(dir, "linked")).toMatchObject({ name: "linked", valid: true });
  expect(await readTheme(dir, "file-link")).toMatchObject({ name: "file-link", valid: true });
  expect(await readTheme(join(root, "theme-link"), "linked")).toMatchObject({ valid: true });
  expect(await listThemes(join(root, "theme-link"))).toEqual(list);
});

test.each(["file", "dangling", "loop", "non-directory parent"])(
  "skips %s symlinks when listing and reading themes",
  async (kind) => {
    const path = join(dir, "linked");
    const target = join(root, "target");
    if (kind === "file" || kind === "non-directory parent") await writeFile(target, "{}");
    await symlink(kind === "loop" ? path : kind === "non-directory parent" ? join(target, "child") : target, path);
    expect(await listThemes(dir)).toEqual({ themes: [], folderError: false });
    expect(await readTheme(dir, "linked")).toBeNull();
  },
);

test("a folder without theme.json and a symlink to it are refused, not missing", async () => {
  await mkdir(join(dir, "empty"));
  await symlink(join(dir, "empty"), join(dir, "linked"));
  const list = ThemeList.parse(await listThemes(dir));
  expect(list.themes.map((entry) => entry.name)).toEqual(["empty", "linked"]);
  for (const name of ["empty", "linked"]) {
    const entry = { valid: false, name, base: null, problems: ["The folder has no theme.json."] };
    expect(await readTheme(dir, name)).toEqual(entry);
    expect(list.themes).toContainEqual(entry);
  }
  expect(await readTheme(dir, "missing")).toBeNull();
});

test("unreadable symlink targets are listed and read as refused themes", async () => {
  const target = join(root, "target");
  await mkdir(target);
  await writeFile(join(target, "theme.json"), "{}");
  await symlink(target, join(dir, "linked"));
  vi.spyOn(fs, "stat").mockRejectedValue(Object.assign(new Error("sensitive failure"), { code: "EACCES" }));
  const entry = { valid: false, name: "linked", base: null, problems: ["theme.json cannot be read."] };
  expect(await listThemes(dir)).toEqual({ themes: [entry], folderError: false });
  expect(await readTheme(dir, "linked")).toEqual(entry);
});

test("refuses a directory as theme.json and treats a top-level file as an unknown name", async () => {
  await mkdir(join(dir, "folder", "theme.json"), { recursive: true });
  await writeFile(join(dir, "file"), "{}");
  expect(await readTheme(dir, "folder")).toEqual({
    valid: false,
    name: "folder",
    base: null,
    problems: ["theme.json cannot be read."],
  });
  expect(await readTheme(dir, "file")).toBeNull();
});

test("bad names still report the folder name problem when the contents cannot be parsed", async () => {
  await mkdir(join(dir, "Bad"));
  await writeFile(join(dir, "Bad", "theme.json"), "{");
  expect(await readTheme(dir, "Bad")).toEqual({
    valid: false,
    name: "Bad",
    base: null,
    problems: [
      "The folder name must use lowercase letters, digits and hyphens, at most 40, and not system, dark, light or fonts.",
      "theme.json is not valid JSON.",
    ],
  });
});

test("lists at most 50 displayable names in sorted order", async () => {
  for (let i = 54; i >= 0; i--) await seed(`theme-${String(i).padStart(2, "0")}`);
  const list = ThemeList.parse(await listThemes(dir));
  expect(list.themes.map((entry) => entry.name)).toEqual(
    Array.from({ length: 50 }, (_, i) => `theme-${String(i).padStart(2, "0")}`),
  );
  expect(await readTheme(dir, "theme-54")).toMatchObject({ valid: true });
});

test("60 links to files sorted before a theme folder do not consume theme slots", async () => {
  const target = join(root, "file");
  await writeFile(target, "{}");
  for (let i = 0; i < 60; i++) await symlink(target, join(dir, `link-${String(i).padStart(2, "0")}`));
  await seed("zeta");
  expect(await listThemes(dir)).toMatchObject({ themes: [{ valid: true, name: "zeta" }], folderError: false });
});

test("1000 folder entries are allowed; 1001 refuses the whole list, including ignored entries", async () => {
  const opendir = vi.spyOn(fs, "opendir");
  await seed("mine");
  for (let i = 0; i < 999; i++) await writeFile(join(dir, `.ignored-${i}`), "");
  expect(await listThemes(dir)).toMatchObject({ themes: [{ valid: true, name: "mine" }], folderError: false });
  await writeFile(join(dir, "overflow"), "");
  expect(await listThemes(dir)).toEqual({ themes: [], folderError: true });
  expect(opendir.mock.calls).toEqual([[dir], [dir]]);
});

test("missing or unconfigured folders are empty; missing or unsafe names are absent", async () => {
  expect(await listThemes(join(root, "absent"))).toEqual({ themes: [], folderError: false });
  expect(await listThemes()).toEqual({ themes: [], folderError: false });
  for (const name of ["missing", "../outside", "/outside", "a\\b", "bad\nname", "", ".hidden"])
    expect(await readTheme(dir, name)).toBeNull();
  expect(await readTheme(undefined, "mine")).toBeNull();
});

test("an unlistable existing folder sets folderError without returning the error", async () => {
  vi.spyOn(fs, "opendir").mockRejectedValueOnce(Object.assign(new Error("sensitive failure"), { code: "EACCES" }));
  expect(await listThemes(dir)).toEqual({ themes: [], folderError: true });
});

test("unreadable files have a fixed refusal", async () => {
  await seed("mine");
  vi.spyOn(fs, "open").mockRejectedValueOnce(Object.assign(new Error("sensitive failure"), { code: "EACCES" }));
  expect(await readTheme(dir, "mine")).toEqual({
    valid: false,
    name: "mine",
    base: null,
    problems: ["theme.json cannot be read."],
  });
});

test("config reads retain the default limit and themes allow exactly their byte limit", async () => {
  await mkdir(join(dir, "mine"));
  const file = join(dir, "mine", "theme.json");
  const content = JSON.stringify({ version: 1, base: "dark" });
  await writeFile(file, content.padEnd(LIMITS.themeFileBytes));
  expect(await readTheme(dir, "mine")).toMatchObject({ valid: true });
  // A separate caller can still choose its own byte limit.
  await expect(readConfigJson(file, true, LIMITS.themeFileBytes - 1)).rejects.toThrow();
  await writeFile(file, "{}".padEnd(LIMITS.publicJsonBytes));
  expect(await readConfigJson(file)).toEqual({});
  await writeFile(file, "{}".padEnd(LIMITS.publicJsonBytes + 1));
  await expect(readConfigJson(file)).rejects.toThrow();
});

async function fontFile(file = "Example.woff2", bytes = Buffer.from("synthetic font bytes")) {
  await mkdir(join(dir, "fonts"), { recursive: true });
  const path = join(dir, "fonts", file);
  await writeFile(path, bytes);
  return path;
}

test("the shared fonts folder is neither listed nor read as a theme", async () => {
  await seed("fonts");
  await seed("mine");
  expect((await listThemeFolders(dir)).folders).toEqual(["mine"]);
  expect((await listThemes(dir)).themes.map((entry) => entry.name)).toEqual(["mine"]);
  expect(await readTheme(dir, "fonts")).toBeNull();
});

test("font reads serve synthetic bytes with the type chosen from the extension", async () => {
  const bytes = Buffer.from("synthetic font bytes");
  const path = await fontFile("Example.WOFF2", bytes);
  const open = vi.spyOn(fs, "open");
  expect(await readThemeFont(dir, "Example.WOFF2")).toEqual({ bytes, type: "font/woff2" });
  expect(open).toHaveBeenCalledExactlyOnceWith(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
});

test.each([
  "Example.css",
  "sub/x.woff2",
  "sub\\x.woff2",
  "../x.woff2",
  "x..woff2",
  "x%2Fy.woff2",
  ".x.woff2",
  "x\0.woff2",
  "x.woff2\n",
])("font reads refuse unsafe name %j before accessing files", async (file) => {
  const resolve = vi.spyOn(fs, "realpath");
  expect(await readThemeFont(dir, file)).toBe("outside");
  expect(resolve).not.toHaveBeenCalled();
});

test.each(["directory", "directory link", "outside link", "subfolder link"])("font reads refuse a %s", async (kind) => {
  await mkdir(join(dir, "fonts"));
  const path = join(dir, "fonts", "Example.woff2");
  if (kind === "directory") await mkdir(path);
  else if (kind === "directory link") {
    await mkdir(join(dir, "fonts", "folder"));
    await symlink(join(dir, "fonts", "folder"), path);
  } else {
    const target = kind === "outside link" ? root : join(dir, "fonts", "sub");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "target.woff2"), "synthetic font bytes");
    await symlink(join(target, "target.woff2"), path);
  }
  const open = vi.spyOn(fs, "open");
  expect(await readThemeFont(dir, "Example.woff2")).toBe("outside");
  expect(open).not.toHaveBeenCalled();
});

test("font reads follow a file link only within the same real folder", async () => {
  const path = await fontFile();
  await symlink(path, join(dir, "fonts", "Alias.woff2"));
  expect(await readThemeFont(dir, "Alias.woff2")).toEqual(await readThemeFont(dir, "Example.woff2"));
});

test("the shared fonts folder may itself be a symlink", async () => {
  const folder = join(root, "shared-fonts");
  await mkdir(folder);
  const bytes = Buffer.from("synthetic font bytes");
  await writeFile(join(folder, "Example.woff2"), bytes);
  await symlink(folder, join(dir, "fonts"));
  expect(await readThemeFont(dir, "Example.woff2")).toEqual({ bytes, type: "font/woff2" });
  expect((await listThemeFolders(dir)).folders).toEqual([]);
});

test.skipIf(process.platform === "win32")("font reads refuse a FIFO without opening it", async () => {
  await mkdir(join(dir, "fonts"));
  await promisify(execFile)("mkfifo", [join(dir, "fonts", "Pipe.woff2")]);
  const open = vi.spyOn(fs, "open");
  expect(await readThemeFont(dir, "Pipe.woff2")).toBe("outside");
  expect(open).not.toHaveBeenCalled();
});

test("font reads allow exactly the byte cap and refuse one more byte", async () => {
  const bytes = Buffer.alloc(LIMITS.themeFontBytes, 42);
  await fontFile("Exact.woff2", bytes);
  const result = await readThemeFont(dir, "Exact.woff2");
  if (typeof result === "string") throw new Error(`Expected font bytes, got ${result}`);
  expect(result.type).toBe("font/woff2");
  expect(result.bytes.equals(bytes)).toBe(true);
  await fontFile("Large.woff2", Buffer.alloc(LIMITS.themeFontBytes + 1));
  expect(await readThemeFont(dir, "Large.woff2")).toBe("too-large");
});

test("font reads report missing and unreadable files without exposing errors", async () => {
  expect(await readThemeFont(undefined, "Missing.woff2")).toBe("missing");
  expect(await readThemeFont(dir, "Missing.woff2")).toBe("missing");
  await fontFile();
  expect(await readThemeFont(dir, "Missing.woff2")).toBe("missing");
  vi.spyOn(fs, "open").mockRejectedValueOnce(Object.assign(new Error("sensitive failure"), { code: "EACCES" }));
  expect(await readThemeFont(dir, "Example.woff2")).toBe("unreadable");
});

test.each(["file", "outside link"])("font reads refuse replacement with a new %s before open", async (kind) => {
  const path = await fontFile();
  const outside = join(root, "Outside.woff2");
  await writeFile(outside, "synthetic outside bytes");
  const original = fs.open;
  vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
    await fs.rename(path, join(dir, "fonts", "Previous.woff2"));
    if (kind === "file") await writeFile(path, "synthetic replacement bytes");
    else await symlink(outside, path);
    return original(...args);
  });
  expect(await readThemeFont(dir, "Example.woff2")).toBe(kind === "file" ? "unreadable" : "outside");
});

test.each(["growth", "over cap", "truncation"])("font reads refuse %s after fstat and close the file", async (kind) => {
  const path = await fontFile();
  const original = fs.open;
  let handle: fs.FileHandle | undefined;
  vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
    const opened = await original(...args);
    handle = opened;
    const info = await opened.stat();
    if (kind === "truncation") await fs.truncate(path, 0);
    else await fs.appendFile(path, kind === "over cap" ? Buffer.alloc(LIMITS.themeFontBytes) : "more");
    vi.spyOn(opened, "stat").mockResolvedValueOnce(info);
    vi.spyOn(opened, "close");
    return opened;
  });
  expect(await readThemeFont(dir, "Example.woff2")).toBe(kind === "over cap" ? "too-large" : "unreadable");
  expect(handle?.close).toHaveBeenCalledOnce();
});

test.skipIf(process.platform !== "linux")(
  "font reads verify the opened descriptor's real path before reading",
  async () => {
    await fontFile();
    const originalPath = fs.realpath;
    vi.spyOn(fs, "realpath").mockImplementation(async (...args) => {
      if (String(args[0]).startsWith("/proc/self/fd/")) return join(root, "Outside.woff2");
      return originalPath(...args);
    });
    const originalOpen = fs.open;
    let handle: fs.FileHandle | undefined;
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      const opened = await originalOpen(...args);
      handle = opened;
      vi.spyOn(opened, "read");
      vi.spyOn(opened, "close");
      return opened;
    });
    expect(await readThemeFont(dir, "Example.woff2")).toBe("outside");
    expect(handle?.read).not.toHaveBeenCalled();
    expect(handle?.close).toHaveBeenCalledOnce();
  },
);

test("font diagnostics report one fixed line per distinct problem file", async () => {
  await fontFile("Good.woff2");
  await fontFile("Large.woff2", Buffer.alloc(LIMITS.themeFontBytes + 1));
  await mkdir(join(dir, "fonts", "Folder.woff2"));
  const entry: ThemeValid = {
    valid: true,
    name: "mine",
    base: "dark",
    fonts: {
      text: "Example",
      files: ["Good.woff2", "Missing.woff2", "Large.woff2", "Folder.woff2", "Missing.woff2"].map((file) => ({
        font: "text",
        file,
      })),
    },
    scales: {},
    tokens: {},
    themeColor: "#171717",
  };
  expect(await themeFontProblems(dir, entry)).toEqual([
    "font file Missing.woff2 is missing; the theme uses recense's font instead.",
    "font file Large.woff2 is larger than 4 MiB; the theme uses recense's font instead.",
    "font file Folder.woff2 is not a regular file directly in the fonts folder; the theme uses recense's font instead.",
  ]);
  vi.spyOn(fs, "open").mockRejectedValueOnce(Object.assign(new Error("sensitive failure"), { code: "EACCES" }));
  expect((await themeFontProblems(dir, entry))[0]).toBe(
    "font file Good.woff2 cannot be read; the theme uses recense's font instead.",
  );
});
