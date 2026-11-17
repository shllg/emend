import * as fs from "node:fs/promises";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIMITS, ThemeList } from "@emend/contract";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { readConfigJson } from "./read-config.ts";
import { listThemes, readTheme } from "./themes.ts";

vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof import("node:fs/promises")>()) }));

let root: string;
let dir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "emend-themes-"));
  vi.stubEnv("XDG_CONFIG_HOME", join(root, "config"));
  vi.stubEnv("EMEND_HOME", join(root, "state"));
  dir = join(root, "config", "emend", "themes");
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
  await seed("zeta", { version: 1, base: "light", tokens: { "border-1": "#ABC" } });
  await seed("alpha", { version: 1, base: "dark", tokens: { "fg-1": "#111" } });
  const list = ThemeList.parse(await listThemes(dir));
  expect(list.folderError).toBe(false);
  expect(list.themes.map((entry) => entry.name)).toEqual(["alpha", "zeta"]);
  expect(list.themes[0]).toMatchObject({
    valid: false,
    base: "dark",
    problems: expect.arrayContaining([expect.stringContaining("fg-1 on bg-app:")]),
  });
  expect(list.themes[1]).toMatchObject({ valid: true, base: "light", tokens: { "border-1": "#aabbcc" } });
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
        "The folder name must use lowercase letters, digits and hyphens, at most 40, and not system, dark or light.",
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

test("a folder without theme.json and a dangling folder link are refused, not missing", async () => {
  await mkdir(join(dir, "empty"));
  await symlink(join(root, "missing"), join(dir, "dangling"));
  const list = ThemeList.parse(await listThemes(dir));
  expect(list.themes.map((entry) => entry.name)).toEqual(["dangling", "empty"]);
  for (const name of ["dangling", "empty"]) {
    const entry = { valid: false, name, base: null, problems: ["The folder has no theme.json."] };
    expect(await readTheme(dir, name)).toEqual(entry);
    expect(list.themes).toContainEqual(entry);
  }
  expect(await readTheme(dir, "missing")).toBeNull();
});

test("refuses a directory as theme.json and a file as a theme folder", async () => {
  await mkdir(join(dir, "folder", "theme.json"), { recursive: true });
  await writeFile(join(dir, "file"), "{}");
  for (const name of ["folder", "file"])
    expect(await readTheme(dir, name)).toEqual({
      valid: false,
      name,
      base: null,
      problems: ["theme.json cannot be read."],
    });
});

test("bad names still report the folder name problem when the contents cannot be parsed", async () => {
  await mkdir(join(dir, "Bad"));
  await writeFile(join(dir, "Bad", "theme.json"), "{");
  expect(await readTheme(dir, "Bad")).toEqual({
    valid: false,
    name: "Bad",
    base: null,
    problems: [
      "The folder name must use lowercase letters, digits and hyphens, at most 40, and not system, dark or light.",
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
