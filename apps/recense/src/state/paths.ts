import { lstatSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

type Env = Record<string, string | undefined>;

/** The state folder the user chose with RECENSE_HOME (or the old EMEND_HOME), if any. */
export function homeOverride(env: Env): { name: string; value: string } | undefined {
  if (env.RECENSE_HOME) return { name: "RECENSE_HOME", value: env.RECENSE_HOME };
  if (env.EMEND_HOME) return { name: "EMEND_HOME", value: env.EMEND_HOME };
  return undefined;
}

/** The state folder under a product name; `recense` is the current one, `emend` the one before the rename. */
export function namedStateDir(name: string, env: Env, platform: string, home: string): string {
  if (platform === "darwin") return join(home, "Library", "Application Support", name);
  const dataHome =
    env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(home, ".local", "share");
  return join(dataHome, name);
}

export function namedConfigDir(name: string, env: Env, home: string): string {
  const configHome =
    env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(home, ".config");
  return join(configHome, name);
}

export function stateDir(env: Env, platform: string, home: string): string {
  const override = homeOverride(env);
  if (override) {
    if (!isAbsolute(override.value)) throw new Error(`${override.name} must be an absolute path`);
    return override.value;
  }
  return namedStateDir("recense", env, platform, home);
}

export function configDir(env: Env, home: string): string {
  return namedConfigDir("recense", env, home);
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
    // The check covers the value the state folder is built from, whichever name set it.
    const override = homeOverride(env);
    if (!override || !inside(resolve(tmpdir()), resolve(override.value))) {
      throw new Error("Tests require RECENSE_HOME inside the temporary directory");
    }
    if (!inside(realpathSync(tmpdir()), canonicalPath(resolve(override.value)))) {
      throw new Error("Tests require RECENSE_HOME to resolve inside the temporary directory");
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
