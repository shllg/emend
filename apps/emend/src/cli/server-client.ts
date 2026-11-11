import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  Capabilities,
  SERVER_CHALLENGE_HEADER,
  SERVER_PROOF_HEADER,
  ServerChallenge,
  ServerProof,
} from "@emend/contract";
import { serverProof } from "../server/auth/server-proof.ts";
import { ensureStateDir, StateFolderWriteError, stateAccessError } from "../state/files.ts";
import { VERSION } from "../version.ts";
import { cliRuntime } from "./runtime.ts";

export interface ServerRecord {
  url: string;
  pid: number;
  key: string;
}
export async function serverRecord(stateDir: string, expectedUrl?: string): Promise<ServerRecord | null> {
  try {
    const record: unknown = JSON.parse(await readFile(join(stateDir, "server.json"), "utf8"));
    if (
      !record ||
      typeof record !== "object" ||
      !("pid" in record) ||
      typeof record.pid !== "number" ||
      !Number.isSafeInteger(record.pid) ||
      record.pid <= 0 ||
      !("url" in record) ||
      typeof record.url !== "string" ||
      !("key" in record) ||
      !ServerChallenge.safeParse(record.key).success
    )
      return null;
    const url = new URL(record.url);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      !isIP(url.hostname.replace(/^\[|\]$/g, "")) ||
      (expectedUrl !== undefined && url.origin !== expectedUrl)
    )
      return null;
    try {
      process.kill(record.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") return null;
    }
    return { url: url.origin, pid: record.pid, key: ServerChallenge.parse(record.key) };
  } catch (error) {
    const mapped = stateAccessError(stateDir, error);
    if (mapped instanceof StateFolderWriteError) throw mapped;
    return null;
  }
}

async function capabilitiesBody(response: Response): Promise<Capabilities | null> {
  const limit = 65536;
  if (Number(response.headers.get("Content-Length")) > limit) {
    void response.body?.cancel().catch(() => {});
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        void reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const parsed = Capabilities.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export type ServerProbe =
  | { kind: "verified"; capabilities: Capabilities | null }
  | { kind: "absent" | "unverified" | "unanswered" };
export async function probeServer(
  record: ServerRecord,
  timeoutMs: number,
  readCapabilities = true,
): Promise<ServerProbe> {
  try {
    const challenge = randomBytes(32).toString("base64url");
    const response = await fetch(`${record.url}/api/v1/capabilities`, {
      redirect: "error",
      headers: { [SERVER_CHALLENGE_HEADER]: challenge, "X-Emend-Client": `cli/${VERSION}` },
      signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs))),
    });
    const proof = ServerProof.safeParse(response.headers.get(SERVER_PROOF_HEADER));
    if (
      !proof.success ||
      !timingSafeEqual(
        Buffer.from(proof.data, "base64url"),
        Buffer.from(serverProof(record.key, challenge), "base64url"),
      )
    ) {
      void response.body?.cancel().catch(() => {});
      return { kind: "unverified" };
    }
    if (!readCapabilities || !response.ok) {
      void response.body?.cancel().catch(() => {});
      return { kind: "verified", capabilities: null };
    }
    return { kind: "verified", capabilities: await capabilitiesBody(response) };
  } catch (error) {
    const cause = error instanceof Error ? (error.cause as NodeJS.ErrnoException | undefined) : undefined;
    return { kind: cause?.code === "ECONNREFUSED" ? "absent" : "unanswered" };
  }
}

export async function discover(
  stateDir: string,
  timeoutMs: number,
  expectedUrl?: string,
): Promise<{ url: string } | null> {
  const record = await serverRecord(stateDir, expectedUrl);
  if (!record) return null;
  const result = await probeServer(record, timeoutMs);
  return result.kind === "verified" && result.capabilities ? { url: record.url } : null;
}

export async function ensureServer(
  stateDir: string,
  opts: { node?: string; entry?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<{ url: string }> {
  ensureStateDir(stateDir);
  const timeoutMs = opts.timeoutMs ?? 5000;
  const existing = await discover(stateDir, Math.min(500, timeoutMs));
  if (existing) return existing;
  const { node, entry } = cliRuntime(opts);
  const failure = () => new Error("Could not start the emend server.");
  let spawnError = false;
  try {
    const child = spawn(node, [entry, "serve"], {
      detached: true,
      cwd: stateDir,
      stdio: "ignore",
      env: { ...(opts.env ?? process.env), EMEND_HOME: stateDir },
    });
    child.once("error", () => {
      spawnError = true;
    });
    child.unref();
  } catch {
    throw failure();
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !spawnError) {
    const found = await discover(stateDir, Math.min(300, deadline - Date.now()));
    if (found) return found;
    await delay(Math.min(50, Math.max(1, deadline - Date.now())));
  }
  throw failure();
}
