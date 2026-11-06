import { mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { escapeReference } from "../escape.ts";
import { CliError } from "../http.ts";
import {
  clearServicePending,
  readOwnedService,
  type ServiceAction,
  type ServiceContext,
  type ServiceTool,
  serviceFile,
  servicePending,
  serviceStatus,
  unsupportedService,
  validatePaths,
  writeService,
} from "./common.ts";
import { markServicePending, removeServiceOptions, saveServiceOptions, serviceInstallOptions } from "./options.ts";

const declaration = '<?xml version="1.0" encoding="UTF-8"?>';
const prefix = `${declaration}\n<!-- written by emend -->\n`;

function plistPath(home: string) {
  return join(home, "Library/LaunchAgents/dev.emend.server.plist");
}

async function launchdMainPid(
  launchctl: ServiceTool,
  target: string,
  failure: "throw" | "ignore" = "ignore",
): Promise<number> {
  const result = await launchctl(["print", target], failure === "throw" ? "ignore" : failure);
  if (failure === "throw" && result.code !== 0 && result.code !== 113) {
    const detail = result.stderr.split(/[\r\n]/, 1)[0] || `exit ${result.code}`;
    throw new CliError(`launchctl print ${target}: ${escapeReference(detail)}`);
  }
  const pid = Number(serviceField(result.stdout, "pid"));
  return result.code === 0 && Number.isSafeInteger(pid) && pid > 0 ? pid : 0;
}

export async function launchdServerPid(context: Pick<ServiceContext, "home" | "tool">, uid: number): Promise<number> {
  const path = plistPath(context.home);
  validatePaths(path);
  if ((await readOwnedService(path, prefix)) === undefined) return 0;
  return launchdMainPid(await context.tool("launchctl"), `gui/${uid}/dev.emend.server`, "throw");
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
function plist(context: ServiceContext): string {
  const { home, node, entry, flags, stateDir } = context;
  const log = xml(join(home, "Library/Logs/emend.log"));
  return `${prefix}<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.emend.server</string>
  <key>ProgramArguments</key>
  <array>
${[node, entry, "serve", ...flags].map((word) => `    <string>${xml(word)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>EMEND_HOME</key>
    <string>${xml(stateDir)}</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
</dict>
</plist>
`;
}

export async function launchdService(action: ServiceAction, context: ServiceContext, uid: number) {
  const { home, io, tool, stateDir } = context;
  const launchctl = await tool("launchctl").catch((error) => {
    if (error instanceof CliError && error.message === "launchctl was not found on PATH")
      throw new CliError(unsupportedService);
    throw error;
  });
  const path = plistPath(home);
  const domain = `gui/${uid}`;
  const target = `${domain}/dev.emend.server`;
  validatePaths(path);
  if (action === "status") {
    if (!(await serviceFile(path))) io.stdout("emend: service not installed\n");
    else {
      const result = await launchctl(["print", target], "ignore");
      const running = result.code === 0 && serviceField(result.stdout, "state") === "running";
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
    await launchctl(["bootout", target], "report");
    await removeServiceOptions(stateDir);
    await clearServicePending(stateDir);
    await unlink(path);
    io.stdout("emend: service uninstalled\n");
    return;
  }
  const { flags, resetToDefaults } = await serviceInstallOptions(context, previous);
  const content = plist({ ...context, flags });
  const pending = await servicePending(stateDir);
  markServicePending(stateDir, flags, content);
  const stop = previous !== undefined || pending;
  if (stop) await launchctl(["bootout", target], "ignore");
  await mkdir(join(home, "Library/Logs"), { recursive: true });
  if (previous !== content) await writeService(path, content);
  saveServiceOptions(stateDir, flags);
  if (resetToDefaults && previous !== content)
    io.stdout("emend: no saved service options; the service now uses the defaults\n");
  if (stop) await waitForBootout(launchctl, target, context);
  const url = await context.stopLocalServer();
  if (url !== undefined)
    io.stdout(`emend: stopped the emend server at ${escapeReference(url)}, so the service can take over\n`);
  await launchctl(["bootstrap", domain, path]);
  await clearServicePending(stateDir);
  let mainPid = 0;
  const found = await context.waitForServer({
    tailscale: flags.includes("--tailscale"),
    mainPid: async () => {
      mainPid = await launchdMainPid(launchctl, target);
      return mainPid;
    },
  });
  if (!found) {
    const log = escapeReference(join(home, "Library/Logs/emend.log"));
    throw new CliError(
      mainPid === 0
        ? `the emend service did not start a server; see ${log}.`
        : `the emend service runs, but this command could not confirm its server; see ${log}, or run emend service install again in your own terminal if an agent sandbox runs this command.`,
    );
  }
  io.stdout("emend: service installed\n");
}

async function waitForBootout(launchctl: ServiceTool, target: string, context: ServiceContext) {
  const deadline = context.now() + 10000;
  while ((await launchctl(["print", target], "ignore")).code === 0) {
    const remaining = deadline - context.now();
    if (remaining <= 0) throw new CliError("the old emend service did not stop; try again.");
    await context.sleep(Math.min(200, remaining));
  }
}

function serviceField(output: string, field: string): string | undefined {
  let depth = 0;
  for (const line of output.split("\n")) {
    const text = line.trim();
    if (depth === 1 && text.startsWith(`${field} = `)) return text.slice(`${field} = `.length);
    if (text.endsWith("{")) depth++;
    else if (text === "}") depth--;
  }
  return undefined;
}
