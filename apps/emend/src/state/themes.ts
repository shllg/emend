import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { LIMITS, type ThemeEntry, type ThemeList, ThemeName, ThemeRefused } from "@emend/contract";
import { checkThemeDocument } from "@emend/core";
import { ConfigFileTooLargeError, readConfigJson } from "./read-config.ts";

export function themeFileName(file: string): boolean {
  return !file.startsWith(".") && file.endsWith(".json");
}

function unreadableTheme(name: string, problem: string): ThemeRefused {
  const problems = ThemeName.safeParse(name).success
    ? []
    : ["The file name must use lowercase letters, digits and hyphens, at most 40, and not system, dark or light."];
  return { valid: false, name, base: null, problems: [...problems, problem] };
}

async function readThemeFile(path: string, name: string): Promise<ThemeEntry> {
  let document: unknown;
  try {
    document = await readConfigJson(path, true, LIMITS.themeFileBytes);
  } catch (error) {
    const problem =
      error instanceof ConfigFileTooLargeError
        ? "The file is larger than 32 KiB."
        : error instanceof SyntaxError
          ? "The file is not valid JSON."
          : "The file cannot be read.";
    return unreadableTheme(name, problem);
  }
  return checkThemeDocument(document, name);
}

/** Read only a single folder entry; a missing name is distinct from an unreadable file. */
export async function readTheme(themesDir: string | undefined, name: string): Promise<ThemeEntry | null> {
  if (!themesDir || name.startsWith(".") || /[/\\]/.test(name) || !ThemeRefused.shape.name.safeParse(name).success)
    return null;
  const path = join(themesDir, `${name}.json`);
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return unreadableTheme(name, "The file cannot be read.");
  }
  return readThemeFile(path, name);
}

export async function listThemes(themesDir?: string): Promise<ThemeList> {
  if (!themesDir) return { themes: [], folderError: false };
  let files: string[];
  try {
    files = await readdir(themesDir);
  } catch (error) {
    return { themes: [], folderError: (error as NodeJS.ErrnoException).code !== "ENOENT" };
  }
  const names = files
    .filter(themeFileName)
    .map((file) => file.slice(0, -5))
    .filter((name) => ThemeRefused.shape.name.safeParse(name).success)
    .sort()
    .slice(0, LIMITS.themes);
  const themes: ThemeEntry[] = [];
  for (const name of names) themes.push(await readThemeFile(join(themesDir, `${name}.json`), name));
  return { themes, folderError: false };
}
