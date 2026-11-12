import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ReplyCreated, ReplyRequest } from "@emend/contract";
import type { Io } from "../../main.ts";
import { replyDirect } from "../direct/index.ts";
import { apiRequest, CliError, CliUsageError, printJson } from "../http.ts";
import { binnedError, movedError } from "../moved.ts";
import { assertSaveFolder, checkSaveFolder } from "../save-feedback.ts";
import { resolveTarget, type Target } from "../target.ts";

const maxBodyBytes = 80000;
const invalidBodyFile = () =>
  new CliError("--body-file must be a .md or .txt file in a private folder you own (mode 0700).");
export async function readReplyBody(path: string, io: Io, stateDir: string): Promise<string> {
  const bytes = Buffer.alloc(maxBodyBytes + 1);
  let length = 0;
  try {
    if (path === "-") {
      for await (const chunk of io.stdin ?? process.stdin) {
        const buffer =
          typeof chunk === "string"
            ? Buffer.from(chunk)
            : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        const count = Math.min(buffer.length, bytes.length - length);
        bytes.set(buffer.subarray(0, count), length);
        length += count;
        if (length > maxBodyBytes) throw new Error("too large");
      }
    } else {
      const filePath = resolve(path);
      if (!/\.(md|txt)$/i.test(filePath)) throw invalidBodyFile();
      const folder = await checkSaveFolder(dirname(filePath), stateDir).catch(() => {
        throw invalidBodyFile();
      });
      try {
        const file = await open(
          filePath,
          constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
        ).catch(() => {
          throw invalidBodyFile();
        });
        try {
          const info = await file.stat().catch(() => {
            throw invalidBodyFile();
          });
          const entry = await lstat(filePath).catch(() => {
            throw invalidBodyFile();
          });
          if (
            !info.isFile() ||
            !entry.isFile() ||
            entry.dev !== info.dev ||
            entry.ino !== info.ino ||
            (process.getuid && info.uid !== process.getuid())
          )
            throw invalidBodyFile();
          await assertSaveFolder(folder).catch(() => {
            throw invalidBodyFile();
          });
          while (length < bytes.length) {
            const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
            if (!bytesRead) break;
            length += bytesRead;
          }
          await assertSaveFolder(folder).catch(() => {
            throw invalidBodyFile();
          });
        } finally {
          await file.close();
        }
      } finally {
        await folder.handle.close();
      }
    }
    if (length > maxBodyBytes) throw new Error("too large");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      "Could not read the reply body; expected UTF-8 text of at most 80000 bytes from a regular file or stdin.",
    );
  }
}

export async function sendReply(
  stateDir: string,
  target: Target,
  commentId: string,
  reply: ReplyRequest,
  signal?: AbortSignal,
): Promise<ReplyCreated> {
  try {
    if (target.via === "direct") return await replyDirect(stateDir, commentId, reply, signal);
    const result = ReplyCreated.safeParse(
      await apiRequest(stateDir, target, `/comments/${commentId}/reply`, { method: "POST", body: reply, signal }),
    );
    if (!result.success) throw new CliError("The emend server returned an invalid response.");
    return result.data;
  } catch (error) {
    return movedError(stateDir, error, { commentId }).catch((next) => binnedError(stateDir, next, { commentId }));
  }
}

export async function replyCommand(stateDir: string, args: string[], io: Io) {
  const usage = () =>
    new CliUsageError("Usage: emend reply <comment> --status <outcome> (--body <text> | --body-file <path | ->).");
  const id = ReplyCreated.shape.commentId.safeParse(args[0]);
  if (!id.success) throw usage();
  const options = new Map<string, string>();
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (!flag || !["--status", "--body", "--body-file"].includes(flag) || value === undefined || options.has(flag))
      throw usage();
    options.set(flag, value);
  }
  if (
    options.has("--body") === options.has("--body-file") ||
    !ReplyRequest.shape.outcome.safeParse(options.get("--status")).success
  )
    throw usage();
  const body = options.has("--body")
    ? options.get("--body")
    : await readReplyBody(options.get("--body-file") ?? "", io, stateDir);
  const reply = ReplyRequest.safeParse({ outcome: options.get("--status"), body });
  if (!reply.success) throw new CliUsageError("Invalid reply outcome or body.");
  const target = await resolveTarget(stateDir);
  await printJson(io, await sendReply(stateDir, target, id.data, reply.data));
}
