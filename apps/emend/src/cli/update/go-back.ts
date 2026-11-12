import { quoteShellArgument } from "../escape.ts";
import { pathNames, proxyNames } from "./environment.ts";
import { type Install, restoreArgs } from "./install.ts";

/** Independent package and database recovery lists, isolated from the pasting shell. */
export function goBack(options: {
  home: string;
  stateDir: string;
  database: string;
  backupPath?: string;
  backupTime?: string;
  oldVersion: string;
  oldEntry: string;
  node: string;
  helper: string;
  install: Install;
  hasService: boolean;
  platform: string;
  uid?: number;
  env: Record<string, string>;
  launchctl?: string;
}): string {
  const { backupPath, database, env, hasService, oldEntry, oldVersion } = options;
  const pins = [
    "/usr/bin/env -i",
    ...["PATH", "HOME"].map((name) => `${name}=${quoteShellArgument(env[name] ?? "")}`),
    ...Object.entries(env)
      .filter(
        ([name]) =>
          (pathNames.has(name) && name !== "SHELL") || name.startsWith("XDG_") || name === "DBUS_SESSION_BUS_ADDRESS",
      )
      .map(
        ([name, value]) =>
          `${/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : quoteShellArgument(name)}=${quoteShellArgument(value)}`,
      ),
  ].join(" ");
  const restorePins = [
    pins,
    "npm_config_ignore_scripts=true",
    ...proxyNames.filter((name) => env[name] !== undefined).map((name) => `${name}="\${${name}-}"`),
  ].join(" ");
  const emend = `${pins} EMEND_HOME=${quoteShellArgument(options.stateDir)} ${quoteShellArgument(options.node)} ${quoteShellArgument(oldEntry)}`;
  const launchctl = `${pins} ${quoteShellArgument(options.launchctl ?? "/bin/launchctl")}`;
  const job = `gui/${options.uid}/dev.emend.server`;
  const stop = hasService
    ? options.platform === "linux"
      ? `${pins} systemctl --user stop emend`
      : `( ${launchctl} bootout ${job}; n=0; while ${launchctl} print ${job} >/dev/null 2>&1 && [ "$n" -lt 50 ]; do n=$((n+1)); ${pins} /bin/sleep 0.2; done; ${launchctl} print ${job} >/dev/null 2>&1; [ "$?" -eq 113 ] )`
    : `${emend} stop`;
  const old = [options.helper, ...restoreArgs(options.install, oldVersion)]
    .map((word, index, words) => (index === 0 || words[index - 1] === "--prefix" ? quoteShellArgument(word) : word))
    .join(" ");
  const restore = `${restorePins} ${old}`;
  const start = `${emend}${hasService ? " service install" : ""}`;
  const packagePart = `emend: to go back to emend ${oldVersion}, stop every agent that uses emend, then paste these lines; they
stop at the first failure:
  cd ${quoteShellArgument(options.home)} &&
  ${hasService ? stop : restore} &&
  ${hasService ? restore : stop} &&
  ${start}
`;
  if (backupPath === undefined) return packagePart;
  return `${packagePart}emend: only if emend ${oldVersion} then says "The emend database is newer than this emend", put the
database back to the backup from ${options.backupTime}. Everything since then is lost, including devices
and tokens revoked since then: revoke them again afterwards. Paste these lines:
  cd ${quoteShellArgument(options.home)} &&
  ${stop} &&
  ${pins} /bin/cp ${quoteShellArgument(backupPath)} ${quoteShellArgument(database)} && ${pins} /bin/rm -f ${quoteShellArgument(`${database}-wal`)} ${quoteShellArgument(`${database}-shm`)} &&
  ${start}
`;
}
