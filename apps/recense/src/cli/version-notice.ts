import type { Io } from "../main.ts";
import { VERSION } from "../version.ts";
import { escapeReference } from "./escape.ts";
import { probeServer, serverRecord } from "./server-client.ts";
import { servicePid } from "./service/pid.ts";
import { hubCapabilities } from "./target.ts";

const updateUrl = "https://github.com/shllg/recense/blob/release/docs/setup/update.md";

function plainVersion(version: string): bigint[] | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  return match?.[0] === version ? match.slice(1).map(BigInt) : null;
}

/** -1 when `version` is older than `other`, 1 when newer, 0 when equal, null when either is not plain x.y.z. */
export function compareVersions(version: string, other: string): number | null {
  if (version === other) return 0;
  const left = plainVersion(version);
  const right = plainVersion(other);
  if (!left || !right) return null;
  for (const [index, part] of left.entries()) {
    const current = right[index];
    if (current === undefined) return null;
    if (part !== current) return part < current ? -1 : 1;
  }
  return 0;
}

function compareVersion(version: string): number | null {
  return compareVersions(version, VERSION);
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
      return `recense: the recense server at ${url} runs recense ${version}, newer than this recense ${VERSION}; update recense: ${updateUrl}\n`;
    }
    const pid = await servicePid(io);
    if (pid === null) return;
    const fix =
      pid === record.pid
        ? `Run recense service install to restart it on recense ${VERSION}.`
        : `Run recense stop, then recense, to start recense ${VERSION}.`;
    return `recense: the recense server at ${url} runs recense ${version}; this is recense ${VERSION}. ${fix}\n`;
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
    return `recense: the hub at ${escapeReference(url)} runs recense ${escapeReference(capabilities.version)}; this machine runs recense ${VERSION}. ${fix}: ${updateUrl}\n`;
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
