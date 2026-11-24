import { randomUUID } from "node:crypto";
import { type BigIntStats, constants, type Stats } from "node:fs";
import { type FileHandle, lstat, open, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LIMITS, ThemeName, type ThemeValid } from "@recense/contract";
import { applyHtmlLook, htmlLook } from "@recense/core";
import type { Io } from "../../main.ts";
import { readPubStylesheet } from "../../server/content/look.ts";
import { listThemes, readTheme } from "../../state/themes.ts";
import { checkThemesFolder } from "../config.ts";
import { escapeReference } from "../escape.ts";
import { CliError, CliUsageError } from "../http.ts";

const usage = "Usage: recense look <file.html>... [--theme <name> | --no-theme].";
const sameFile = (before: Stats, after: Stats) =>
  after.isFile() && before.dev === after.dev && before.ino === after.ino;

async function readHtml(path: string, arg: string): Promise<{ text: string; info: Stats; version: BigIntStats }> {
  let info: Stats;
  try {
    info = await lstat(path);
  } catch {
    throw new CliError(`cannot read ${arg}`);
  }
  if (!info.isFile()) throw new CliError(`${arg} is not a regular file`);
  if (!/\.html?$/i.test(path)) throw new CliError(`${arg} is not an HTML file`);
  const tooLarge = () => new CliError(`${arg} is larger than ${LIMITS.htmlDocBytes / 1024 / 1024} MiB`);
  if (info.size > LIMITS.htmlDocBytes) throw tooLarge();
  let handle: FileHandle | undefined;
  let bytes: Buffer;
  let version: BigIntStats;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await handle.stat();
    if (!sameFile(info, opened)) throw new CliError(`cannot read ${arg}`);
    version = await handle.stat({ bigint: true });
    if (version.size > BigInt(LIMITS.htmlDocBytes)) throw tooLarge();
    const changed = () => new CliError(`cannot read ${arg}: it changed while recense look read it`);
    bytes = Buffer.alloc(Number(version.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw changed();
      offset += bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead) throw changed();
    await handle.close();
    handle = undefined;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`cannot read ${arg}`);
  } finally {
    await handle?.close().catch(() => {});
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (text.includes("\0")) throw new Error("NUL in HTML");
    return { text, info, version };
  } catch {
    throw new CliError(`${arg} is not UTF-8 text`);
  }
}

async function writeHtml(path: string, arg: string, text: string, info: Stats, version: BigIntStats): Promise<void> {
  const temporary = join(dirname(path), `.recense-look-${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  let created = false;
  try {
    handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    await handle.writeFile(text, "utf8");
    if ((await handle.stat()).gid !== info.gid) {
      try {
        await handle.chown(info.uid, info.gid);
      } catch {
        throw new CliError(`cannot write ${arg}: cannot keep its group`);
      }
    }
    // Keep the file private until its group is restored; chown can clear set-id bits, so restore the mode last.
    await handle.chmod(info.mode & 0o7777);
    await handle.sync();
    await handle.close();
    handle = undefined;
    const current = await lstat(path, { bigint: true });
    if (
      !current.isFile() ||
      current.dev !== version.dev ||
      current.ino !== version.ino ||
      current.size !== version.size ||
      current.mtimeNs !== version.mtimeNs ||
      current.ctimeNs !== version.ctimeNs
    )
      throw new CliError(`cannot write ${arg}: it changed while recense look ran`);
    await rename(temporary, path);
  } catch (error) {
    await handle?.close().catch(() => {});
    if (created) await unlink(temporary).catch(() => {});
    if (error instanceof CliError) throw error;
    throw new CliError(`cannot write ${arg}`);
  }
}

export async function lookCommand(
  configDir: string,
  args: string[],
  io: Io,
  options: { webRoot?: string; cwd?: string } = {},
): Promise<void> {
  const files: string[] = [];
  let selection: string | false | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--theme" || arg === "--no-theme") {
      if (selection !== undefined) throw new CliUsageError(usage);
      if (arg === "--no-theme") selection = false;
      else {
        const name = ThemeName.safeParse(args[++i]);
        if (!name.success) throw new CliUsageError(usage);
        selection = name.data;
      }
    } else if (!arg || arg.startsWith("-")) throw new CliUsageError(usage);
    else files.push(arg);
  }
  if (!files.length) throw new CliUsageError(usage);
  let theme: ThemeValid | undefined;
  if (selection !== false) {
    const dir = join(configDir, "themes");
    await checkThemesFolder(dir, options.cwd, "look");
    if (selection !== undefined) {
      const entry = await readTheme(dir, selection);
      if (!entry) throw new CliError(`unknown theme ${escapeReference(selection)}`);
      if (!entry.valid)
        throw new CliError(
          `theme ${escapeReference(selection)} is refused: ${escapeReference(entry.problems[0] ?? "invalid theme")}`,
        );
      theme = entry;
    } else {
      const { themes, folderError } = await listThemes(dir);
      if (folderError) throw new CliError(`cannot list themes in ${escapeReference(dir)}`);
      const valid = themes.filter((entry) => entry.valid);
      if (valid.length === 1) theme = valid[0];
      else if (valid.length > 1)
        io.stderr("recense: several themes are valid; used recense's own colours. Pick one with --theme <name>\n");
    }
  }
  let css: string;
  try {
    css = await readPubStylesheet(options.webRoot ?? fileURLToPath(new URL("./web/", import.meta.url)));
  } catch {
    throw new CliError("recense's page stylesheet is missing or damaged; reinstall recense");
  }
  for (const file of files) {
    const arg = escapeReference(file);
    const path = resolve(options.cwd ?? process.cwd(), file);
    const { text, info, version } = await readHtml(path, arg);
    const look = htmlLook(text);
    if (look.reason === "unreadable") {
      io.stdout(`recense: left ${arg} unchanged: recense could not read its structure, so it shows as a custom page\n`);
      continue;
    }
    if (look.look === "custom") {
      io.stdout(
        `recense: left ${arg} unchanged: it is marked custom with <meta name="recense-look" content="custom">\n`,
      );
      continue;
    }
    const lightOnly = look.colorScheme === "light";
    const next = applyHtmlLook(text, { css, lightOnly, theme });
    if (Buffer.byteLength(next, "utf8") > LIMITS.htmlDocBytes)
      throw new CliError(`${arg} would be larger than ${LIMITS.htmlDocBytes / 1024 / 1024} MiB with recense's look`);
    if (next === text) {
      io.stdout(`recense: ${arg} already has recense's look\n`);
      continue;
    }
    if (process.getuid && info.uid !== process.getuid())
      throw new CliError(`${arg} belongs to another user; recense look changes only your own files`);
    if ((info.mode & 0o200) === 0) throw new CliError(`${arg} is read-only`);
    await writeHtml(path, arg, next, info, version);
    const themeNote =
      theme && (!lightOnly || theme.base === "light") ? ` and the colours of theme ${escapeReference(theme.name)}` : "";
    io.stdout(`recense: gave ${arg} recense's look${themeNote}\n`);
    if (lightOnly)
      io.stdout(`recense: ${arg} stays in light mode: its styles set colours but have no dark-mode rule\n`);
  }
}
