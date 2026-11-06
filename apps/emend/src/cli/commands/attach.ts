import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { LIMITS, MachineRegistered, MachineRegistration } from "@emend/contract";
import type { Io } from "../../main.ts";
import { initializeServerState } from "../../server/state.ts";
import { stateAccessError, writeSecretFile } from "../../state/files.ts";
import { checkTokenFileMode } from "../../state/token-file.ts";
import { copyReviews, safeMessage } from "../attach/copy.ts";
import { cleanupAttachment, removeAttachment, removePendingAttachment, revokeMachine } from "../attach/files.ts";
import { lockAttach } from "../attach/lock.ts";
import { withAttachSignals } from "../attach/signals.ts";
import {
  apiRequest,
  CliApiError,
  CliError,
  CliHttpError,
  CliSignalExit,
  CliUnansweredError,
  CliUsageError,
  errorLine,
} from "../http.ts";
import { attachedTarget, attachmentUrl, hubCapabilities, readAttachmentPair } from "../target.ts";

export function pairingLink(value: string) {
  try {
    if (value.length > LIMITS.pathChars || !/^https?:\/\/[^/?#@\\\s]+\/pair#emp_[A-Za-z0-9_-]{43}$/.test(value))
      throw new Error();
    const url = new URL(value);
    attachmentUrl({
      hubId: "00000000-0000-4000-8000-000000000000",
      hubName: "Hub",
      hubUrl: value.slice(0, value.indexOf("/pair#")),
    });
    return { origin: url.origin, secret: url.hash.slice(1) };
  } catch {
    throw new CliUsageError("Invalid pairing link.");
  }
}

export async function attachCommand(stateDir: string, args: string[], io: Io) {
  if (args.length !== 1) throw new CliUsageError("Invalid pairing link.");
  const link = pairingLink(args[0] ?? "");
  await checkTokenFileMode(join(stateDir, "hub.token"));
  const release = lockAttach(stateDir);
  try {
    await withAttachSignals((signal) => attach(stateDir, link, io, signal));
  } finally {
    release();
  }
}

async function attach(stateDir: string, link: ReturnType<typeof pairingLink>, io: Io, signal: AbortSignal) {
  await cleanupAttachment(stateDir, io);
  signal.throwIfAborted();
  let pair = await readAttachmentPair(stateDir);
  if (pair && pair.attachment.hubUrl !== link.origin)
    throw new CliError(`emend is attached to ${safeMessage(pair.attachment.hubName)}. Run emend detach first.`);
  const capabilities = await hubCapabilities(link.origin, signal);
  if (!capabilities.features.includes("attach"))
    throw new CliError(`the server at ${link.origin} cannot accept machines.`);
  const state = await initializeServerState(stateDir, { tokens: false });
  try {
    signal.throwIfAborted();
    if (!pair) pair = await register(stateDir, link, state.instance, io, signal);
    const result = await copyReviews(stateDir, state, attachedTarget(pair), io, signal);
    io.stderr(
      `emend: attached to ${safeMessage(pair.attachment.hubName)}; copied ${result.copied} reviews, skipped ${result.skipped}.\n`,
    );
    if (result.failed) throw new CliSignalExit(1);
  } finally {
    await state.db.close();
  }
}

async function register(
  stateDir: string,
  link: ReturnType<typeof pairingLink>,
  instance: { id: string; name: string },
  io: Io,
  signal: AbortSignal,
) {
  let saveFailed = false;
  try {
    const machine = {
      id: instance.id,
      name:
        instance.name
          .replace(/[^a-zA-Z0-9 ._()/;-]/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 200) || "Machine",
    };
    const request = MachineRegistration.parse({ secret: link.secret, instance: machine });
    const unreadable = () =>
      new CliError("the hub's answer could not be read. Revoke this machine in the hub's devices.");
    try {
      writeSecretFile(join(stateDir, "attach.pending"), JSON.stringify({ hubUrl: link.origin }), stateDir);
    } catch {
      throw new CliError("could not save the attachment.");
    }
    let registered: MachineRegistered;
    let sent = false;
    const revokeGuidance = "Revoke this machine in the hub's devices before you attach again.";
    try {
      const response = await apiRequest(stateDir, { via: "hub", url: link.origin, token: "" }, "/machines", {
        method: "POST",
        body: request,
        successStatuses: [201],
        signal,
        onSend: () => {
          sent = true;
        },
      });
      const parsed = MachineRegistered.safeParse(response);
      if (!parsed.success) throw unreadable();
      registered = parsed.data;
    } catch (error) {
      if (signal.aborted) {
        if (sent && !(error instanceof CliApiError))
          io.stderr(`emend: ${new CliUnansweredError(link.origin).message} ${revokeGuidance}\n`);
        signal.throwIfAborted();
      }
      if (error instanceof CliHttpError && error.status === 201) throw unreadable();
      if (error instanceof CliUnansweredError) throw new CliError(`${error.message} ${revokeGuidance}`);
      if (error instanceof CliApiError) throw new CliError(safeMessage(error.serverMessage));
      throw error;
    }
    if (signal.aborted) {
      if (!(await revokeMachine(link.origin, registered.token)))
        io.stderr(
          "emend: the hub registered this machine before emend stopped. Revoke this machine in the hub's devices.\n",
        );
      signal.throwIfAborted();
    }
    const revokeAdvice = " Revoke this machine in the hub's devices.";
    if (new URL(registered.hub.url).origin !== link.origin) {
      const revoked = await revokeMachine(link.origin, registered.token);
      throw new CliError(`the hub's address does not match the pairing link.${revoked ? "" : revokeAdvice}`);
    }
    const attachment = {
      hubId: registered.hub.id,
      hubName: safeMessage(registered.hub.name).slice(0, 200) || "Hub",
      hubUrl: link.origin,
      registration: randomBytes(16).toString("base64url"),
    };
    try {
      writeSecretFile(join(stateDir, "hub.token"), registered.token, stateDir);
      writeSecretFile(join(stateDir, "attach.json"), JSON.stringify(attachment), stateDir);
    } catch {
      saveFailed = true;
      const revoked = await revokeMachine(link.origin, registered.token);
      throw new CliError(`could not save the attachment.${revoked ? "" : revokeAdvice}`);
    }
    return { attachment, token: registered.token };
  } catch (error) {
    // Print recovery guidance before removing the crash marker, including on signals.
    if (error instanceof CliSignalExit) throw error;
    io.stderr(errorLine(stateAccessError(stateDir, error)));
    throw new CliSignalExit(1);
  } finally {
    // The next command can finish cleanup; preserve this operation's single diagnostic and result.
    if (saveFailed) await removeAttachment(stateDir).catch(() => {});
    else await removePendingAttachment(stateDir).catch(() => {});
  }
}
