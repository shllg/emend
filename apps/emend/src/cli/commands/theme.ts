import { type FileHandle, mkdir, open, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ThemeName } from "@emend/contract";
import { type ThemeSource, themeCopyDocument } from "@emend/core";
import type { Io } from "../../main.ts";
import { listThemes, readTheme } from "../../state/themes.ts";
import { checkThemesFolder } from "../config.ts";
import { escapeReference } from "../escape.ts";
import { CliError, CliSignalExit, CliUsageError } from "../http.ts";

const usage = "Usage: emend theme list | copy <source> <name> | check <name>.";

export async function themeCommand(configDir: string, args: string[], io: Io): Promise<void> {
  const [action, source, name] = args;
  const dir = join(configDir, "themes");
  if (action === "list" && args.length === 1) {
    await checkThemesFolder(dir);
    const { themes, folderError } = await listThemes(dir);
    if (folderError) throw new CliError(`cannot list themes in ${escapeReference(dir)}`);
    if (!themes.length) io.stdout(`emend: no themes in ${escapeReference(dir)}; use emend theme copy dark <name>\n`);
    for (const entry of themes) {
      const status = entry.valid
        ? "valid"
        : `refused: ${entry.problems[0]}${entry.problems.length > 1 ? ` (${entry.problems.length - 1} more)` : ""}`;
      io.stdout(`${escapeReference(entry.name)}\t${entry.base ?? "-"}\t${status}\n`);
    }
    return;
  }
  if (action === "check" && args.length === 2 && source) {
    await checkThemesFolder(dir);
    const entry = await readTheme(dir, source);
    if (!entry) throw new CliError(`unknown theme ${escapeReference(source)}`);
    if (entry.valid) io.stdout(`emend: ${escapeReference(source)} is valid\n`);
    else {
      for (const problem of entry.problems) io.stdout(`emend: ${escapeReference(source)}: ${problem}\n`);
      throw new CliSignalExit(1);
    }
    return;
  }
  if (action !== "copy" || args.length !== 3 || !source || !name) throw new CliUsageError(usage);
  if (!ThemeName.safeParse(name).success)
    throw new CliUsageError(
      `invalid theme name ${escapeReference(name)}; use lowercase letters, digits and hyphens, at most 40, and not system, dark or light.`,
    );
  await checkThemesFolder(dir);
  let from: ThemeSource;
  if (source === "dark" || source === "light") from = source;
  else {
    const entry = await readTheme(dir, source);
    if (!entry) throw new CliError(`unknown theme ${escapeReference(source)}`);
    if (!entry.valid) throw new CliError(`theme ${escapeReference(source)} is refused: ${entry.problems[0]}`);
    from = entry;
  }
  const folder = join(dir, name);
  const path = join(folder, "theme.json");
  const document = `${JSON.stringify(themeCopyDocument(from), null, 2)}\n`;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  } catch {
    throw new CliError(`cannot write theme ${escapeReference(path)}`);
  }
  let created = false;
  let handle: FileHandle | undefined;
  try {
    await mkdir(folder, { mode: 0o700 });
    created = true;
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(document);
    await handle.close();
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
      await unlink(path).catch(() => {});
    }
    if (created) await rmdir(folder).catch(() => {});
    if (!handle && (error as NodeJS.ErrnoException).code === "EEXIST")
      throw new CliError(`theme ${escapeReference(name)} already exists`);
    throw new CliError(`cannot write theme ${escapeReference(path)}`);
  }
  io.stdout(`emend: wrote ${escapeReference(path)}\n`);
}
