import { lstat, opendir } from "node:fs/promises";
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

/** Shared, bounded directory snapshot for the list and its change fingerprint. */
export async function listThemeFiles(themesDir?: string): Promise<{
  files: string[];
  folderError: boolean;
  status: "listed" | "missing" | "unreadable" | "too-full";
}> {
  if (!themesDir) return { files: [], folderError: false, status: "missing" };
  const files: string[] = [];
  try {
    const directory = await opendir(themesDir);
    let count = 0;
    for await (const entry of directory) {
      // One overflow probe distinguishes exactly 1000 entries from a larger folder.
      if (++count > 1000) return { files: [], folderError: true, status: "too-full" };
      if (themeFileName(entry.name) && ThemeRefused.shape.name.safeParse(entry.name.slice(0, -5)).success)
        files.push(entry.name);
    }
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return { files: [], folderError: !missing, status: missing ? "missing" : "unreadable" };
  }
  // Sort by the displayed name, without the extension.
  files.sort((a, b) => (a.slice(0, -5) < b.slice(0, -5) ? -1 : 1));
  return { files: files.slice(0, LIMITS.themes), folderError: false, status: "listed" };
}

export async function listThemes(themesDir?: string): Promise<ThemeList> {
  const { files, folderError } = await listThemeFiles(themesDir);
  const themes: ThemeEntry[] = [];
  if (themesDir) for (const file of files) themes.push(await readThemeFile(join(themesDir, file), file.slice(0, -5)));
  return { themes, folderError };
}
