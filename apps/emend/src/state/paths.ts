import { lstatSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

type Env = Record<string, string | undefined>;

export function stateDir(env: Env, platform: string, home: string): string {
  if (env.EMEND_HOME) {
    if (!isAbsolute(env.EMEND_HOME)) throw new Error("EMEND_HOME must be an absolute path");
    return env.EMEND_HOME;
  }
  if (platform === "darwin") return join(home, "Library", "Application Support", "emend");
  const dataHome =
    env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(home, ".local", "share");
  return join(dataHome, "emend");
}

export function configDir(env: Env, home: string): string {
  const configHome =
    env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(home, ".config");
  return join(configHome, "emend");
}

export function defaultConfigDir(env: Env = process.env): string {
  const dir = configDir(env, homedir());
  if (process.env.VITEST || env.VITEST) {
    if (!inside(resolve(tmpdir()), resolve(dir)))
      throw new Error("Tests require the config folder inside the temporary directory");
    if (!inside(realpathSync(tmpdir()), canonicalPath(resolve(dir))))
      throw new Error("Tests require the config folder to resolve inside the temporary directory");
  }
  return dir;
}

const inside = (root: string, path: string) => {
  const suffix = relative(root, path);
  return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
};

export function defaultStateDir(env: Env = process.env): string {
  if (process.env.VITEST || env.VITEST) {
    if (!env.EMEND_HOME || !inside(resolve(tmpdir()), resolve(env.EMEND_HOME))) {
      throw new Error("Tests require EMEND_HOME inside the temporary directory");
    }
    if (!inside(realpathSync(tmpdir()), canonicalPath(resolve(env.EMEND_HOME)))) {
      throw new Error("Tests require EMEND_HOME to resolve inside the temporary directory");
    }
  }
  return stateDir(env, process.platform, homedir());
}

// A test home may not exist yet; resolve symlinks in its nearest existing ancestor.
function canonicalPath(path: string): string {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return join(canonicalPath(dirname(path)), basename(path));
  }
  return realpathSync(path);
}
