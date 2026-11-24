import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { LIMITS } from "@recense/contract";
import { stateFileError } from "./files.ts";

export class ConfigFileTooLargeError extends Error {}

/** Bounded read of a config file. Global dotfile links are followed; legacy files are not. */
export async function readConfigJson(
  path: string,
  followLink = true,
  byteLimit: number = LIMITS.publicJsonBytes,
): Promise<unknown> {
  const actualPath = await realpath(path);
  const file = followLink ? actualPath : path;
  const info = await lstat(file);
  if (!info.isFile()) throw new Error("Invalid config file");
  if (info.size > byteLimit) throw new ConfigFileTooLargeError("Invalid config file");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino)
      throw new Error("Config file changed while reading");
    if (opened.size > byteLimit) throw new ConfigFileTooLargeError("Invalid config file");
    const actual = await realpath(file);
    const resolved = await stat(actual);
    if (resolved.dev !== opened.dev || resolved.ino !== opened.ino)
      throw new Error("Config file changed while reading");
    if (process.platform === "linux" && (await realpath(`/proc/self/fd/${handle.fd}`)) !== actual)
      throw new Error("Config file changed while reading");
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error("Config file changed while reading");
      offset += bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead) {
      if (offset >= byteLimit) throw new ConfigFileTooLargeError("Invalid config file");
      throw new Error("Config file changed while reading");
    }
    return JSON.parse(bytes.toString());
  } catch (error) {
    throw stateFileError(file, error);
  } finally {
    await handle.close().catch((error: unknown) => {
      throw stateFileError(file, error);
    });
  }
}
