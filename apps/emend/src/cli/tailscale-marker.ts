import { constants, statSync } from "node:fs";
import { access, lstat, unlink } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { LIMITS } from "@emend/contract";
import { StateFolderWriteError, stateAccessError, writeSecretFile } from "../state/files.ts";
import { readRegular } from "./publish/read.ts";

export interface TailscaleRoute {
  target: string;
  dnsName: string;
  pid: number;
  /** HTTPS port of the route; absent means 443, the only shape older emend versions wrote. */
  httpsPort?: number;
}
export const defaultTailscaleHttpsPort = 443;
export const routeHttpsPort = (route: Pick<TailscaleRoute, "httpsPort">) =>
  route.httpsPort ?? defaultTailscaleHttpsPort;
/** The public origin of a route: Tailscale Serve omits the port only for 443. */
export const tailscaleOrigin = (dnsName: string, httpsPort = defaultTailscaleHttpsPort) =>
  httpsPort === defaultTailscaleHttpsPort ? `https://${dnsName}` : `https://${dnsName}:${httpsPort}`;
type Marker = { kind: "missing" | "invalid" } | { kind: "valid"; route: TailscaleRoute };
const markerPath = (stateDir: string) => join(stateDir, "tailscale-serve.json");

export function tailscaleDnsName(value: string): string | null {
  const name = value.replace(/\.$/, "").toLowerCase();
  const labels = name.split(".");
  return name.length <= 253 &&
    labels.length >= 2 &&
    labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.exec(label)?.[0] === label)
    ? name
    : null;
}

export async function readTailscaleMarker(stateDir: string): Promise<Marker> {
  let exists = false;
  try {
    const path = markerPath(stateDir);
    await lstat(path);
    exists = true;
    const value: unknown = JSON.parse((await readRegular(path, LIMITS.publicJsonBytes)).toString());
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !(Object.keys(value).length === 3 || (Object.keys(value).length === 4 && "httpsPort" in value)) ||
      !("target" in value) ||
      typeof value.target !== "string" ||
      !("dnsName" in value) ||
      typeof value.dnsName !== "string" ||
      !("pid" in value) ||
      typeof value.pid !== "number" ||
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0
    )
      return { kind: "invalid" };
    // A route on 443 is written without the field; the field exists only for another port.
    const httpsPort = "httpsPort" in value ? value.httpsPort : undefined;
    if (
      "httpsPort" in value &&
      (typeof httpsPort !== "number" ||
        !Number.isSafeInteger(httpsPort) ||
        httpsPort < 1 ||
        httpsPort > 65535 ||
        httpsPort === defaultTailscaleHttpsPort)
    )
      return { kind: "invalid" };
    const target = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/.exec(value.target);
    const dnsName = tailscaleDnsName(value.dnsName);
    if (!target || target[0] !== value.target || Number(target[1]) > 65535 || !dnsName) return { kind: "invalid" };
    return {
      kind: "valid",
      route: {
        target: value.target,
        dnsName,
        pid: value.pid,
        ...(typeof httpsPort === "number" ? { httpsPort } : {}),
      },
    };
  } catch (error) {
    const mapped = stateAccessError(stateDir, error);
    if (mapped instanceof StateFolderWriteError) {
      if ((error as NodeJS.ErrnoException).path !== markerPath(stateDir)) throw mapped;
      // An unreadable marker is harmless; a blocked state folder must be reported.
      try {
        await access(stateDir, constants.R_OK | constants.X_OK);
      } catch {
        throw mapped;
      }
    }
    return { kind: !exists && (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "invalid" };
  }
}

export function writeTailscaleMarker(stateDir: string, route: TailscaleRoute): void {
  try {
    // Serve creates the state folder; marker persistence must not create it.
    statSync(stateDir);
    const { target, dnsName, pid } = route;
    const httpsPort = routeHttpsPort(route);
    writeSecretFile(
      markerPath(stateDir),
      JSON.stringify({ target, dnsName, pid, ...(httpsPort === defaultTailscaleHttpsPort ? {} : { httpsPort }) }),
    );
  } catch (error) {
    throw stateAccessError(stateDir, error);
  }
}

export async function removeTailscaleMarker(stateDir: string, route: TailscaleRoute): Promise<void> {
  const marker = await readTailscaleMarker(stateDir);
  if (
    marker.kind !== "valid" ||
    marker.route.target !== route.target ||
    marker.route.dnsName !== route.dnsName ||
    marker.route.pid !== route.pid ||
    routeHttpsPort(marker.route) !== routeHttpsPort(route)
  )
    return;
  try {
    await unlink(markerPath(stateDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw stateAccessError(stateDir, error);
  }
}

/**
 * Whether something listens on a loopback port. Only a refused connection proves nothing does;
 * a timeout or any other error is "unknown", so callers fail safe.
 */
export function loopbackState(port: number, timeoutMs = 500): Promise<"open" | "refused" | "unknown"> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (state: "open" | "refused" | "unknown") => {
      clearTimeout(timer);
      socket.destroy();
      resolve(state);
    };
    const timer = setTimeout(() => done("unknown"), timeoutMs);
    socket.once("connect", () => done("open"));
    socket.once("error", (error: NodeJS.ErrnoException) => done(error.code === "ECONNREFUSED" ? "refused" : "unknown"));
  });
}
