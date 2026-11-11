import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readlink, realpath, rename, unlink } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { LIMITS } from "@emend/contract";
import { StateFolderWriteError, stateAccessError } from "../state/files.ts";
import { readConfigJson } from "../state/read-config.ts";
import { escapeReference, quoteShellArgument } from "./escape.ts";
import { CliError, jsonLine } from "./http.ts";
import { inside } from "./publish/read.ts";
import { pathInRepository, repositoryRoots } from "./runtime-repository.ts";

interface Config {
  docRoots: string[];
  openBrowser: boolean;
}

export const rootRules = {
  filesystem: { config: "docRoots cannot be the filesystem root", publish: "is the filesystem root" },
  home: { config: "docRoots cannot be the home folder or hold it", publish: "is the home folder or holds it" },
  state: {
    config: "docRoots cannot hold or sit inside emend's state folder",
    publish: "holds or sits inside emend's state folder",
  },
};

export class DocRootError extends CliError {
  readonly reason: keyof typeof rootRules;
  constructor(reason: keyof typeof rootRules) {
    super(rootRules[reason].config);
    this.reason = reason;
  }
}

const accountHome = () => userInfo().homedir;

/** The real path of `path`; a missing tail is appended to its nearest existing ancestor's real path. */
async function realpathThroughAncestors(path: string): Promise<string> {
  const missing: string[] = [];
  let current = resolve(path);
  let hops = 0;
  for (;;) {
    try {
      return join(await realpath(current), ...missing);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const parent = dirname(current);
      if ((code !== "ENOENT" && code !== "ENOTDIR") || parent === current) throw error;
      if (code === "ENOENT") {
        const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
          throw error;
        });
        if (info?.isSymbolicLink()) {
          if (++hops > 40) throw Object.assign(new Error("too many symlink levels"), { code: "ELOOP", path: current });
          current = resolve(await realpath(parent), await readlink(current));
          continue;
        }
      }
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

async function checkedFolder(path: string): Promise<string> {
  try {
    return await realpathThroughAncestors(path);
  } catch {
    throw new CliError(`cannot check docRoots: ${escapeReference(path)} cannot be read`);
  }
}

/** The caller supplies a real doc root; home and state paths may still contain symlinks. */
export async function validateDocRoot(
  root: string,
  home: string,
  stateDir: string,
  getAccountHome: () => string = accountHome,
): Promise<void> {
  if (root === parse(root).root) throw new DocRootError("filesystem");
  const homes = new Set([home]);
  try {
    homes.add(getAccountHome());
  } catch {
    // A process without a passwd entry still has its environment home.
  }
  for (const folder of homes) if (inside(root, await checkedFolder(folder))) throw new DocRootError("home");
  const state = await checkedFolder(stateDir);
  if (inside(root, state) || inside(state, root)) throw new DocRootError("state");
}

/** Check stored roots in order before publish reads any document. */
export async function readDocRoots(
  stateDir: string,
  configDir: string,
  cwd: string,
  warn: (line: string) => void = () => {},
  home = homedir(),
  getAccountHome: () => string = accountHome,
): Promise<string[]> {
  const { docRoots } = await readConfig(stateDir, configDir, { cwd, home, warn });
  const roots: string[] = [];
  for (const entry of docRoots) {
    const refuse = (problem: string) => {
      const escaped = escapeReference(entry);
      return new CliError(
        `docRoots entry ${escaped} ${problem}; remove it with emend config remove docRoots ${quoteShellArgument(entry)}`,
      );
    };
    let actual: string;
    try {
      actual = await realpath(entry);
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
      throw refuse("cannot be read");
    }
    if (actual !== entry) throw refuse("is not a real path");
    try {
      await validateDocRoot(actual, home, stateDir, getAccountHome);
    } catch (error) {
      if (error instanceof DocRootError) throw refuse(rootRules[error.reason].publish);
      throw error;
    }
    roots.push(actual);
  }
  return roots;
}

type ConfigDocument = Partial<Config> & Record<string, unknown>;

interface ConfigReadOptions {
  cwd: string;
  home?: string;
  warn?: (line: string) => void;
  repositoryPolicy?: "ignore" | "refuse";
}

export async function readConfig(
  stateDir: string,
  configDir: string,
  options: ConfigReadOptions = { cwd: process.cwd() },
): Promise<Config> {
  const { docRoots, openBrowser } = await readConfigDocument(stateDir, configDir, options);
  return { docRoots, openBrowser };
}

/** Preserve unknown keys and omissions when copying a legacy file. */
async function readConfigFile(
  path: string,
  stateDir: string,
  followLink: boolean,
): Promise<ConfigDocument | undefined> {
  const invalid = () => new CliError(`invalid emend configuration in ${escapeReference(path)}`);
  let value: unknown;
  try {
    value = await readConfigJson(path, followLink);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    const mapped = stateAccessError(stateDir, error);
    if (mapped instanceof StateFolderWriteError) throw mapped;
    throw invalid();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const { docRoots = [], openBrowser = false } = value as Record<string, unknown>;
  if (
    !Array.isArray(docRoots) ||
    !docRoots.every((root) => typeof root === "string" && isAbsolute(root)) ||
    typeof openBrowser !== "boolean"
  )
    throw invalid();
  return value as ConfigDocument;
}

async function checkedConfigPath(path: string, stateDir?: string): Promise<string> {
  try {
    return await realpathThroughAncestors(path);
  } catch (error) {
    if (stateDir !== undefined) {
      const mapped = stateAccessError(stateDir, error);
      if (mapped instanceof StateFolderWriteError) throw mapped;
    }
    throw new CliError(`cannot check emend configuration in ${escapeReference(path)}`);
  }
}

async function configRepository(path: string, actual: string, options: ConfigReadOptions) {
  try {
    const roots = await repositoryRoots(options.cwd, options.home ?? homedir());
    return roots.find((root) => pathInRepository(actual, [root]));
  } catch {
    throw new CliError(`cannot check emend configuration in ${escapeReference(path)}`);
  }
}

function writeReason(error: unknown): string {
  switch ((error as NodeJS.ErrnoException).code) {
    case "EACCES":
    case "EPERM":
      return "permission denied";
    case "EROFS":
      return "read-only file system";
    case "ENOSPC":
      return "no space left on device";
    case "ENOTDIR":
      return "not a folder";
    case "EISDIR":
      return "not a regular file";
    default:
      return "file could not be written";
  }
}

/** A temporary sibling keeps replacement atomic and exclusive migration cannot clobber a winner. */
async function writeConfigFile(actual: string, data: string, exclusive: boolean): Promise<void> {
  await mkdir(dirname(actual), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(actual), `.config-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    if (exclusive) await link(temporary, actual);
    else await rename(temporary, actual);
  } finally {
    await handle.close();
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

/** Atomic replacement follows dotfile links without changing existing folder permissions. */
export async function writeConfigDocument(configDir: string, document: ConfigDocument): Promise<void> {
  const data = jsonLine(document);
  if (Buffer.byteLength(data) > LIMITS.publicJsonBytes)
    throw new CliError("emend configuration would exceed its size limit");
  const path = join(configDir, "config.json");
  const actual = await checkedConfigPath(path);
  try {
    await writeConfigFile(actual, data, false);
  } catch (error) {
    throw new CliError(`cannot write emend configuration in ${escapeReference(path)}: ${writeReason(error)}`);
  }
}

const withDefaults = (document: ConfigDocument): Config & Record<string, unknown> => ({
  ...document,
  docRoots: document.docRoots ?? [],
  openBrowser: document.openBrowser ?? false,
});

/** Migrate once in CLI readers only. A global file is never merged with an old state file. */
export async function readConfigDocument(
  stateDir: string,
  configDir: string,
  options: ConfigReadOptions = { cwd: process.cwd() },
): Promise<Config & Record<string, unknown>> {
  const path = join(configDir, "config.json");
  const oldPath = join(stateDir, "config.json");
  const actual = await checkedConfigPath(path);
  const repository = await configRepository(path, actual, options);
  if (repository && options.repositoryPolicy === "refuse")
    throw new CliError(
      `the emend config file ${escapeReference(path)} sits inside the repository at ${escapeReference(repository)}; run emend config outside it`,
    );
  const sameFile = actual === (await checkedConfigPath(oldPath, stateDir));
  if (repository) {
    options.warn?.(
      `emend: ignoring ${escapeReference(path)}: it sits inside the repository at ${escapeReference(repository)}\n`,
    );
    return withDefaults(sameFile ? {} : ((await readConfigFile(oldPath, stateDir, false)) ?? {}));
  }
  let document = await readConfigFile(path, stateDir, true);
  if (sameFile) return withDefaults(document ?? {});
  let copied = false;
  if (document === undefined) {
    const old = await readConfigFile(oldPath, stateDir, false);
    if (old === undefined) return withDefaults({});
    try {
      await writeConfigFile(actual, jsonLine(old), true);
      document = old;
      copied = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return withDefaults(old);
      document = await readConfigFile(path, stateDir, true);
      if (document === undefined) return withDefaults(old);
    }
  }
  // A failed archive is harmless: future reads still use the global file without re-importing anything.
  const archived = await rename(oldPath, `${oldPath}.migrated`).then(
    () => true,
    () => false,
  );
  if (archived && !copied)
    options.warn?.(
      `emend: ${escapeReference(oldPath)} was not copied because ${escapeReference(path)} already exists; it is kept as ${escapeReference(`${oldPath}.migrated`)}\n`,
    );
  return withDefaults(document);
}
