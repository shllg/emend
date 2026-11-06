import { lstat, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { LIMITS } from "@emend/contract";
import type { Io } from "../../main.ts";
import { isStateModeError, StateFolderWriteError, stateAccessError } from "../../state/files.ts";
import { checkTokenFileMode, readTokenFile } from "../../state/token-file.ts";
import { VERSION } from "../../version.ts";
import { escapeReference } from "../escape.ts";
import { OversizedFile, readRegular } from "../publish/read.ts";
import { attachmentHubUrl } from "../target.ts";

/** Remove credential paths, including an empty directory that prevented a write. Never recurse. */
export async function removeAttachment(stateDir: string) {
  await removeFiles(stateDir, ["hub.token", "attach.json"]);
  await removePendingAttachment(stateDir);
}

export async function removePendingAttachment(stateDir: string) {
  await removeFiles(stateDir, ["attach.pending"]);
}

async function removeFiles(stateDir: string, names: string[]) {
  const results = await Promise.allSettled(
    names.map(async (name) => {
      const path = join(stateDir, name);
      try {
        await rm(path, { force: true });
      } catch (error) {
        if (!["EISDIR", "ERR_FS_EISDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        await rmdir(path);
      }
    }),
  );
  for (const result of results) if (result.status === "rejected") throw stateAccessError(stateDir, result.reason);
}

async function present(stateDir: string, name: string, regularOnly = false): Promise<boolean> {
  try {
    const info = await lstat(join(stateDir, name));
    return !regularOnly || info.isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw stateAccessError(stateDir, error);
  }
}

async function pendingHub(stateDir: string): Promise<string | null> {
  const path = join(stateDir, "attach.pending");
  let bytes: Buffer;
  try {
    if (!(await lstat(path)).isFile()) return null;
    bytes = await readRegular(path, LIMITS.publicJsonBytes);
  } catch (error) {
    const mapped = stateAccessError(stateDir, error);
    if (mapped instanceof StateFolderWriteError) throw mapped;
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof OversizedFile) return null;
    throw error;
  }
  try {
    return attachmentHubUrl(JSON.parse(bytes.toString()).hubUrl);
  } catch {
    // An invalid marker cannot establish where a token belongs.
    return null;
  }
}

/** Use only the origin recorded before requesting this token; revocation outlives command signals. */
export async function revokeMachine(hubUrl: string, token: string): Promise<boolean> {
  try {
    // Accept any 2xx, including an empty 200. Never follow a redirect with the token.
    const response = await fetch(new URL("/api/v1/machines/self", hubUrl), {
      method: "DELETE",
      redirect: "error",
      signal: AbortSignal.timeout(5000),
      headers: { Authorization: `Bearer ${token}`, "X-Emend-Client": `cli/${VERSION}` },
    });
    await response.body?.cancel().catch(() => {});
    return response.ok;
  } catch {
    return false;
  }
}

/** The caller must hold the attach lock throughout cleanup and any new registration. */
export async function cleanupAttachment(stateDir: string, io: Io): Promise<boolean> {
  if (await present(stateDir, "attach.json", true)) {
    if (await present(stateDir, "attach.pending")) {
      await checkTokenFileMode(join(stateDir, "hub.token"));
      await removePendingAttachment(stateDir);
    }
    return false;
  }
  const pending = await present(stateDir, "attach.pending");
  const hasToken = await present(stateDir, "hub.token");
  if (!pending && !hasToken) return false;
  const hubUrl = pending ? await pendingHub(stateDir) : null;
  let revoked = false;
  if (hubUrl && hasToken) {
    let token: string | null = null;
    try {
      token = await readTokenFile(join(stateDir, "hub.token"));
    } catch (error) {
      if (isStateModeError(error)) throw error;
      const mapped = stateAccessError(stateDir, error);
      if (mapped instanceof StateFolderWriteError) throw mapped;
    }
    if (token && /^em_[A-Za-z0-9_-]{43}$/.test(token)) revoked = await revokeMachine(hubUrl, token);
  }
  await removeFiles(stateDir, ["hub.token", "attach.json"]);
  if (hubUrl && hasToken)
    io.stderr(
      revoked
        ? `emend: removed an unfinished attachment to ${escapeReference(hubUrl)}; the hub revoked this machine.\n`
        : `emend: removed an unfinished attachment to ${escapeReference(hubUrl)}. The hub did not confirm the revocation; revoke this machine in its devices.\n`,
    );
  else if (hubUrl)
    io.stderr(
      `emend: an earlier attach to ${escapeReference(hubUrl)} did not finish. If the hub lists this machine, revoke it in its devices.\n`,
    );
  else if (hasToken)
    io.stderr("emend: removed a leftover hub token. If a hub lists this machine, revoke it in its devices.\n");
  await removePendingAttachment(stateDir);
  return true;
}
