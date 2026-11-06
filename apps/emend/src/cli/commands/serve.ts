import type { Io } from "../../main.ts";
import { startServer } from "../../server/serve.ts";
import { CliError, CliSignalExit, errorLine } from "../http.ts";
import {
  ensureTailscaleServe,
  removeTailscaleServe,
  tailscaleSelf,
  tailscaleUnavailable,
  waitForTailscaleEscalations,
} from "../tailscale.ts";

export class UsageError extends Error {}
export function parseServeArgs(args: string[]) {
  let host = "127.0.0.1";
  let port = 3636;
  let tailscale = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!flag || seen.has(flag)) throw new UsageError("Invalid serve options.");
    seen.add(flag);
    if (flag === "--tailscale") {
      tailscale = true;
      continue;
    }
    const value = args[++i];
    if (!value) throw new UsageError("Invalid serve options.");
    if (flag === "--host" && /^[a-zA-Z0-9:][a-zA-Z0-9.:-]*$/.test(value)) host = value;
    else if (flag === "--port" && /^\d{1,5}$/.test(value) && Number(value) <= 65535) port = Number(value);
    else throw new UsageError("Invalid serve options.");
  }
  if (tailscale && host !== "127.0.0.1") throw new UsageError("--tailscale requires --host 127.0.0.1.");
  return { host, port, ...(tailscale ? { tailscale: true } : {}) };
}
export async function serveCommand(stateDir: string, options: ReturnType<typeof parseServeArgs>, io: Io) {
  const startup = new AbortController();
  let self: Awaited<ReturnType<typeof tailscaleSelf>> = null;
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let setup = false;
  let advertised = false;
  let stopped = false;
  const shutdown = Promise.withResolvers<void>();
  const stop = (code: number) => {
    if (stopped) return;
    stopped = true;
    if (!server) startup.abort(new CliSignalExit(code));
    shutdown.resolve();
  };
  const int = () => stop(130);
  const term = () => stop(143);
  const hup = () => stop(129);
  process.on("SIGINT", int);
  process.on("SIGTERM", term);
  process.on("SIGHUP", hup);
  try {
    self = options.tailscale ? await tailscaleSelf(io.env, startup.signal) : null;
    startup.signal.throwIfAborted();
    if (options.tailscale && !self) throw new CliError(tailscaleUnavailable);
    const publicOrigin = self ? `https://${self.dnsName}` : undefined;
    const starting = startServer({
      stateDir,
      host: options.host,
      port: options.port,
      publicOrigin,
      onStopRequest: () => stop(0),
    });
    try {
      server = await Promise.race([
        starting,
        shutdown.promise.then(() => {
          throw startup.signal.reason;
        }),
      ]);
    } catch (error) {
      // A signal cannot cancel startup; retain a late server for the cleanup below.
      server = await starting.catch(() => undefined);
      throw error;
    }
    if (stopped) return;
    if (self) {
      const result = await ensureTailscaleServe(
        server.port,
        io.env,
        self.dnsName,
        (owned) => {
          // A failed --bg call can still have applied the handler.
          setup = owned;
        },
        { fixedPort: options.port !== 0, stateDir },
      );
      setup = result.created || result.owned === true;
      if (stopped) return;
      if (result.otherHttpsPorts)
        io.stderr(
          `emend: warning: Tailscale Serve also serves other HTTPS ports on ${self.dnsName}; pages there receive emend's sign-in cookie.\n`,
        );
      server.setPublicOriginReady(true);
      advertised = true;
    }
    try {
      io.stdout(publicOrigin ? `emend: serving ${publicOrigin}\n` : `emend is serving ${server.url}\n`);
    } catch {
      // A closed terminal must not stop serving or bypass later signal cleanup.
    }
    await shutdown.promise;
  } catch (error) {
    if (advertised) server?.setPublicOriginReady(false);
    startup.signal.throwIfAborted();
    throw error;
  } finally {
    try {
      if (server) {
        let removalError: string | undefined;
        // Remove an owned proxy before releasing its loopback port to another process.
        try {
          if (self && setup) await removeTailscaleServe(server.port, io.env, self.dnsName, stateDir);
        } catch (error) {
          removalError = errorLine(error);
        } finally {
          try {
            await server.close();
          } finally {
            if (removalError) {
              try {
                io.stderr(removalError);
              } catch {
                // A hung-up terminal must not change shutdown's result.
              }
            }
          }
        }
      }
    } finally {
      await waitForTailscaleEscalations();
      process.off("SIGINT", int);
      process.off("SIGTERM", term);
      process.off("SIGHUP", hup);
    }
  }
}
