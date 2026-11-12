import { isAbsolute } from "node:path";
import { pathThroughRepository } from "../executable.ts";

const names = new Set([
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "TZ",
  "DBUS_SESSION_BUS_ADDRESS",
  ...["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY"].flatMap((name) => [name, name.toLowerCase()]),
]);

const pathNames = new Set([
  "MISE_DATA_DIR",
  "MISE_CONFIG_DIR",
  "MISE_CACHE_DIR",
  "MISE_STATE_DIR",
  "PNPM_HOME",
  "VOLTA_HOME",
  "NVM_DIR",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "TMPDIR",
]);

/**
 * Pass identity, locale, terminal, proxy and session-bus settings. MISE's four directory settings,
 * XDG_*, tool homes, certificate paths and TMPDIR pass only when absolute and checked outside
 * the original cwd's repositories, including every link hop. Drop everything else: a repository
 * may have set Node or package-manager options that execute its code. Force npm lifecycle scripts
 * off even when mise launches npm itself.
 */
export async function childEnvironment(
  parent: Record<string, string | undefined>,
  fixed: { path: string; home: string; stateDir: string },
  roots: readonly string[],
): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (pathNames.has(name) || name.startsWith("XDG_")) {
      try {
        if (isAbsolute(value) && !(await pathThroughRepository(value, roots))) env[name] = value;
      } catch {
        // Uncheckable paths never reach a child.
      }
    } else if (names.has(name) || name.startsWith("LC_")) env[name] = value;
  }
  return { ...env, PATH: fixed.path, HOME: fixed.home, EMEND_HOME: fixed.stateDir, npm_config_ignore_scripts: "true" };
}
