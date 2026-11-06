import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { escapeReference, quoteShellArgument } from "../cli/escape.ts";

export class StateFolderWriteError extends Error {
  readonly dir: string;
  constructor(dir: string) {
    super(`emend cannot write its state folder ${dir}.`);
    this.dir = dir;
    this.name = "StateFolderWriteError";
  }
}

/** Map only permission failures at the state folder, its parents or its contents. */
export function stateAccessError(dir: string, error: unknown): unknown {
  if (!error || typeof error !== "object") return error;
  const { code, path, cause } = error as NodeJS.ErrnoException;
  if (["EACCES", "EPERM", "EROFS"].includes(code ?? "") && typeof path === "string") {
    const contains = (parent: string, child: string) => {
      const suffix = relative(resolve(parent), resolve(child));
      return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
    };
    // A denied ancestor also prevents access to the state folder below it.
    if (contains(dir, path) || contains(path, dir)) return new StateFolderWriteError(dir);
  }
  if (cause && cause !== error) {
    const mapped = stateAccessError(dir, cause);
    if (mapped instanceof StateFolderWriteError) return mapped;
  }
  return error;
}

/** Descriptor operations omit path; retain the known file without classifying unrelated errors. */
export function stateFileError(path: string, error: unknown): unknown {
  if (
    error instanceof Error &&
    typeof (error as NodeJS.ErrnoException).code === "string" &&
    (error as NodeJS.ErrnoException).path === undefined
  )
    Object.assign(error, { path });
  return error;
}

/** Probe only when reporting a hub failure; successful requests never need this write. */
export function stateFolderWritable(dir: string): boolean {
  const path = join(dir, `.emend-probe-${randomUUID()}.tmp`);
  let created = false;
  try {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    closeSync(fd);
    rmSync(path);
    created = false;
    return true;
  } catch (error) {
    return !["EACCES", "EPERM", "EROFS"].includes((error as NodeJS.ErrnoException).code ?? "");
  } finally {
    if (created) {
      try {
        rmSync(path);
      } catch {
        /* The folder may have become unwritable during the probe. */
      }
    }
  }
}

export class StateDirModeError extends Error {
  readonly dir: string;
  constructor(dir: string) {
    const quoted = quoteShellArgument(dir);
    super(`State directory ${escapeReference(dir)} has group or other permissions; fix it with chmod 700 ${quoted}`);
    this.name = "StateDirModeError";
    this.dir = dir;
  }
}

export class TokenFileModeError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(
      `Token file ${escapeReference(path)} has group or other permissions; fix it with chmod 600 ${quoteShellArgument(path)}`,
    );
    this.name = "TokenFileModeError";
    this.path = path;
  }
}

export function isStateModeError(error: unknown): error is StateDirModeError | TokenFileModeError {
  return error instanceof StateDirModeError || error instanceof TokenFileModeError;
}

// Only chmod directories this call creates. Existing ancestors are not emend's to change.
function createPrivateDir(dir: string): void {
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      createPrivateDir(dirname(dir));
      createPrivateDir(dir);
      return;
    }
    if (code === "EEXIST" && statSync(dir).isDirectory()) return;
    throw error;
  }
  chmodSync(dir, 0o700);
}

export function ensureStateDir(dir: string): void {
  const absolute = resolve(dir);
  createPrivateDir(absolute);
  if (statSync(absolute).mode & 0o077) throw new StateDirModeError(absolute);
}

export function ensurePrivateDir(dir: string, stateDirectory: string): void {
  const root = resolve(stateDirectory);
  const suffix = relative(root, resolve(dir));
  if (suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw new Error("Private directory must be inside the state directory");
  }
  ensureStateDir(root);
  let current = root;
  for (const part of suffix.split(sep).filter(Boolean)) {
    current = join(current, part);
    createPrivateDir(current);
    chmodSync(current, 0o700);
  }
}

export function tightenSecretFile(path: string): boolean {
  try {
    chmodSync(path, 0o600);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function syncDirectory(dir: string): void {
  const fd = openSync(dir, "r");
  try {
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    throw stateFileError(dir, error);
  }
}

export function writeSecretFile(path: string, data: string | Uint8Array, stateDirectory = dirname(path)): void {
  const dir = dirname(path);
  ensurePrivateDir(dir, stateDirectory);
  const temporary = join(dir, `.emend-${randomUUID()}.tmp`);
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try {
      try {
        fchmodSync(fd, 0o600);
        writeFileSync(fd, data);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      throw stateFileError(temporary, error);
    }
    renameSync(temporary, path);
    syncDirectory(dir);
  } finally {
    rmSync(temporary, { force: true });
  }
}
