import { createHash } from "node:crypto";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { LIMITS } from "@recense/contract";
import { writeSecretFile } from "../../state/files.ts";
import { parseServeArgs } from "../commands/serve.ts";
import { escapeReference } from "../escape.ts";
import { CliError } from "../http.ts";
import { readRegular } from "../publish/read.ts";
import { type ServiceContext, serviceFile } from "./common.ts";

const invalid = () => new CliError("invalid saved service options; run recense service install with your options");

function flags(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((arg) => typeof arg === "string")) throw invalid();
  parseServeArgs(value);
  return value;
}

async function readOptionsFile(stateDir: string, name: string): Promise<string | undefined> {
  const path = join(stateDir, name);
  if (!(await serviceFile(path))) return undefined;
  return (await readRegular(path, LIMITS.publicJsonBytes)).toString();
}

/** Repair a completed unit rename before replacing its pending record on a later install. */
export async function serviceInstallOptions(
  context: ServiceContext,
  previous: string | undefined,
): Promise<{ flags: string[]; resetToDefaults: boolean }> {
  const { stateDir, flags: supplied, io } = context;
  if (previous === undefined) return { flags: supplied, resetToDefaults: false };
  let saved: string[] | undefined;
  if (!supplied.length) {
    try {
      const data = await readOptionsFile(stateDir, "service.json");
      if (data !== undefined) saved = flags(JSON.parse(data));
    } catch {
      throw invalid();
    }
  }
  let pending: { flags: string[]; hash: string } | undefined;
  try {
    const data = await readOptionsFile(stateDir, "service.pending");
    // Older releases used an empty marker with no options to recover.
    if (data) {
      const value: unknown = JSON.parse(data);
      if (
        !value ||
        typeof value !== "object" ||
        !("hash" in value) ||
        typeof value.hash !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.hash)
      )
        throw invalid();
      if (!("flags" in value)) throw invalid();
      pending = { flags: flags(value.flags), hash: value.hash };
    }
  } catch {
    if (!supplied.length) throw invalid();
  }
  if (pending && pending.hash === contentHash(previous)) {
    saveServiceOptions(stateDir, pending.flags);
    saved = pending.flags;
  }
  if (supplied.length) return { flags: supplied, resetToDefaults: false };
  if (saved?.length) io.stdout(`recense: keeping the service options ${saved.map(escapeReference).join(" ")}\n`);
  return { flags: saved ?? [], resetToDefaults: saved === undefined };
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function writeOptionsFile(stateDir: string, name: string, value: unknown) {
  const data = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(data) > LIMITS.publicJsonBytes) throw invalid();
  writeSecretFile(join(stateDir, name), data);
}

export function markServicePending(stateDir: string, flags: string[], content: string) {
  writeOptionsFile(stateDir, "service.pending", { flags, hash: contentHash(content) });
}

export function saveServiceOptions(stateDir: string, flags: string[]) {
  writeOptionsFile(stateDir, "service.json", flags);
}

export async function removeServiceOptions(stateDir: string) {
  try {
    await unlink(join(stateDir, "service.json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
