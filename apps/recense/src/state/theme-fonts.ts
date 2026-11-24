import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LIMITS, ThemeFontFileName, type ThemeValid, themeFontType } from "@recense/contract";

type FontProblem = "missing" | "outside" | "too-large" | "unreadable";
type FontRead = { bytes: Buffer; type: NonNullable<ReturnType<typeof themeFontType>> } | FontProblem;

/** Read only a bounded regular file directly inside the real shared fonts folder. */
export async function readThemeFont(themesDir: string | undefined, file: string): Promise<FontRead> {
  if (!ThemeFontFileName.safeParse(file).success) return "outside";
  const type = themeFontType(file);
  if (!type) return "outside";
  if (!themesDir) return "missing";
  try {
    const folder = await realpath(join(themesDir, "fonts"));
    const path = await realpath(join(folder, file));
    if (dirname(path) !== folder) return "outside";
    const info = await lstat(path);
    if (!info.isFile()) return "outside";
    if (info.size > LIMITS.themeFontBytes) return "too-large";
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat();
      if (!opened.isFile()) return "outside";
      if (opened.dev !== info.dev || opened.ino !== info.ino) return "unreadable";
      if (opened.size > LIMITS.themeFontBytes) return "too-large";
      const checkPath = async (): Promise<boolean> => {
        if ((await realpath(join(themesDir, "fonts"))) !== folder || (await realpath(path)) !== path) return false;
        const resolved = await stat(path);
        if (resolved.dev !== opened.dev || resolved.ino !== opened.ino) return false;
        return process.platform !== "linux" || (await realpath(`/proc/self/fd/${handle.fd}`)) === path;
      };
      if (!(await checkPath())) return "outside";
      const bytes = Buffer.alloc(opened.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) return "unreadable";
        offset += bytesRead;
      }
      if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead)
        return offset >= LIMITS.themeFontBytes || (await handle.stat()).size > LIMITS.themeFontBytes
          ? "too-large"
          : "unreadable";
      if (!(await checkPath())) return "outside";
      return { bytes, type };
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "missing";
    if (code === "ENOTDIR" || code === "ELOOP") return "outside";
    return "unreadable";
  }
}

export async function themeFontProblems(themesDir: string, entry: ThemeValid): Promise<string[]> {
  const reasons: Record<FontProblem, string> = {
    missing: "is missing",
    outside: "is not a regular file directly in the fonts folder",
    "too-large": "is larger than 4 MiB",
    unreadable: "cannot be read",
  };
  const problems: string[] = [];
  for (const file of new Set(entry.fonts.files?.map((entry) => entry.file))) {
    const result = await readThemeFont(themesDir, file);
    if (typeof result === "string")
      problems.push(`font file ${file} ${reasons[result]}; the theme uses recense's font instead.`);
  }
  return problems;
}
