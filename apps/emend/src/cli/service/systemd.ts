import { unlink } from "node:fs/promises";
import { userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { escapeReference } from "../escape.ts";
import { CliError } from "../http.ts";
import {
  clearServicePending,
  readOwnedService,
  type ServiceAction,
  type ServiceContext,
  type ServiceTool,
  serviceFile,
  serviceStatus,
  unsupportedService,
  validatePaths,
  writeService,
} from "./common.ts";
import { markServicePending, removeServiceOptions, saveServiceOptions, serviceInstallOptions } from "./options.ts";

const prefix = "# written by emend\n";

function unitPath(home: string, config: string | undefined) {
  return join(config && isAbsolute(config) ? config : join(home, ".config"), "systemd/user/emend.service");
}

async function systemdMainPid(systemctl: ServiceTool, failure: "throw" | "ignore" = "ignore"): Promise<number> {
  const result = await systemctl(["--user", "show", "--property=MainPID", "--value", "emend"], failure);
  const pid = Number(result.stdout.trim());
  return result.code === 0 && Number.isSafeInteger(pid) && pid > 0 ? pid : 0;
}

export async function systemdServerPid(context: Pick<ServiceContext, "home" | "io" | "tool">): Promise<number> {
  const path = unitPath(context.home, context.io.env.XDG_CONFIG_HOME);
  validatePaths(path);
  if ((await readOwnedService(path, prefix)) === undefined) return 0;
  return systemdMainPid(await context.tool("systemctl"), "throw");
}

export function systemdWord(word: string, execStart: boolean): string {
  let escaped = word.replaceAll("%", "%%");
  if (execStart) escaped = escaped.replaceAll("$", "$$$$");
  return /[ \t"'\\]/.test(escaped) ? `"${escaped.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"` : escaped;
}

function unit(context: ServiceContext): string {
  const { node, entry, flags, stateDir } = context;
  const configHome = context.io.env.XDG_CONFIG_HOME;
  const configEnv = configHome && isAbsolute(configHome) ? configHome : undefined;
  if (configEnv) validatePaths(configEnv);
  return `${prefix}[Unit]
Description=emend review server

[Service]
Type=exec
ExecStart=${systemdWord(node, false)} ${[entry, "serve", ...flags].map((word) => systemdWord(word, true)).join(" ")}
Environment=${systemdWord(`EMEND_HOME=${stateDir}`, false)}
${configEnv ? `Environment=${systemdWord(`XDG_CONFIG_HOME=${configEnv}`, false)}\n` : ""}Restart=on-failure

[Install]
WantedBy=default.target
`;
}

export async function systemdService(action: ServiceAction, context: ServiceContext, username?: string) {
  const { home, io, tool, stateDir } = context;
  if (action === "install" && /[$"'\\]/.test(context.node))
    throw new CliError(
      "the node path contains $, quotes or a backslash, which a systemd unit cannot run; use a node installed at a plain path.",
    );
  const systemctl = await tool("systemctl").catch((error) => {
    if (error instanceof CliError && error.message === "systemctl was not found on PATH")
      throw new CliError(unsupportedService);
    throw error;
  });
  const path = unitPath(home, io.env.XDG_CONFIG_HOME);
  validatePaths(path);
  if (action === "status") {
    if (!(await serviceFile(path))) io.stdout("emend: service not installed\n");
    else {
      const running = (await systemctl(["--user", "is-active", "emend"], "ignore")).code === 0;
      serviceStatus(io, path, running);
      return running;
    }
    return;
  }
  const previous = await readOwnedService(path, prefix);
  if (action === "uninstall") {
    if (previous === undefined) {
      await removeServiceOptions(stateDir);
      await clearServicePending(stateDir);
      io.stdout("emend: the service is not installed.\n");
      return;
    }
    await systemctl(["--user", "disable", "--now", "emend"], "report");
    await removeServiceOptions(stateDir);
    await clearServicePending(stateDir);
    await unlink(path);
    await systemctl(["--user", "daemon-reload"]);
    io.stdout("emend: service uninstalled\n");
    return;
  }
  const { flags, resetToDefaults } = await serviceInstallOptions(context, previous);
  const content = unit({ ...context, flags });
  markServicePending(stateDir, flags, content);
  if (previous !== content) {
    await writeService(path, content);
  }
  saveServiceOptions(stateDir, flags);
  if (resetToDefaults && previous !== content)
    io.stdout("emend: no saved service options; the service now uses the defaults\n");
  await systemctl(["--user", "daemon-reload"]);
  await systemctl(["--user", "enable", "emend"]);
  await systemctl(["--user", "stop", "emend"]);
  const url = await context.stopLocalServer();
  if (url !== undefined)
    io.stdout(`emend: stopped the emend server at ${escapeReference(url)}, so the service can take over\n`);
  await systemctl(["--user", "start", "emend"]);
  await clearServicePending(stateDir);
  let mainPid = 0;
  const found = await context.waitForServer({
    tailscale: flags.includes("--tailscale"),
    mainPid: async () => {
      mainPid = await systemdMainPid(systemctl);
      return mainPid;
    },
  });
  if (!found)
    throw new CliError(
      mainPid === 0
        ? "the emend service did not start a server; run journalctl --user -u emend to see why."
        : "the emend service runs, but this command could not confirm its server; run journalctl --user -u emend to see why, or run emend service install again in your own terminal if an agent sandbox runs this command.",
    );
  io.stdout("emend: service installed\n");
  try {
    const loginctl = await tool("loginctl");
    const result = await loginctl(
      ["show-user", username ?? userInfo().username, "--property=Linger", "--value"],
      "ignore",
    );
    if (result.code === 0 && result.stdout.trim() === "no")
      io.stdout("To keep emend running after you log out, run sudo loginctl enable-linger $USER.\n");
  } catch {
    // Linger advice is optional when loginctl is unavailable.
  }
}
