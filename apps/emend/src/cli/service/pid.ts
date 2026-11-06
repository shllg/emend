import { homedir } from "node:os";
import type { Io } from "../../main.ts";
import { runService, ServiceFileNotOwned, serviceTool } from "./common.ts";
import { launchdServerPid } from "./launchd.ts";
import { systemdServerPid } from "./systemd.ts";

/**
 * Zero means no emend service: none installed, a foreign file, not loaded, or another platform.
 * Null means emend's own service exists but its pid could not be checked.
 */
export async function servicePid(io: Io): Promise<number | null> {
  const options = io.service ?? {};
  const platform = options.platform ?? process.platform;
  if (platform !== "linux" && platform !== "darwin") return 0;
  try {
    const home = options.home ?? homedir();
    const context = {
      home,
      io,
      tool: (name: string) => serviceTool(name, home, io, options.runner ?? runService),
    };
    if (platform === "linux") return await systemdServerPid(context);
    const uid = options.uid ?? process.getuid?.();
    return uid === undefined ? null : await launchdServerPid(context, uid);
  } catch (error) {
    if (error instanceof ServiceFileNotOwned) return 0;
    return null;
  }
}
