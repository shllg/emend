import { ERROR_STATUS, ErrorBody, type ErrorCode, LIMITS } from "@emend/contract";
import { NewerDatabaseError } from "../db/migrate.ts";
import type { Io } from "../main.ts";
import { ApiError } from "../server/http/errors.ts";
import { StateDirModeError, StateFolderWriteError, stateFolderWritable, TokenFileModeError } from "../state/files.ts";
import { VERSION } from "../version.ts";
import { CliError } from "./error.ts";
import { escapeJson, escapeReference, quoteShellArgument } from "./escape.ts";
import { discover } from "./server-client.ts";
import type { Target } from "./target.ts";

export { CliError } from "./error.ts";

const MAX_REPLY_BYTES = 4 * LIMITS.handoffBytes;

export class CliSignalExit extends Error {
  readonly exitCode: number;
  constructor(exitCode: number) {
    super("Interrupted");
    this.exitCode = exitCode;
  }
}
export const sandboxHint =
  "If an agent sandbox runs emend, let emend run outside it: https://github.com/shllg/emend/blob/release/docs/setup/troubleshooting.md#an-agents-sandbox-blocks-emend";

export class CliUsageError extends CliError {}
export class CliConnectionError extends CliError {}
function hubUnanswered(url: string): string {
  return `the hub at ${url} did not answer. The request may have reached it; check before trying again.`;
}
export function hubFailure(url: string, error?: unknown, signal?: AbortSignal, stateDir?: string): CliError {
  const cause = error instanceof Error ? (error.cause as { code?: string } | undefined) : undefined;
  const reason =
    signal?.aborted || (error instanceof Error && error.name === "TimeoutError")
      ? "timed out"
      : cause?.code === "ECONNREFUSED"
        ? "connection refused"
        : "connection failed";
  return hubFailureReason(url, reason, stateDir);
}

export function hubFailureReason(url: string, reason: string, stateDir?: string): CliError {
  return new CliError(`cannot reach the hub at ${url}: ${reason}. Nothing was changed.`, stateDir);
}

export function errorLine(error: unknown, command?: string): string {
  const hint =
    ["publish", "wait", "feedback", "reply"].includes(command ?? "") &&
    (error instanceof StateFolderWriteError ||
      (error instanceof CliError && error.sandboxStateDir !== undefined && !stateFolderWritable(error.sandboxStateDir)))
      ? ` ${sandboxHint}`
      : "";
  if (error instanceof StateFolderWriteError)
    return `emend cannot write its state folder ${escapeReference(error.dir)}.${hint}\n`;
  if (error instanceof StateDirModeError) {
    const dir = escapeReference(error.dir);
    const quoted = quoteShellArgument(error.dir);
    return `State directory ${dir} has group or other permissions; fix it with chmod 700 ${quoted}\n`;
  }
  if (error instanceof TokenFileModeError) {
    const path = escapeReference(error.path);
    const quoted = quoteShellArgument(error.path);
    return `Token file ${path} has group or other permissions; fix it with chmod 600 ${quoted}\n`;
  }
  if (error instanceof NewerDatabaseError) return `${error.message}\n`;
  if (
    command === "publish" &&
    error instanceof CliApiError &&
    error.code === "invalid_request" &&
    error.serverMessage.startsWith("Agent note ")
  )
    return `emend: invalid_request: ${escapeReference(error.serverMessage)}\n`;
  return `emend: ${error instanceof CliApiError ? error.code : error instanceof CliError ? error.message : "The emend request failed."}${hint}\n`;
}
export const jsonLine = (value: unknown): string => `${JSON.stringify(value)}\n`;

export async function printJson(io: Io, value: unknown): Promise<void> {
  try {
    await (io.stdoutAsync ?? io.stdout)(jsonLine(value));
  } catch {
    throw new CliError("Could not write to stdout.");
  }
}
/** Like printJson, with controls and invisible characters escaped for a terminal; JSON.parse gives the same value. */
export async function printTerminalJson(io: Io, value: unknown): Promise<void> {
  try {
    await (io.stdoutAsync ?? io.stdout)(`${escapeJson(JSON.stringify(value))}\n`);
  } catch {
    throw new CliError("Could not write to stdout.");
  }
}
export const publishAnswerIncomplete = "the server's answer was cut off; the revision may have been published";
export class CliHttpError extends CliError {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export class CliUnansweredError extends CliHttpError {
  constructor(url: string, status = 0) {
    super(status, hubUnanswered(url));
  }
}
export class CliApiError extends CliHttpError {
  readonly code: ErrorCode;
  readonly serverMessage: string;
  constructor(code: ErrorCode, serverMessage = new ApiError(code).message, status: number = ERROR_STATUS[code]) {
    super(status, new ApiError(code).message);
    this.code = code;
    this.serverMessage = serverMessage;
  }
}

class ReplyTooLarge extends Error {}

async function readReplyJson(response: Response): Promise<unknown> {
  if (Number(response.headers.get("Content-Length")) > MAX_REPLY_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw new ReplyTooLarge();
  }
  const reader = response.body?.getReader();
  if (!reader) throw new SyntaxError("Unexpected end of JSON input");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_REPLY_BYTES) {
        void reader.cancel().catch(() => {});
        throw new ReplyTooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
}

export async function apiRequest(
  stateDir: string,
  target: Target,
  path: string,
  opts: {
    method: string;
    body?: unknown;
    raw?: Buffer;
    json?: string;
    missingOk?: boolean;
    timeoutMs?: number;
    signal?: AbortSignal;
    onSend?: () => void;
    successStatuses?: readonly number[];
    verifyLocal?: () => Promise<boolean>;
  },
): Promise<unknown> {
  if (target.via === "direct") throw new CliError("The emend request requires a server.");
  opts.signal?.throwIfAborted();
  if (
    target.via === "local" &&
    !(opts.verifyLocal ? await opts.verifyLocal() : await discover(stateDir, 5000, target.url))
  )
    throw new CliError("Could not authenticate the emend server.");
  opts.signal?.throwIfAborted();
  let response: Response;
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 5000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  try {
    response = await fetch(new URL(`/api/v1${path}`, target.url), {
      method: opts.method,
      redirect: "error",
      signal,
      headers: {
        ...(target.token ? { Authorization: `Bearer ${target.token}` } : {}),
        "X-Emend-Client": `cli/${VERSION}`,
        "Content-Type": opts.raw === undefined ? "application/json" : "application/octet-stream",
        ...(opts.raw === undefined ? {} : { "Content-Length": String(opts.raw.length) }),
      },
      ...(opts.raw === undefined
        ? opts.body === undefined && opts.json === undefined
          ? {}
          : { body: opts.json ?? JSON.stringify(opts.body) }
        : { body: new Uint8Array(opts.raw) }),
    });
  } catch (error) {
    const cause = error instanceof Error ? (error.cause as { code?: string } | undefined) : undefined;
    const unconnected = ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(cause?.code ?? "");
    // Fetch has no connection callback. Once it settles, exclude only proven
    // pre-connection failures; cancellation and every other failure may have sent.
    if (!unconnected) opts.onSend?.();
    opts.signal?.throwIfAborted();
    if (target.via === "hub") {
      if (unconnected) {
        const failure = hubFailure(target.url, error, signal, stateDir);
        throw new CliConnectionError(failure.message, failure.sandboxStateDir);
      }
      if (!["GET", "HEAD"].includes(opts.method)) throw new CliUnansweredError(target.url);
      throw hubFailure(target.url, error, signal, stateDir);
    }
    if (path === "/publish" && signal.aborted)
      throw new CliError("the server did not answer in time; nothing was published");
    throw new CliError("Could not contact the emend server.");
  }
  opts.onSend?.();
  // Import reconciliation must distinguish an emend refusal from a gateway's
  // bare 401. Other commands retain the credential recovery diagnostic.
  if (response.status === 401 && target.via === "hub" && target.token && path !== "/import")
    throw new CliHttpError(
      401,
      `the hub at ${target.url} rejected this machine's credential. Run emend detach, then attach again. Nothing was changed.`,
    );
  if (opts.method === "HEAD") {
    if (response.ok) return true;
    if (response.status === 404 && opts.missingOk) return false;
    throw new CliError("The emend request failed.");
  }
  let body: unknown;
  try {
    body = response.status === 204 ? null : await readReplyJson(response);
  } catch (error) {
    opts.signal?.throwIfAborted();
    if (error instanceof ReplyTooLarge) {
      if (path === "/publish" && response.status === 200) throw new CliError(publishAnswerIncomplete);
      if (target.via === "hub" && !["GET", "HEAD"].includes(opts.method))
        throw new CliUnansweredError(target.url, response.status);
      throw new CliHttpError(
        response.status,
        `the emend server's answer was larger than ${MAX_REPLY_BYTES / (1024 * 1024)} MiB.`,
      );
    }
    if (
      target.via === "hub" &&
      !["GET", "HEAD"].includes(opts.method) &&
      !(error instanceof SyntaxError) &&
      !(response.status >= 400 && response.status < 500)
    )
      throw new CliUnansweredError(target.url, response.status);
    if (path === "/publish" && response.status === 200)
      throw new CliError(
        signal.aborted
          ? "the server's answer timed out; the revision may have been published"
          : publishAnswerIncomplete,
      );
    throw new CliHttpError(response.status, "The emend server returned an invalid response.");
  }
  if (!response.ok) {
    const parsed = ErrorBody.safeParse(body);
    if (parsed.success) throw new CliApiError(parsed.data.error.code, parsed.data.error.message, response.status);
    throw new CliHttpError(response.status, "The emend request failed.");
  }
  if (opts.successStatuses && !opts.successStatuses.includes(response.status))
    throw new CliHttpError(response.status, "The emend server returned an invalid response.");
  return body;
}
