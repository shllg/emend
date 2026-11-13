import { join } from "node:path";
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
import { tailscaleOrigin } from "../tailscale-marker.ts";

export class UsageError extends Error {}

function parsePublicUrl(value: string): string {
  const invalid = () =>
    new UsageError("--public-url must be an https origin such as https://emend.example.com, with no path.");
  // Check before URL strips controls; service installers also write the raw value.
  // The final assertion, unlike $, refuses even a trailing newline.
  if (
    value.length > 300 ||
    !/^https:\/\/(?:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*|\[[A-Fa-f0-9:.]+\])(?::[0-9]+)?\/?(?![\s\S])/.test(value)
  )
    throw invalid();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid();
  }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw invalid();
  return url.origin;
}

export function parseServeArgs(args: string[]) {
  let host = "127.0.0.1";
  let port = 3636;
  let tailscale = false;
  let tailscalePort: number | undefined;
  let publicUrl: string | undefined;
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
    else if (flag === "--tailscale-port") {
      if (!/^[1-9]\d{0,4}$/.test(value) || Number(value) > 65535)
        throw new UsageError("--tailscale-port must be a whole number from 1 to 65535.");
      tailscalePort = Number(value);
    } else if (flag === "--public-url") publicUrl = parsePublicUrl(value);
    else throw new UsageError("Invalid serve options.");
  }
  if (publicUrl !== undefined && tailscale) throw new UsageError("--public-url cannot be combined with --tailscale.");
  if (tailscalePort !== undefined && !tailscale) throw new UsageError("--tailscale-port requires --tailscale.");
  if (tailscale && host !== "127.0.0.1") throw new UsageError("--tailscale requires --host 127.0.0.1.");
  return {
    host,
    port,
    ...(tailscale ? { tailscale: true } : {}),
    ...(tailscalePort !== undefined ? { tailscalePort } : {}),
    ...(publicUrl !== undefined ? { publicUrl } : {}),
  };
}
export async function serveCommand(
  stateDir: string,
  options: ReturnType<typeof parseServeArgs>,
  io: Io,
  configDir?: string,
) {
  const startup = new AbortController();
  const httpsPort = options.tailscalePort ?? 443;
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
    const publicOrigin = self ? tailscaleOrigin(self.dnsName, httpsPort) : options.publicUrl;
    const starting = startServer({
      stateDir,
      configFile: configDir ? join(configDir, "config.json") : undefined,
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
        { fixedPort: options.port !== 0, stateDir, ...(httpsPort === 443 ? {} : { httpsPort }) },
      );
      setup = result.created || result.owned === true;
      if (stopped) return;
      if (result.otherHttpsPorts)
        io.stderr(
          `emend: warning: Tailscale Serve also serves other HTTPS ports on ${self.dnsName}; pages there receive emend's sign-in cookie.\n`,
        );
      server.setPublicOriginReady(true);
      advertised = true;
    } else if (options.publicUrl) {
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
          if (self && setup) {
            if (httpsPort === 443) await removeTailscaleServe(server.port, io.env, self.dnsName, stateDir);
            else
              await removeTailscaleServe(
                server.port,
                io.env,
                self.dnsName,
                stateDir,
                process.pid,
                undefined,
                httpsPort,
              );
          }
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
