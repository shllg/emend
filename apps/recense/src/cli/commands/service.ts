import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { Io } from "../../main.ts";
import { isStateModeError, StateFolderWriteError } from "../../state/files.ts";
import { moveLegacyState } from "../../state/legacy.ts";
import { namedStateDir } from "../../state/paths.ts";
import { checkTokenFileMode } from "../../state/token-file.ts";
import { escapeReference } from "../escape.ts";
import { CliError, CliUsageError } from "../http.ts";
import { cliRuntime } from "../runtime.ts";
import {
  runService,
  type ServiceContext,
  serviceFile,
  serviceTool,
  unsupportedService,
  validatePaths,
  validateServiceRuntime,
} from "../service/common.ts";
import { launchdService, plistPath } from "../service/launchd.ts";
import { legacyServiceInstalled, removeLegacyService } from "../service/legacy.ts";
import { systemdService, unitPath } from "../service/systemd.ts";
import { stopLocalServer, waitForServer } from "../service/takeover.ts";
import { localVersionNotice, printVersionNotice } from "../version-notice.ts";
import { parseServeArgs, UsageError } from "./serve.ts";

export async function serviceCommand(stateDir: string, args: string[], io: Io) {
  const [action, ...flags] = args;
  if (action !== "install" && action !== "uninstall" && action !== "status")
    throw new CliUsageError("Usage: recense service install [serve options] | uninstall | status.");
  if (action !== "install" && flags.length) throw new CliUsageError(`recense service ${action} takes no options.`);
  try {
    if (action === "install") parseServeArgs(flags);
    const options = io.service ?? {};
    const uid = options.uid ?? process.getuid?.();
    if (uid === 0) throw new CliError("run recense service as the user who runs recense, not as root.");
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
    if (action === "status") {
      if (await legacyServiceInstalled(platform, context))
        io.stdout(
          "recense: the old emend service is still installed; run recense service install to replace it, or recense service uninstall to remove it\n",
        );
    } else {
      // The old service may hold the old state folder, so it goes first; then the folders move.
      const current = platform === "linux" ? unitPath(home, io.env.XDG_CONFIG_HOME) : plistPath(home);
      // With no options given and no recense service yet, the new one keeps the old one's serve options.
      const inherit = action === "install" && flags.length === 0 && !(await serviceFile(current));
      const legacy = await removeLegacyService(platform, context, uid, inherit);
      if (legacy?.flags?.length && inherit) {
        context.flags = legacy.flags;
        io.stdout(
          `recense: keeping the options of the old emend service: ${escapeReference(legacy.flags.join(" "))}\n`,
        );
      }
      if (
        legacy?.stateDir !== undefined &&
        resolve(legacy.stateDir) !== resolve(stateDir) &&
        resolve(legacy.stateDir) !== resolve(namedStateDir("emend", io.env, platform, home))
      )
        io.stdout(
          `recense: the old emend service used the state folder ${escapeReference(legacy.stateDir)}; this recense uses ${escapeReference(stateDir)}. To keep the old folder, set RECENSE_HOME=${escapeReference(legacy.stateDir)} and run recense service install again.\n`,
        );
      const refusal = moveLegacyState(io.env, platform, home);
      if (refusal !== undefined) throw new CliError(refusal);
    }
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
    throw new CliError("Could not manage the recense service.");
  }
}
