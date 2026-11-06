import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { Io } from "../../main.ts";
import { isStateModeError, StateFolderWriteError } from "../../state/files.ts";
import { checkTokenFileMode } from "../../state/token-file.ts";
import { CliError, CliUsageError } from "../http.ts";
import { cliRuntime } from "../runtime.ts";
import {
  runService,
  type ServiceContext,
  serviceTool,
  unsupportedService,
  validatePaths,
  validateServiceRuntime,
} from "../service/common.ts";
import { launchdService } from "../service/launchd.ts";
import { systemdService } from "../service/systemd.ts";
import { stopLocalServer, waitForServer } from "../service/takeover.ts";
import { localVersionNotice, printVersionNotice } from "../version-notice.ts";
import { parseServeArgs, UsageError } from "./serve.ts";

export async function serviceCommand(stateDir: string, args: string[], io: Io) {
  const [action, ...flags] = args;
  if (action !== "install" && action !== "uninstall" && action !== "status")
    throw new CliUsageError("Usage: emend service install [serve options] | uninstall | status.");
  if (action !== "install" && flags.length) throw new CliUsageError(`emend service ${action} takes no options.`);
  try {
    if (action === "install") parseServeArgs(flags);
    const options = io.service ?? {};
    const uid = options.uid ?? process.getuid?.();
    if (uid === 0) throw new CliError("run emend service as the user who runs emend, not as root.");
    const platform = options.platform ?? process.platform;
    if (platform !== "linux" && platform !== "darwin") throw new CliError(unsupportedService);
    const home = options.home ?? homedir();
    const runtime = cliRuntime(options);
    validatePaths(home);
    if (action === "install") {
      validatePaths(runtime.node, runtime.entry, stateDir);
      await validateServiceRuntime(runtime, options.cwd ?? process.cwd());
      await checkTokenFileMode(join(stateDir, "admin.token"));
    }
    const now = options.now ?? (() => performance.now());
    const sleep = options.sleep ?? setTimeout;
    const context: ServiceContext = {
      ...runtime,
      home,
      stateDir,
      flags,
      io,
      tool: (name) => serviceTool(name, home, io, options.runner ?? runService),
      now,
      sleep,
      stopLocalServer: options.stopLocalServer ?? (() => stopLocalServer(stateDir, { now, sleep })),
      waitForServer: options.waitForServer ?? ((ready) => waitForServer(stateDir, { ...ready, now, sleep })),
    };
    let running: boolean | undefined;
    if (platform === "linux") running = await systemdService(action, context, options.username);
    else {
      if (uid === undefined) throw new CliError("Could not determine the service user.");
      running = await launchdService(action, context, uid);
    }
    if (action === "status" && running) printVersionNotice(io, await localVersionNotice(stateDir, io));
  } catch (error) {
    if (error instanceof UsageError) throw new CliUsageError(error.message);
    if (error instanceof CliError || isStateModeError(error) || error instanceof StateFolderWriteError) throw error;
    throw new CliError("Could not manage the emend service.");
  }
}
