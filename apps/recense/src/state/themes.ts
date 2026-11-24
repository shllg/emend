import { opendir, stat } from "node:fs/promises";
import { join } from "node:path";
import { LIMITS, type ThemeEntry, type ThemeList, ThemeName, ThemeRefused } from "@recense/contract";
import { checkThemeDocument } from "@recense/core";
import { ConfigFileTooLargeError, readConfigJson } from "./read-config.ts";

function unreadableTheme(name: string, problem: string): ThemeRefused {
  const problems = ThemeName.safeParse(name).success
    ? []
    : [
        "The folder name must use lowercase letters, digits and hyphens, at most 40, and not system, dark, light or fonts.",
      ];
  return { valid: false, name, base: null, problems: [...problems, problem] };
}

async function readThemeFile(path: string, name: string): Promise<ThemeEntry> {
  let document: unknown;
  try {
    document = await readConfigJson(path, true, LIMITS.themeFileBytes);
  } catch (error) {
    const problem =
      error instanceof ConfigFileTooLargeError
        ? "theme.json is larger than 32 KiB."
        : error instanceof SyntaxError
          ? "theme.json is not valid JSON."
          : (error as NodeJS.ErrnoException).code === "ENOENT"
            ? "The folder has no theme.json."
            : "theme.json cannot be read.";
    return unreadableTheme(name, problem);
  }
  return checkThemeDocument(document, name);
}

async function themeFolderState(path: string): Promise<"folder" | "none" | "unreadable"> {
  try {
    return (await stat(path)).isDirectory() ? "folder" : "none";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP" ? "none" : "unreadable";
  }
}

/** Read only a single folder entry; a missing name is distinct from an unreadable file. */
export async function readTheme(themesDir: string | undefined, name: string): Promise<ThemeEntry | null> {
  if (
    !themesDir ||
    name === "fonts" ||
    name.startsWith(".") ||
    /[/\\]/.test(name) ||
    !ThemeRefused.shape.name.safeParse(name).success
  )
    return null;
  const folder = join(themesDir, name);
  if ((await themeFolderState(folder)) === "none") return null;
  return readThemeFile(join(folder, "theme.json"), name);
}

/** Shared, bounded directory snapshot for the list and its change fingerprint. */
export async function listThemeFolders(themesDir?: string): Promise<{
  folders: string[];
  folderError: boolean;
  status: "listed" | "missing" | "unreadable" | "too-full";
}> {
  if (!themesDir) return { folders: [], folderError: false, status: "missing" };
  const candidates = new Map<string, boolean>();
  try {
    const directory = await opendir(themesDir);
    let count = 0;
    for await (const entry of directory) {
      // One overflow probe distinguishes exactly 1000 entries from a larger folder.
      if (++count > 1000) return { folders: [], folderError: true, status: "too-full" };
      if (
        entry.name !== "fonts" &&
        !entry.name.startsWith(".") &&
        ThemeRefused.shape.name.safeParse(entry.name).success &&
        (entry.isDirectory() || entry.isSymbolicLink())
      )
        candidates.set(entry.name, entry.isDirectory());
    }
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return { folders: [], folderError: !missing, status: missing ? "missing" : "unreadable" };
  }
  const folders: string[] = [];
  for (const name of [...candidates.keys()].sort()) {
    if (candidates.get(name) || (await themeFolderState(join(themesDir, name))) !== "none") folders.push(name);
    if (folders.length === LIMITS.themes) break;
  }
  return { folders, folderError: false, status: "listed" };
}

export async function listThemes(themesDir?: string): Promise<ThemeList> {
  const { folders, folderError } = await listThemeFolders(themesDir);
  const themes: ThemeEntry[] = [];
  if (themesDir)
    for (const name of folders) themes.push(await readThemeFile(join(themesDir, name, "theme.json"), name));
  return { themes, folderError };
}
