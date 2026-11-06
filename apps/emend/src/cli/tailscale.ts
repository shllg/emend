import { type ChildProcess, spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, resolve } from "node:path";
import { StateDirModeError, stateAccessError } from "../state/files.ts";
import { escapeReference } from "./escape.ts";
import { findExecutable } from "./executable.ts";
import { CliError } from "./http.ts";
import { lockTailscaleServe, type TailscaleLockOptions } from "./tailscale-lock.ts";
import {
  loopbackState,
  readTailscaleMarker,
  removeTailscaleMarker,
  type TailscaleRoute,
  tailscaleDnsName,
  writeTailscaleMarker,
} from "./tailscale-marker.ts";

const occupied =
  "port 443 of Tailscale Serve already has a setup emend did not make or cannot read; inspect it with `tailscale serve status`.";
const unreadable = "could not read the output of tailscale status.";
export const tailscaleUnavailable = "Tailscale is not running or not logged in.";
class TailscaleSetupDenied extends CliError {}
/** The executable is unavailable; a previously configured route may still exist. */
export class TailscaleNotInstalled extends CliError {}
const safePath = "/usr/bin:/bin:/usr/sbin:/sbin";
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
interface RunOptions {
  deadlineMs?: number;
  platform?: NodeJS.Platform;
  appPath?: string;
  fixedPort?: boolean;
}
interface ServeOptions extends RunOptions {
  stateDir?: string;
  lock?: TailscaleLockOptions;
}
const escalations = new Set<Promise<void>>();
/** Serve keeps its signal handlers installed until every scheduled group kill has run. */
export async function waitForTailscaleEscalations(): Promise<void> {
  while (escalations.size) await Promise.all(escalations);
}
async function execute(
  args: string[],
  env = process.env,
  signal?: AbortSignal,
  {
    deadlineMs = 10_000,
    platform = process.platform,
    appPath = "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    fixedPort = true,
  }: RunOptions = {},
): Promise<string> {
  signal?.throwIfAborted();
  const searchPath = (env.PATH ?? "").split(delimiter).filter(isAbsolute).join(delimiter);
  const appName = basename(appPath);
  let fallback = false;
  const binary = await findExecutable("tailscale", searchPath)
    .catch((error) => {
      if (platform !== "darwin" || !(error instanceof CliError) || error.message !== "tailscale was not found on PATH")
        throw error;
      fallback = true;
      return findExecutable(appName, dirname(appPath));
    })
    .catch((error) => {
      if (
        error instanceof CliError &&
        (error.message === "tailscale was not found on PATH" ||
          (platform === "darwin" && error.message === `${appName} was not found on PATH`))
      )
        throw new TailscaleNotInstalled("tailscale is not installed or not on PATH.");
      throw error;
    });
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const serve = args[0] === "serve";
    const failure = (stderr = "") => {
      const setupHint = fixedPort
        ? ` Run \`sudo tailscale serve --bg --https=443 ${args[3]}\` once as root, then try again. emend uses that route and never removes it.`
        : " Use a fixed --port, run `sudo tailscale serve --bg --https=443 http://127.0.0.1:<port>` once as root with that port, then try again.";
      const denied = serve && /permission|access denied|not permitted|sudo tailscale|operator/i.test(stderr);
      const hint = denied
        ? args[1] === "--bg"
          ? setupHint
          : " Run `sudo tailscale set --operator=$USER` once, then try again."
        : "";
      const ErrorClass = denied && args[1] === "--bg" ? TailscaleSetupDenied : CliError;
      return new ErrorClass(`${serve ? "Could not configure Tailscale Serve." : tailscaleUnavailable}${hint}`);
    };
    let child: ChildProcess;
    try {
      // execFile does not forward detached; cleanup must survive signals to emend's group.
      child = spawn(binary.file, args, {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: fallback ? safePath : binary.path || safePath, HOME: env.HOME, LC_ALL: "C" },
      });
    } catch {
      reject(failure());
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let overflow = false;
    let timedOut = false;
    let terminating = false;
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let drainGrace: ReturnType<typeof setTimeout> | undefined;
    const signalGroup = (signal: NodeJS.Signals | 0) => {
      if (!child.pid) return false;
      try {
        process.kill(-child.pid, signal);
        return true;
      } catch {
        // The group may already be gone, including after a failed spawn.
        return false;
      }
    };
    const destroyPipes = () => {
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const terminateGroup = () => {
      if (terminating) return;
      terminating = true;
      if (signalGroup("SIGTERM")) {
        // Keep this referenced and independent of call settlement: a launcher can
        // exit on SIGTERM while its descendants ignore it and outlive emend.
        const escalation = Promise.withResolvers<void>();
        escalations.add(escalation.promise);
        setTimeout(() => {
          if (signalGroup(0)) signalGroup("SIGKILL");
          escalations.delete(escalation.promise);
          escalation.resolve();
        }, 1_000);
      }
    };
    const terminate = () => {
      if (settled) return;
      terminateGroup();
      destroyPipes();
    };
    const finish = (code: number | null, exitSignal: NodeJS.Signals | null, failed = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(drainGrace);
      signal?.removeEventListener("abort", terminate);
      // A clean group adds no delay; descendants without open pipes still need cleanup.
      if (!terminating && signalGroup(0)) terminateGroup();
      destroyPipes();
      if (signal?.aborted) return reject(signal.reason);
      if (overflow) return reject(new CliError(unreadable));
      if (timedOut)
        return reject(
          new CliError(
            `tailscale did not answer within ${deadlineMs / 1_000} second${deadlineMs === 1_000 ? "" : "s"}.`,
          ),
        );
      if (!failed && code === 0 && exitSignal === null) return resolve(Buffer.concat(stdout).toString("utf8"));
      reject(failure(Buffer.concat(stderr).toString("utf8")));
    };
    // EMFILE/ENFILE can leave null pipes and emit error on the next tick.
    child.once("error", () => finish(null, null, true));
    child.once("close", finish);
    child.once("exit", (code, exitSignal) => {
      if (settled) return;
      // Drain normal output through close. A descendant can keep stdio open,
      // so give it only this grace period, still bounded by the call's deadline.
      drainGrace = setTimeout(() => {
        if (!terminating && signalGroup(0)) terminateGroup();
        destroyPipes();
        finish(code, exitSignal);
      }, 250);
    });
    deadline = setTimeout(() => {
      timedOut = true;
      terminate();
    }, deadlineMs);
    // The startup signal tracks running calls only; completed calls unregister.
    signal?.addEventListener("abort", terminate, { once: true });
    for (const [stream, chunks] of [
      [child.stdout, stdout],
      [child.stderr, stderr],
    ] as const) {
      let bytes = 0;
      stream?.on("data", (chunk: Buffer) => {
        if (overflow) return;
        bytes += chunk.length;
        if (bytes > 16 * 1024 * 1024) {
          overflow = true;
          terminate();
        } else chunks.push(chunk);
      });
    }
    if (signal?.aborted) terminate();
  });
}
export async function tailscaleSelf(
  env = process.env,
  signal?: AbortSignal,
  options?: RunOptions,
): Promise<{ dnsName: string } | null> {
  const output = await execute(["status", "--json"], env, signal, options);
  let status: unknown;
  try {
    status = JSON.parse(output);
  } catch {
    throw new CliError(unreadable);
  }
  if (
    !record(status) ||
    status.BackendState !== "Running" ||
    !record(status.Self) ||
    typeof status.Self.DNSName !== "string"
  )
    return null;
  const dnsName = tailscaleDnsName(status.Self.DNSName);
  return dnsName ? { dnsName } : null;
}
/** Unknown shapes are occupied: never repair or replace someone else's Serve config. */
function handlerState(config: unknown, target: string, dnsName?: string): "empty" | "same" | "occupied" {
  if (
    !record(config) ||
    Object.keys(config).some((key) => !["TCP", "Web", "Services", "AllowFunnel", "Foreground"].includes(key))
  )
    return "occupied";
  if (config.Services !== undefined && !record(config.Services)) return "occupied";
  if (config.Foreground !== undefined && (!record(config.Foreground) || Object.keys(config.Foreground).length))
    return "occupied";
  if (config.AllowFunnel !== undefined) {
    if (!record(config.AllowFunnel)) return "occupied";
    for (const [host, allowed] of Object.entries(config.AllowFunnel)) {
      if (!/^[a-z0-9.-]+:[1-9]\d{0,4}$/.test(host) || typeof allowed !== "boolean") return "occupied";
      if (allowed && (dnsName ? host === `${dnsName}:443` : host.endsWith(":443"))) return "occupied";
    }
  }
  if (config.TCP !== undefined && !record(config.TCP)) return "occupied";
  if (config.Web !== undefined && !record(config.Web)) return "occupied";
  const tcp = config.TCP ?? {};
  const web = config.Web ?? {};
  if (!record(tcp) || !record(web)) return "occupied";
  if (
    Object.entries(tcp).some(
      ([port, handler]) => !/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65535 || !record(handler),
    ) ||
    Object.entries(web).some(([host, handler]) => !/^[a-z0-9.-]+:[1-9]\d{0,4}$/.test(host) || !record(handler))
  )
    return "occupied";
  const endpoints = Object.entries(web).filter(([host]) => host.endsWith(":443"));
  const listener = tcp["443"];
  if (listener === undefined && endpoints.length === 0) return "empty";
  if (
    !record(listener) ||
    listener.HTTPS !== true ||
    Object.keys(listener).some((key) => key !== "HTTPS") ||
    endpoints.length !== 1
  )
    return "occupied";
  if (dnsName && endpoints[0]?.[0] !== `${dnsName}:443`) return "occupied";
  const endpoint = endpoints[0]?.[1];
  if (!record(endpoint) || Object.keys(endpoint).some((key) => key !== "Handlers") || !record(endpoint.Handlers))
    return "occupied";
  const handlers = endpoint.Handlers;
  const root = handlers["/"];
  return Object.keys(handlers).length === 1 &&
    record(root) &&
    Object.keys(root).length === 1 &&
    (root.Proxy === target || root.Proxy === `${target}/`)
    ? "same"
    : "occupied";
}
async function serveConfig(env: NodeJS.ProcessEnv, options?: RunOptions): Promise<unknown> {
  const output = await execute(["serve", "status", "--json"], env, undefined, options);
  try {
    return JSON.parse(output);
  } catch {
    throw new CliError(unreadable);
  }
}
function otherHttpsPorts(config: unknown, dnsName?: string): boolean {
  if (!dnsName || !record(config) || !record(config.TCP)) return false;
  const web = record(config.Web) ? config.Web : {};
  return Object.entries(config.TCP).some(
    ([port, listener]) =>
      port !== "443" &&
      record(listener) &&
      (listener.TerminateTLS === dnsName || (listener.HTTPS === true && Object.hasOwn(web, `${dnsName}:${port}`))),
  );
}
function markerPort(route: TailscaleRoute): number {
  return Number(new URL(route.target).port) || 80;
}
// Another state folder can own the same port even after the recorded pid exits.
async function ownerRunning(route: TailscaleRoute): Promise<boolean> {
  return (await loopbackState(markerPort(route))) !== "refused";
}
const sameMarker = (a: TailscaleRoute, b: TailscaleRoute) =>
  a.target === b.target && a.dnsName === b.dnsName && a.pid === b.pid;
export async function ensureTailscaleServe(
  port: number,
  env = process.env,
  dnsName?: string,
  onOwnershipChange?: (owned: boolean) => void,
  options?: ServeOptions,
): Promise<{ created: boolean; owned?: boolean; otherHttpsPorts: boolean }> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new CliError("Invalid Tailscale Serve port.");
  const stateDir = options?.stateDir;
  const release = stateDir ? await lockTailscaleServe(stateDir, options?.lock) : undefined;
  try {
    return await ensureLocked(port, env, dnsName, onOwnershipChange, options);
  } finally {
    release?.();
  }
}
async function ensureLocked(
  port: number,
  env: NodeJS.ProcessEnv,
  dnsName: string | undefined,
  onOwnershipChange: ((owned: boolean) => void) | undefined,
  options: ServeOptions | undefined,
): Promise<{ created: boolean; owned?: boolean; otherHttpsPorts: boolean }> {
  const stateDir = options?.stateDir;
  const marker = stateDir ? await readTailscaleMarker(stateDir) : { kind: "missing" as const };
  let config = await serveConfig(env, options);
  const target = `http://127.0.0.1:${port}`;
  let adopted = false;
  if (stateDir && marker.kind === "valid") {
    const previous = marker.route;
    if (handlerState(config, previous.target, previous.dnsName) === "same") {
      const sameTarget = previous.target === target && previous.dnsName === dnsName;
      if (sameTarget) {
        writeTailscaleMarker(stateDir, { ...previous, pid: process.pid });
        adopted = true;
      } else {
        if (await ownerRunning(previous))
          throw new CliError(
            `another emend server (process ${previous.pid}) serves port 443 of Tailscale Serve; stop that server, then try again.`,
          );
        // Removal re-reads Serve before touching the old route.
        await removeLocked(markerPort(previous), env, previous.dnsName, stateDir, previous.pid);
        config = await serveConfig(env, options);
      }
    } else await removeTailscaleMarker(stateDir, previous);
  }
  const state = handlerState(config, target, dnsName);
  if (state === "occupied") throw new CliError(occupied);
  if (state === "empty") {
    if (stateDir && dnsName) writeTailscaleMarker(stateDir, { target, dnsName, pid: process.pid });
    onOwnershipChange?.(true);
    try {
      await execute(["serve", "--bg", "--https=443", target], env, undefined, options);
    } catch (error) {
      if (error instanceof TailscaleSetupDenied) {
        onOwnershipChange?.(false);
        if (stateDir && dnsName) await removeTailscaleMarker(stateDir, { target, dnsName, pid: process.pid });
      }
      throw error;
    }
  }
  return {
    created: state === "empty",
    ...(stateDir ? { owned: state === "empty" || adopted } : {}),
    otherHttpsPorts: otherHttpsPorts(config, dnsName),
  };
}
async function removeLocked(
  port: number,
  env: NodeJS.ProcessEnv,
  dnsName: string | undefined,
  stateDir: string | undefined,
  ownerPid: number,
): Promise<void> {
  const config = await serveConfig(env);
  if (handlerState(config, `http://127.0.0.1:${port}`, dnsName) === "same")
    await execute(["serve", "--https=443", "off"], env);
  if (stateDir && dnsName)
    await removeTailscaleMarker(stateDir, { target: `http://127.0.0.1:${port}`, dnsName, pid: ownerPid });
}
export async function removeTailscaleServe(
  port: number,
  env = process.env,
  dnsName?: string,
  stateDir?: string,
  ownerPid = process.pid,
  lock?: TailscaleLockOptions,
): Promise<void> {
  const release = stateDir ? await lockTailscaleServe(stateDir, lock) : undefined;
  try {
    await removeLocked(port, env, dnsName, stateDir, ownerPid);
  } finally {
    release?.();
  }
}

export async function removeStaleTailscaleServe(
  stateDir: string,
  env = process.env,
  lock?: TailscaleLockOptions,
): Promise<
  { removed: false } | { removed: true; dnsName: string } | { removed: false; notInstalled: true; dnsName: string }
> {
  const dir = resolve(stateDir);
  try {
    if ((await stat(dir)).mode & 0o077) throw new StateDirModeError(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { removed: false };
    throw stateAccessError(stateDir, error);
  }
  // No valid marker or a port still in use means no lock file and no tailscale call.
  const marker = await readTailscaleMarker(stateDir);
  if (marker.kind !== "valid" || (await ownerRunning(marker.route))) return { removed: false };
  const route = marker.route;
  const release = await lockTailscaleServe(stateDir, lock);
  try {
    try {
      // A server may have adopted or removed the route while this process waited for the lock.
      const held = await readTailscaleMarker(stateDir);
      if (held.kind !== "valid" || !sameMarker(held.route, route) || (await ownerRunning(held.route)))
        return { removed: false };
      const config = await serveConfig(env);
      if (handlerState(config, route.target, route.dnsName) !== "same") {
        await removeTailscaleMarker(stateDir, route);
        return { removed: false };
      }
      const current = await readTailscaleMarker(stateDir);
      if (current.kind !== "valid" || !sameMarker(current.route, route)) return { removed: false };
      await execute(["serve", "--https=443", "off"], env);
      await removeTailscaleMarker(stateDir, route);
      return { removed: true, dnsName: route.dnsName };
    } catch (error) {
      if (error instanceof TailscaleNotInstalled) return { removed: false, notInstalled: true, dnsName: route.dnsName };
      const reason = error instanceof Error ? error.message : "unknown error";
      throw new CliError(
        `no emend server is running, but removing the Tailscale Serve route it left at https://${escapeReference(route.dnsName)} failed: ${escapeReference(reason)}`,
      );
    }
  } finally {
    release();
  }
}
