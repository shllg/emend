import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { LIMITS, ServerStopping } from "@recense/contract";
import { ensureStateDir, StateFolderWriteError, stateAccessError } from "../../state/files.ts";
import { escapeReference } from "../escape.ts";
import { apiRequest, CliError } from "../http.ts";
import { readRegular } from "../publish/read.ts";
import { probeServer, type ServerRecord, serverRecord } from "../server-client.ts";
import { localTarget } from "../target.ts";

interface ServerWaitOptions {
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}
export interface ServerReadyOptions extends ServerWaitOptions {
  mainPid?: () => Promise<number>;
  publicOrigin?: boolean;
}

export interface ServerReady {
  url: string;
  pid: number;
  publicUrl?: string;
}

interface ServerStopOptions extends ServerWaitOptions {
  beforeProbe?: (record: ServerRecord) => Promise<void>;
  messages?: (reference: string) => {
    unanswered: string;
    changed: string;
    unsupported: string;
    notStopped: string;
  };
}

export async function stopLocalServer(stateDir: string, opts: ServerWaitOptions = {}): Promise<string | undefined> {
  ensureStateDir(stateDir);
  return requestServerStop(stateDir, opts);
}

export async function requestServerStop(stateDir: string, opts: ServerStopOptions = {}): Promise<string | undefined> {
  const now = opts.now ?? (() => performance.now());
  const sleep = opts.sleep ?? delay;
  const deadline = now() + (opts.timeoutMs ?? 15000);
  const record = await serverRecord(stateDir);
  if (!record) return undefined;
  await opts.beforeProbe?.(record);
  const reference = escapeReference(record.url);
  const messages = opts.messages?.(reference) ?? {
    unanswered: `the recense server at ${reference} did not answer; stop it, then run recense service install again.`,
    changed: `the recense server at ${reference} changed while recense asked it to stop; run recense service install again.`,
    unsupported: `the recense server at ${reference} is from an older recense and cannot be asked to stop; stop it, then run recense service install again.`,
    notStopped: `the recense server at ${reference} did not stop; stop it, then run recense service install again.`,
  };
  const unanswered = () => new CliError(messages.unanswered);
  const authenticate = async (rechecking = false) => {
    while (now() < deadline) {
      if (rechecking) {
        try {
          process.kill(record.pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EPERM") return null;
        }
      }
      const result = await probeServer(record, Math.min(500, deadline - now()));
      if (result.kind === "absent") return null;
      if (result.kind === "unverified") {
        if (rechecking) throw new CliError(messages.changed);
        return null;
      }
      if (result.kind === "verified" && result.capabilities) return result.capabilities;
      await sleep(Math.min(100, Math.max(1, deadline - now())));
    }
    throw unanswered();
  };
  const capabilities = await authenticate();
  if (!capabilities) return undefined;
  if (!capabilities.features.includes("server-stop")) throw new CliError(messages.unsupported);
  const target = await localTarget(stateDir, record.url, "admin");
  if (now() >= deadline) throw unanswered();
  const timeoutMs = Math.max(1, Math.ceil(deadline - now()));
  const signal = AbortSignal.timeout(timeoutMs);
  let stopped = false;
  try {
    ServerStopping.parse(
      await apiRequest(stateDir, target, "/server/stop", {
        method: "POST",
        timeoutMs,
        signal,
        // Reauthenticate the same record before sending its admin credential.
        verifyLocal: async () => {
          stopped = (await authenticate(true)) === null;
          return !stopped;
        },
        successStatuses: [202],
      }),
    );
  } catch (error) {
    if (stopped) return undefined;
    if (signal.aborted) throw unanswered();
    throw error;
  }
  while (now() < deadline) {
    const result = await probeServer(record, Math.min(100, deadline - now()), false);
    // The old process may still be closing its database after its listener closes;
    // SQLite allows the new server's connection meanwhile.
    if (result.kind === "absent" || result.kind === "unverified") return record.url;
    await sleep(Math.min(100, Math.max(1, deadline - now())));
  }
  throw new CliError(messages.notStopped);
}

async function readyPublicOrigin(stateDir: string): Promise<string | undefined> {
  try {
    const record: unknown = JSON.parse(
      (await readRegular(join(stateDir, "server-url.json"), LIMITS.publicJsonBytes)).toString(),
    );
    if (!record || typeof record !== "object" || !("baseUrl" in record) || typeof record.baseUrl !== "string")
      return undefined;
    if (!/^https:\/\/[^/?#\\\s]+\/?$/.test(record.baseUrl)) return undefined;
    const url = new URL(record.baseUrl);
    if (url.username || url.password || record.baseUrl.includes("@")) return undefined;
    return url.origin;
  } catch (error) {
    const mapped = stateAccessError(stateDir, error);
    if (mapped instanceof StateFolderWriteError) throw mapped;
    return undefined;
  }
}

export async function waitForServer(stateDir: string, opts: ServerReadyOptions = {}): Promise<ServerReady | null> {
  const now = opts.now ?? (() => performance.now());
  const sleep = opts.sleep ?? delay;
  const deadline = now() + (opts.timeoutMs ?? 15000);
  while (now() < deadline) {
    const mainPid = await opts.mainPid?.();
    const record = await serverRecord(stateDir);
    if (record && (mainPid === undefined || record.pid === mainPid) && now() < deadline) {
      const result = await probeServer(record, Math.min(200, deadline - now()));
      if (result.kind === "verified" && result.capabilities) {
        const server = { url: record.url, pid: record.pid };
        if (!opts.publicOrigin) return server;
        const publicUrl = await readyPublicOrigin(stateDir);
        if (publicUrl !== undefined) return { ...server, publicUrl };
      }
    }
    await sleep(Math.min(200, Math.max(0, deadline - now())));
  }
  return null;
}
