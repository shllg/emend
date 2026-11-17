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
const seed = (name: string, document: unknown = { version: 1, base: "dark" }) =>
  writeFile(join(dir, `${name}.json`), JSON.stringify(document));

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

test("refuses displayable bad names and skips dotfiles, other extensions and undisplayable names", async () => {
  for (const name of ["Bad Name", "dark", ".hidden", "bad\nname", "x".repeat(81), ""]) await seed(name);
  await writeFile(join(dir, "other.txt"), "{}");
  const list = ThemeList.parse(await listThemes(dir));
  expect(list.themes.map((entry) => entry.name)).toEqual(["Bad Name", "dark"]);
  for (const entry of list.themes)
    expect(entry).toMatchObject({
      valid: false,
      problems: [
        "The file name must use lowercase letters, digits and hyphens, at most 40, and not system, dark or light.",
      ],
    });
});

test.each([
  ["large", " ".repeat(LIMITS.themeFileBytes + 1), "The file is larger than 32 KiB."],
  ["broken", "{ sensitive content", "The file is not valid JSON."],
  ["array", "[]", "The file must hold a JSON object."],
])("refuses %s files without exposing content", async (name, content, problem) => {
  await writeFile(join(dir, `${name}.json`), content);
  expect(await readTheme(dir, name)).toEqual({ valid: false, name, base: null, problems: [problem] });
});

test("refuses directories and dangling links and follows links to regular files and folders", async () => {
  await mkdir(join(dir, "folder.json"));
  await seed("original");
  await symlink(join(dir, "original.json"), join(dir, "linked.json"));
  await symlink(join(dir, "missing.json"), join(dir, "dangling.json"));
  await symlink(dir, join(root, "theme-link"));
  for (const name of ["folder", "dangling"])
    expect(await readTheme(dir, name)).toEqual({
      valid: false,
      name,
      base: null,
      problems: ["The file cannot be read."],
    });
  expect(await readTheme(join(root, "theme-link"), "linked")).toMatchObject({ valid: true });
  expect(await listThemes(join(root, "theme-link"))).toEqual(await listThemes(dir));
});

test("bad names still report the filename problem when the contents cannot be parsed", async () => {
  await writeFile(join(dir, "Bad.json"), "{");
  expect(await readTheme(dir, "Bad")).toEqual({
    valid: false,
    name: "Bad",
    base: null,
    problems: [
      "The file name must use lowercase letters, digits and hyphens, at most 40, and not system, dark or light.",
      "The file is not valid JSON.",
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
  for (const name of ["missing", "../outside", "/outside", "a\\b", "bad\nname"])
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
    problems: ["The file cannot be read."],
  });
});

test("config reads retain the default limit and themes allow exactly their byte limit", async () => {
  const file = join(dir, "mine.json");
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
