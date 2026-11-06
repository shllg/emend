import type { Io } from "../main.ts";
import { VERSION } from "../version.ts";
import { escapeReference } from "./escape.ts";
import { probeServer, serverRecord } from "./server-client.ts";
import { servicePid } from "./service/pid.ts";
import { hubCapabilities } from "./target.ts";

const updateUrl = "https://github.com/shllg/emend/blob/release/docs/setup/update.md";

function plainVersion(version: string): bigint[] | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  return match?.[0] === version ? match.slice(1).map(BigInt) : null;
}

function compareVersion(version: string): number | null {
  if (version === VERSION) return 0;
  const server = plainVersion(version);
  const cli = plainVersion(VERSION);
  if (!server || !cli) return null;
  for (const [index, part] of server.entries()) {
    const current = cli[index];
    if (current === undefined) return null;
    if (part !== current) return part < current ? -1 : 1;
  }
  return 0;
}

export async function localVersionNotice(stateDir: string, io: Io, expectedUrl?: string): Promise<string | undefined> {
  try {
    const record = await serverRecord(stateDir, expectedUrl);
    if (!record) return;
    const result = await probeServer(record, 500);
    if (result.kind !== "verified" || !result.capabilities) return;
    const comparison = compareVersion(result.capabilities.version);
    if (comparison === 0) return;
    const url = escapeReference(record.url);
    const version = escapeReference(result.capabilities.version);
    if (comparison === 1) {
      return `emend: the emend server at ${url} runs emend ${version}, newer than this emend ${VERSION}; update emend: ${updateUrl}\n`;
    }
    const pid = await servicePid(io);
    if (pid === null) return;
    const fix =
      pid === record.pid
        ? `Run emend service install to restart it on emend ${VERSION}.`
        : `Run emend stop, then emend, to start emend ${VERSION}.`;
    return `emend: the emend server at ${url} runs emend ${version}; this is emend ${VERSION}. ${fix}\n`;
  } catch {
    // Version advice must not fail the command.
  }
}

export async function hubVersionNotice(url: string): Promise<string | undefined> {
  try {
    const capabilities = await hubCapabilities(url, AbortSignal.timeout(1000));
    const comparison = compareVersion(capabilities.version);
    if (comparison === 0) return;
    const fix =
      comparison === null
        ? "Update both to the same version"
        : comparison < 0
          ? "Update the hub"
          : "Update this machine";
    return `emend: the hub at ${escapeReference(url)} runs emend ${escapeReference(capabilities.version)}; this machine runs emend ${VERSION}. ${fix}: ${updateUrl}\n`;
  } catch {
    // Opening an attached hub also works while it is unreachable.
  }
}

export function printVersionNotice(io: Io, notice: string | undefined): void {
  try {
    if (notice) io.stderr(notice);
  } catch {
    // A notice must not fail an otherwise successful command.
  }
}
