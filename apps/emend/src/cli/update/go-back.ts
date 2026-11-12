import { quoteShellArgument } from "../escape.ts";
import { type Install, restoreArgs } from "./install.ts";

const directoryNames = [
  "MISE_DATA_DIR",
  "MISE_CONFIG_DIR",
  "MISE_CACHE_DIR",
  "MISE_STATE_DIR",
  "PNPM_HOME",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
];

/** One shell list, with the checked directories pinned against hooks triggered by cd. */
export function goBack(options: {
  home: string;
  stateDir: string;
  database: string;
  backupPath?: string;
  oldVersion: string;
  oldEntry: string;
  node: string;
  helper: string;
  install: Install;
  hasService: boolean;
  platform: string;
  uid?: number;
  env: Record<string, string>;
}): string {
  const { backupPath, database, env, hasService, oldEntry, oldVersion } = options;
  if (backupPath === undefined) return "";
  const pins = (names: string[], fixed: string) =>
    [
      "/usr/bin/env",
      ...names.filter((name) => env[name] === undefined).map((name) => `-u ${name}`),
      fixed,
      ...names.flatMap((name) => (env[name] === undefined ? [] : [`${name}=${quoteShellArgument(env[name])}`])),
    ].join(" ");
  const restorePins = pins(directoryNames, "npm_config_ignore_scripts=true");
  const emendPins = pins(["XDG_CONFIG_HOME"], `EMEND_HOME=${quoteShellArgument(options.stateDir)}`);
  const emend = `${emendPins} ${quoteShellArgument(options.node)}`;
  const stop = hasService
    ? options.platform === "linux"
      ? "systemctl --user stop emend"
      : `{ launchctl bootout gui/${options.uid}/dev.emend.server || ! launchctl print gui/${options.uid}/dev.emend.server >/dev/null 2>&1; }`
    : `${emend} ${quoteShellArgument(oldEntry)} stop`;
  const old = [options.helper, ...restoreArgs(options.install, oldVersion)]
    .map((word, index, words) => (index === 0 || words[index - 1] === "--prefix" ? quoteShellArgument(word) : word))
    .join(" ");
  const restore = `${restorePins} ${old}`;
  return `emend: to go back to emend ${oldVersion} with the database from before this update, stop every agent that
uses emend, then paste these lines; they stop at the first failure:
  cd ${quoteShellArgument(options.home)} &&
  ${hasService ? stop : restore} &&
  ${hasService ? restore : stop} &&
  cp ${quoteShellArgument(backupPath)} ${quoteShellArgument(database)} && rm -f ${quoteShellArgument(`${database}-wal`)} ${quoteShellArgument(`${database}-shm`)} &&
  ${emend} ${quoteShellArgument(oldEntry)}${hasService ? " service install" : ""}
`;
}
