import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The environment for a script that runs the packed or built CLI: the parent's, without npm's own settings,
 * with HOME, every XDG folder and both state-folder variables pinned under `work`. A run may move or create
 * config and state, so none of them may resolve to the developer's real folders.
 */
export function isolatedEnvironment(work: string, parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const kept = Object.fromEntries(
    Object.entries(parent).filter((entry): entry is [string, string] => {
      const [key, value] = entry;
      return value !== undefined && !/^npm_config_/i.test(key) && !/^XDG_/.test(key);
    }),
  );
  const home = join(work, "home");
  mkdirSync(home, { recursive: true });
  return {
    ...kept,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: join(home, ".local/state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_RUNTIME_DIR: join(work, "runtime"),
    RECENSE_HOME: join(work, "state"),
    EMEND_HOME: join(work, "state"),
  };
}
