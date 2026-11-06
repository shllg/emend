import { lstat } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { Capabilities, LIMITS, ReplyCreated } from "@emend/contract";
import { isStateModeError, StateFolderWriteError, stateAccessError } from "../state/files.ts";
import { readTokenFile } from "../state/token-file.ts";
import { VERSION } from "../version.ts";
import { CliError, hubFailure, hubFailureReason } from "./http.ts";
import { readRegular } from "./publish/read.ts";
import { discover } from "./server-client.ts";

export type HttpTarget = { url: string; token: string; via: "local" | "hub" };
export type Target = HttpTarget | { via: "direct" };

export function attachmentUrl(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid");
  const record = input as Record<string, unknown>;
  if (
    Object.keys(record).filter((key) => key !== "registration").length !== 3 ||
    !ReplyCreated.shape.commentId.safeParse(record.hubId).success ||
    typeof record.hubName !== "string" ||
    record.hubName.length < 1 ||
    record.hubName.length > 200
  )
    throw new Error("invalid");
  return attachmentHubUrl(record.hubUrl);
}

/** Shared by complete attachments and the origin saved before requesting a token. */
export function attachmentHubUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid");
  // Reject URL parser repairs (whitespace, backslashes, dot paths) as well as credentials.
  if (!/^https?:\/\/[^/?#\\\s]+\/?$/.test(value)) throw new Error("invalid");
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const loopback = host === "localhost" || host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
  if (url.username || url.password || (url.protocol !== "https:" && !loopback)) throw new Error("invalid");
  return url.origin;
}

async function credential(stateDir: string, kind: "agent" | "admin" | "hub"): Promise<string> {
  let token: string | null;
  try {
    token = await readTokenFile(join(stateDir, `${kind}.token`));
  } catch (error) {
    if (isStateModeError(error)) throw error;
    const mapped = stateAccessError(stateDir, error);
    if (mapped instanceof StateFolderWriteError) throw mapped;
    throw new CliError("Could not read the emend credential.");
  }
  if (!token || !/^em_[A-Za-z0-9_-]{43}$/.test(token)) throw new CliError("The emend credential is invalid.");
  return token;
}

export async function localTarget(
  stateDir: string,
  url: string,
  kind: "agent" | "admin" = "agent",
): Promise<HttpTarget> {
  return { url, token: await credential(stateDir, kind), via: "local" };
}

type Attachment = { hubId: string; hubName: string; hubUrl: string };
type AttachmentPair = { attachment: Attachment; token: string };

export class AttachmentChangedError extends CliError {
  constructor() {
    super("the attachment changed while this command started. Run it again. Nothing was changed.");
  }
}

export class AttachmentCredentialError extends CliError {
  readonly attachment: Attachment;
  constructor(attachment: Attachment, error: unknown) {
    super(error instanceof CliError ? error.message : "Could not read the emend credential.");
    this.attachment = attachment;
  }
}

async function attachmentBytes(stateDir: string): Promise<Buffer | null> {
  const path = join(stateDir, "attach.json");
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    const mapped = stateAccessError(stateDir, error);
    if (mapped instanceof StateFolderWriteError) throw mapped;
    throw new CliError("Could not read the emend attachment.");
  }
  try {
    return await readRegular(path, LIMITS.publicJsonBytes);
  } catch (error) {
    const mapped = stateAccessError(stateDir, error);
    if (mapped instanceof StateFolderWriteError) throw mapped;
    throw new CliError("The emend attachment is invalid or unreadable.");
  }
}

function parseAttachment(bytes: Buffer): Attachment {
  try {
    const record = JSON.parse(bytes.toString());
    return { hubId: record.hubId, hubName: record.hubName, hubUrl: attachmentUrl(record) };
  } catch {
    throw new CliError("The emend attachment is invalid or unreadable.");
  }
}

export async function readAttachment(stateDir: string): Promise<Attachment | null> {
  const bytes = await attachmentBytes(stateDir);
  return bytes === null ? null : parseAttachment(bytes);
}

export async function readAttachmentPair(stateDir: string): Promise<AttachmentPair | null> {
  // Registration holds the attach lock, requires attach.json to be absent, and
  // alone writes its fresh id. Equal bytes mean no registration wrote hub.token
  // between these reads.
  const before = await attachmentBytes(stateDir);
  const attachment = before === null ? null : parseAttachment(before);
  let token: string | null = null;
  let tokenError: unknown;
  try {
    token = attachment ? await credential(stateDir, "hub") : null;
  } catch (error) {
    tokenError = error;
  }
  // Check even if the token read failed: a concurrent detach must not turn
  // into invalid-state cleanup that deletes a replacement attachment.
  let after: Buffer | null;
  try {
    after = await attachmentBytes(stateDir);
  } catch (error) {
    if (error instanceof StateFolderWriteError) throw error;
    throw new AttachmentChangedError();
  }
  if (before === null ? after !== null : after === null || !before.equals(after)) throw new AttachmentChangedError();
  if (tokenError instanceof StateFolderWriteError || isStateModeError(tokenError)) throw tokenError;
  if (attachment && tokenError) throw new AttachmentCredentialError(attachment, tokenError);
  return attachment && token ? { attachment, token } : null;
}

export async function hubCapabilities(
  url: string,
  callerSignal?: AbortSignal,
  stateDir?: string,
): Promise<Capabilities> {
  callerSignal?.throwIfAborted();
  const failure = (reason: string) => hubFailureReason(url, reason, stateDir);
  const timeout = AbortSignal.timeout(5000);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(`${url}/api/v1/capabilities`, {
      redirect: "error",
      signal,
      headers: { "X-Emend-Client": `cli/${VERSION}` },
    });
  } catch (error) {
    callerSignal?.throwIfAborted();
    throw hubFailure(url, error, signal, stateDir);
  }
  if (!response.ok) throw failure("not an emend hub");
  try {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("invalid");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > LIMITS.publicJsonBytes) {
          await reader.cancel();
          throw new Error("too large");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return Capabilities.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch {
    callerSignal?.throwIfAborted();
    throw failure(signal.aborted ? "timed out" : "not an emend hub");
  }
}

export function attachedTarget({ attachment, token }: AttachmentPair): HttpTarget {
  return { url: attachment.hubUrl, token, via: "hub" };
}

export async function resolveTarget(stateDir: string, pair?: AttachmentPair | null): Promise<Target> {
  if (pair === undefined) pair = await readAttachmentPair(stateDir);
  if (!pair) {
    const server = await discover(stateDir, 5000);
    return server ? localTarget(stateDir, server.url) : { via: "direct" };
  }
  const target = attachedTarget(pair);
  await hubCapabilities(target.url, undefined, stateDir);
  return target;
}
