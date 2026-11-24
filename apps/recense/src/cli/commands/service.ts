import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { Io } from "../../main.ts";
import { isStateModeError, StateFolderWriteError } from "../../state/files.ts";
import {
  type HolderProbe,
  LegacyStateInUseError,
  LegacyStateUnverifiableError,
  moveLegacyState,
  planLegacyMove,
} from "../../state/legacy.ts";
import { homeOverride, namedStateDir } from "../../state/paths.ts";
import { checkTokenFileMode } from "../../state/token-file.ts";
import { escapeReference } from "../escape.ts";
import { CliError, CliUsageError } from "../http.ts";
import { cliRuntime } from "../runtime.ts";
import {
  runService,
  type ServiceAction,
  type ServiceContext,
  serviceFile,
  serviceTool,
  unsupportedService,
  validatePaths,
  validateServiceRuntime,
} from "../service/common.ts";
import { launchdService, plistPath } from "../service/launchd.ts";
import {
  inspectLegacyService,
  legacyServiceInstalled,
  legacyServicePid,
  removeLegacyService,
  stopLegacyService,
} from "../service/legacy.ts";
import { checkSystemdNode, systemdService, unitPath } from "../service/systemd.ts";
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
    let handover: Handover | undefined;
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
      stopLocalServer: options.stopLocalServer ?? (() => stopLocalServer(context.stateDir, { now, sleep })),
      waitForServer: options.waitForServer ?? ((ready) => waitForServer(context.stateDir, { ...ready, now, sleep })),
    };
    if (action === "status") {
      if (await legacyServiceInstalled(platform, context))
        io.stdout(
          "recense: the old emend service is still installed; run recense service install to replace it, or recense service uninstall to remove it\n",
        );
    } else {
      handover = await prepareHandover(platform, context, { uid, action, flags, stateDir, probe: options.holders });
      if (handover) {
        context.stateDir = handover.stateDir;
        context.flags = handover.flags;
      }
    }
    let running: boolean | undefined;
    try {
      if (platform === "linux") running = await systemdService(action, context, options.username);
      else {
        if (uid === undefined) throw new CliError("Could not determine the service user.");
        running = await launchdService(action, context, uid);
      }
    } catch (error) {
      // Unless the new unit was written with the inherited options, the old service runs again.
      await handover?.restore(await serviceFile(current(platform, home, io)));
      throw error;
    }
    await handover?.finish();
    if (action === "status" && running) printVersionNotice(io, await localVersionNotice(stateDir, io));
  } catch (error) {
    if (error instanceof UsageError) throw new CliUsageError(error.message);
    if (error instanceof CliError || isStateModeError(error) || error instanceof StateFolderWriteError) throw error;
    throw new CliError("Could not manage the recense service.");
  }
}

const current = (platform: string, home: string, io: Io) =>
  platform === "linux" ? unitPath(home, io.env.XDG_CONFIG_HOME) : plistPath(home);

interface Handover {
  stateDir: string;
  flags: string[];
  /** Starts the old service again when the new one could not be written; a written unit stays. */
  restore: (newUnitExists: unknown) => Promise<void>;
  /** Removes the stopped old service once the new one is in place. */
  finish: () => Promise<void>;
}

/**
 * Hands the service of the name before the rename over to the new one. Everything is read and checked before
 * the old service stops: its options, the state folder it pinned, whether another process holds the old
 * database, and the new unit's node path. Then the old service stops, the old state moves, and only after
 * the new service is in place is the old unit removed. A failure leaves the old service running, or the new
 * unit written with the options the old one had, so a rerun never loses them.
 */
async function prepareHandover(
  platform: string,
  context: ServiceContext,
  input: {
    uid: number | undefined;
    action: ServiceAction;
    flags: string[];
    stateDir: string;
    probe: HolderProbe | undefined;
  },
): Promise<Handover | undefined> {
  const { io, home } = context;
  const { uid, action } = input;
  let { stateDir } = input;
  // With no options given and no recense service yet, the new one keeps the old one's serve options.
  const inherit = action === "install" && input.flags.length === 0 && !(await serviceFile(current(platform, home, io)));
  const legacy = await inspectLegacyService(platform, context, inherit);
  if (legacy === undefined) return undefined;
  let flags = input.flags;
  if (legacy.flags?.length && inherit) {
    flags = legacy.flags;
    io.stdout(`recense: keeping the options of the old emend service: ${escapeReference(legacy.flags.join(" "))}\n`);
  }
  // The state folder the old unit pinned (EMEND_HOME) carries over as RECENSE_HOME, unless it is the old default
  // folder, which moves to the new default, or the shell names a folder itself.
  const pinned = legacy.stateDir;
  const isCustom =
    pinned !== undefined &&
    resolve(pinned) !== resolve(stateDir) &&
    resolve(pinned) !== resolve(namedStateDir("emend", io.env, platform, home));
  if (isCustom && homeOverride(io.env)) {
    io.stdout(
      `recense: the old emend service used the state folder ${escapeReference(pinned)}; this recense uses ${escapeReference(stateDir)}, so the recense service does too. To keep the old folder, set RECENSE_HOME=${escapeReference(pinned)} and run recense service install again.\n`,
    );
  } else if (isCustom) {
    stateDir = pinned;
    io.stdout(
      `recense: the old emend service used the state folder ${escapeReference(pinned)}; the recense service keeps using it (RECENSE_HOME). Set RECENSE_HOME=${escapeReference(pinned)} in your shell for recense commands to use it too.\n`,
    );
  }
  const moveEnv = stateDir === input.stateDir ? io.env : { ...io.env, RECENSE_HOME: stateDir };
  if (action === "install") {
    validatePaths(stateDir);
    if (platform === "linux") checkSystemdNode(context.node);
    await checkTokenFileMode(join(stateDir, "admin.token"));
  }
  // The old service itself may hold the old database; it is about to stop.
  const pid = await legacyServicePid(platform, context, uid);
  try {
    planLegacyMove(moveEnv, platform, home, {
      ...(input.probe ? { probe: input.probe } : {}),
      ignorePids: pid > 0 ? [pid] : [],
    });
  } catch (error) {
    throw new CliError(
      error instanceof LegacyStateInUseError || error instanceof LegacyStateUnverifiableError
        ? error.message
        : "could not check the old emend state folder, so the old service was left running.",
    );
  }
  const restart = await stopLegacyService(platform, context, uid);
  const restore = async (newUnitExists: unknown) => {
    // An uninstall that fails brings the old service back; an install keeps a new unit it already wrote.
    if (!newUnitExists || action === "uninstall") await restart().catch(() => {});
  };
  const { refusal } = moveLegacyState(moveEnv, platform, home, input.probe ? { probe: input.probe } : {});
  if (refusal !== undefined) {
    await restore(false);
    throw new CliError(refusal);
  }
  return {
    stateDir,
    flags,
    restore,
    finish: () => removeLegacyService(platform, context, uid),
  };
}
