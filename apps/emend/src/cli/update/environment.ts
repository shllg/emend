import { isAbsolute } from "node:path";

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
  "TMPDIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "PNPM_HOME",
  "VOLTA_HOME",
  "NVM_DIR",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "MISE_DATA_DIR",
  "MISE_CONFIG_DIR",
  "MISE_CACHE_DIR",
  "MISE_STATE_DIR",
  ...["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY"].flatMap((name) => [name, name.toLowerCase()]),
]);

/**
 * The environment of every program `emend update` starts. It is an allowlist: the repository the
 * user stands in may have set NODE_OPTIONS, NODE_PATH, npm_config_* or MISE_* variables that
 * make a package manager or Node.js run its code, so none of them pass.
 */
export function childEnvironment(
  parent: Record<string, string | undefined>,
  fixed: { path: string; home: string; stateDir: string },
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (names.has(name) || name.startsWith("LC_")) env[name] = value;
    else if (name.startsWith("XDG_") && isAbsolute(value)) env[name] = value;
  }
  return { ...env, PATH: fixed.path, HOME: fixed.home, EMEND_HOME: fixed.stateDir };
}
