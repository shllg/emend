import { join } from "node:path";
import type { Io } from "../../main.ts";
import { isStateModeError } from "../../state/files.ts";
import { checkTokenFileMode } from "../../state/token-file.ts";
import { safeMessage } from "../attach/copy.ts";
import { cleanupAttachment, removeAttachment } from "../attach/files.ts";
import { lockAttach } from "../attach/lock.ts";
import { apiRequest, CliError, CliUsageError } from "../http.ts";
import { AttachmentChangedError, AttachmentCredentialError, attachedTarget, readAttachmentPair } from "../target.ts";

export async function detachCommand(stateDir: string, args: string[], io: Io) {
  if (args.length) throw new CliUsageError("Usage: emend detach.");
  await checkTokenFileMode(join(stateDir, "hub.token"));
  const release = lockAttach(stateDir);
  try {
    if (await cleanupAttachment(stateDir, io)) return;
    await detach(stateDir, io);
  } finally {
    release();
  }
}

async function detach(stateDir: string, io: Io) {
  let pair: Awaited<ReturnType<typeof readAttachmentPair>>;
  try {
    pair = await readAttachmentPair(stateDir);
  } catch (error) {
    if (error instanceof AttachmentChangedError || isStateModeError(error)) throw error;
    await removeAttachment(stateDir);
    const from = error instanceof AttachmentCredentialError ? ` from ${safeMessage(error.attachment.hubName)}` : "";
    io.stderr(`emend: detached${from}. The hub was not reached; revoke this machine in its devices.\n`);
    return;
  }
  if (!pair) throw new CliError("emend is not attached.");
  let reached = true;
  try {
    await apiRequest(stateDir, attachedTarget(pair), "/machines/self", {
      method: "DELETE",
      timeoutMs: 5000,
    });
  } catch {
    reached = false;
  }
  await removeAttachment(stateDir);
  io.stderr(
    `emend: detached from ${safeMessage(pair.attachment.hubName)}.${reached ? "" : " The hub was not reached; revoke this machine in its devices."}\n`,
  );
}
