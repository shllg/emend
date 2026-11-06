import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { Io } from "../../main.ts";
import { escapeReference } from "../escape.ts";
import { findExecutable } from "../executable.ts";
import { CliError } from "../http.ts";
import type { CliRuntime } from "../runtime.ts";
import { runtimeInRepository } from "../runtime-repository.ts";
import type { ServerReadyOptions } from "./takeover.ts";

export interface ServiceResult {
  code: number | string;
  stdout: string;
  stderr: string;
}
export type ServiceRunner = (
  file: string,
  args: string[],
  options: { cwd: string; env: Io["env"] },
) => Promise<ServiceResult>;
export interface ServiceOptions extends Partial<CliRuntime> {
  platform?: string;
  home?: string;
  username?: string;
  uid?: number;
  runner?: ServiceRunner;
  cwd?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  stopLocalServer?: () => Promise<string | undefined>;
  waitForServer?: (options: ServerReadyOptions) => Promise<{ url: string; pid: number } | null>;
}
export type ServiceAction = "install" | "uninstall" | "status";
export type ServiceTool = (args: string[], failure?: "throw" | "report" | "ignore") => Promise<ServiceResult>;
export interface ServiceContext extends CliRuntime {
  home: string;
  stateDir: string;
  flags: string[];
  io: Io;
  tool: (name: string) => Promise<ServiceTool>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  stopLocalServer: () => Promise<string | undefined>;
  waitForServer: (options: ServerReadyOptions) => Promise<{ url: string; pid: number } | null>;
}
export const unsupportedService =
  "emend service supports systemd on Linux and launchd on macOS; run emend serve yourself.";

export const runService: ServiceRunner = (file, args, options) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { ...options, encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr });
      },
    );
  });

export async function serviceTool(name: string, home: string, io: Io, runner: ServiceRunner): Promise<ServiceTool> {
  const binary = await findExecutable(name, io.env.PATH ?? "");
  validatePaths(binary.file);
  return async (args, failure = "throw") => {
    const result = await runner(binary.file, args, { cwd: home, env: { ...io.env, PATH: binary.path } });
    if (result.code !== 0 && failure !== "ignore") {
      const detail = result.stderr.split(/[\r\n]/, 1)[0] || `exit ${result.code}`;
      const message = `${escapeReference([name, ...args].join(" "))}: ${escapeReference(detail)}`;
      if (failure === "report") io.stderr(`emend: ${message}\n`);
      else throw new CliError(message);
    }
    return result;
  };
}

export function validatePaths(...paths: string[]) {
  for (const path of paths) {
    if (!isAbsolute(path)) throw new CliError("Service paths must be absolute.");
    if (
      Array.from(path).some((char) => {
        const code = char.codePointAt(0) ?? 0;
        return code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029;
      })
    )
      throw new CliError("Service paths must not contain control characters.");
  }
}

export async function validateServiceRuntime(runtime: CliRuntime, cwd: string) {
  if (await runtimeInRepository(runtime, cwd))
    throw new CliError(
      "this emend runs from inside the current repository; run emend service install from outside it.",
    );
}

export async function serviceFile(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export class ServiceFileNotOwned extends CliError {}

export async function readOwnedService(path: string, prefix: string): Promise<string | undefined> {
  const info = await serviceFile(path);
  if (!info) return undefined;
  const refuse = () =>
    new ServiceFileNotOwned(`${escapeReference(path)} was not written by emend; move it away, then try again.`);
  if (!info.isFile()) throw refuse();
  const content = await readFile(path, "utf8");
  if (!content.startsWith(prefix) && content !== prefix.slice(0, -1)) throw refuse();
  return content;
}

export async function writeService(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    try {
      await file.writeFile(content);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await removeIfPresent(temporary);
  }
}

async function removeIfPresent(path: string) {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function servicePending(stateDir: string) {
  return (await serviceFile(join(stateDir, "service.pending"))) !== undefined;
}

export function clearServicePending(stateDir: string) {
  return removeIfPresent(join(stateDir, "service.pending"));
}

export function serviceStatus(io: Io, path: string, running: boolean) {
  io.stdout(`emend: service ${running ? "running" : "installed but not running"} (${escapeReference(path)})\n`);
}
