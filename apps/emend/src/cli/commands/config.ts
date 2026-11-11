import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Io } from "../../main.ts";
import { readConfigDocument, validateDocRoot, writeConfigDocument } from "../config.ts";
import { escapeJson, escapeReference } from "../escape.ts";
import { CliError } from "../http.ts";

const usage =
  "Usage: emend config [list] | add docRoots <folder> | remove docRoots <folder> | set openBrowser true|false.";

export async function configCommand(stateDir: string, configDir: string, args: string[], io: Io): Promise<void> {
  const [action = "list", key, value] = args;
  const list = action === "list" && args.length <= 1;
  const folder = (action === "add" || action === "remove") && key === "docRoots" && value !== "";
  const setting = action === "set" && key === "openBrowser" && (value === "true" || value === "false");
  // Config's usage errors, like its other errors, exit 1.
  if (!list && (args.length !== 3 || (!folder && !setting))) throw new CliError(usage);

  const config = await readConfigDocument(stateDir, configDir);
  if (list) {
    const json = escapeJson(JSON.stringify({ docRoots: config.docRoots, openBrowser: config.openBrowser }));
    try {
      await (io.stdoutAsync ?? io.stdout)(`${json}\n`);
    } catch {
      throw new CliError("Could not write to stdout.");
    }
    return;
  }

  let message: string;
  if (action === "set") {
    config.openBrowser = value === "true";
    message = `emend: openBrowser is now ${config.openBrowser}`;
  } else {
    const path = resolve(value as string);
    if (action === "add") {
      const actual = await docRoot(path);
      await validateDocRoot(actual, homedir(), stateDir);
      if (config.docRoots.includes(actual)) {
        io.stdout(`emend: ${escapeReference(actual)} is already in docRoots\n`);
        return;
      }
      config.docRoots.push(actual);
      message = `emend: added ${escapeReference(actual)} to docRoots`;
    } else {
      let index = config.docRoots.indexOf(value as string);
      if (index === -1) index = config.docRoots.indexOf(path);
      if (index === -1) {
        const actual = await realpath(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
          throw new CliError(`${escapeReference(path)} cannot be read`);
        });
        if (actual !== undefined) index = config.docRoots.indexOf(actual);
      }
      if (index === -1) throw new CliError(`${escapeReference(path)} is not in docRoots`);
      const [entry] = config.docRoots.splice(index, 1);
      message = `emend: removed ${escapeReference(entry as string)} from docRoots`;
    }
  }
  await writeConfigDocument(configDir, config);
  io.stdout(`${message}\n`);
}

async function docRoot(path: string): Promise<string> {
  let actual: string;
  let directory: boolean;
  try {
    actual = await realpath(path);
    directory = (await stat(actual)).isDirectory();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new CliError(`${escapeReference(path)} does not exist`);
    if (code === "ENOTDIR") throw new CliError(`${escapeReference(path)} is not a folder`);
    throw new CliError(`${escapeReference(path)} cannot be read`);
  }
  if (!directory) throw new CliError(`${escapeReference(path)} is not a folder`);
  return actual;
}
