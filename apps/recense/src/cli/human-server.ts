import { ensureStateDir } from "../state/files.ts";
import { CliError } from "./http.ts";
import { discover } from "./server-client.ts";
import { localTarget } from "./target.ts";

export async function humanServer(stateDir: string) {
  ensureStateDir(stateDir);
  const server = await discover(stateDir, 5000);
  if (!server) throw new CliError("recense is not running. Start it with `recense` or `recense serve --tailscale`.");
  return localTarget(stateDir, server.url, "admin");
}
