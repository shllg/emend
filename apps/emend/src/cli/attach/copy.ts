import { ImportResult } from "@emend/contract";
import { and, asc, eq } from "drizzle-orm";
import { reviews } from "../../db/schema.ts";
import type { Io } from "../../main.ts";
import type { initializeServerState } from "../../server/state.ts";
import { apiRequest, CliApiError, CliConnectionError, CliError } from "../http.ts";
import { pause } from "../pause.ts";
import type { HttpTarget } from "../target.ts";
import { snapshot } from "./bundle.ts";
import { withAttachSignals } from "./signals.ts";

export function safeMessage(message: string): string {
  return message
    .replace(/(?:em_|emp_)[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/\p{Cc}|[\u2028\u2029]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
const refused = (error: unknown) => error instanceof CliApiError && error.status >= 400 && error.status < 500;

/** Only evidence that settles every possible import may reopen local delivery. */
export function canClearCopyMark(state: { newMark: boolean; latest: ImportOutcome }, _finalError: unknown): boolean {
  // A local error cannot undo the latest import answer's evidence.
  return state.latest === "absent" || (state.latest === "none" && state.newMark);
}
type ImportOutcome = "none" | "unknown" | "absent" | "other";
function reason(error: unknown): string {
  if (error instanceof CliApiError && error.status === 401)
    return "the hub rejected this machine's credential. Run emend detach, then attach again";
  return error instanceof CliApiError && error.code === "too_large"
    ? "too large"
    : error instanceof CliError
      ? safeMessage(error instanceof CliApiError ? error.serverMessage : error.message).replace(/\.$/, "")
      : "The copy's outcome could not be read";
}

export async function copyReviews(
  stateDir: string,
  state: Awaited<ReturnType<typeof initializeServerState>>,
  target: HttpTarget,
  io: Io,
  hubHasBin: boolean,
  signal?: AbortSignal,
) {
  return signal
    ? copy(stateDir, state, target, io, hubHasBin, signal)
    : withAttachSignals((signal) => copy(stateDir, state, target, io, hubHasBin, signal));
}

async function copy(
  stateDir: string,
  state: Awaited<ReturnType<typeof initializeServerState>>,
  target: HttpTarget,
  io: Io,
  hubHasBin: boolean,
  signal: AbortSignal,
) {
  const { db, ownerId, instance, blobs } = state;
  const candidates = await db.read((q) =>
    q
      .select({ id: reviews.id })
      .from(reviews)
      .where(and(eq(reviews.ownerId, ownerId), eq(reviews.originInstanceId, instance.id)))
      .orderBy(asc(reviews.createdAt), asc(reviews.id)),
  );
  let copied = 0,
    skipped = 0,
    failed = 0;
  for (const { id } of candidates) {
    signal.throwIfAborted();
    io.stderr(`emend: copying review ${id}…\n`);
    const movedToUrl = `${target.url}/r/${id}`;
    const evidence: { newMark: boolean; latest: ImportOutcome } = { newMark: false, latest: "none" };
    let unknownSeen = false;
    let snapshotted = false;
    try {
      const result = await db.transaction(
        (q) => snapshot(q, ownerId, instance.id, id, movedToUrl, Date.now(), hubHasBin),
        {
          offThread: true,
        },
      );
      if (result.kind === "skipped") {
        skipped++;
        continue;
      }
      if (result.kind === "live") {
        failed++;
        io.stderr(`emend: review ${id} has a running wait; run emend attach again when it ends.\n`);
        continue;
      }
      evidence.newMark = !result.resend;
      snapshotted = true;
      signal.throwIfAborted();
      const upload = async () => {
        const hashes = new Set(
          [
            ...result.bundle.files.flatMap((f) => [f.oldBlob, f.newBlob, f.renderedBlob]),
            ...result.bundle.writeups.flatMap((w) => [w.sourceBlob, w.renderedBlob]),
          ].filter((hash): hash is string => hash !== null),
        );
        for (const hash of hashes) {
          if (await apiRequest(stateDir, target, `/blobs/${hash}`, { method: "HEAD", missingOk: true, signal }))
            continue;
          signal.throwIfAborted();
          const bytes = await blobs.get(ownerId, hash);
          if (!bytes) throw new CliError("A required blob is missing");
          await apiRequest(stateDir, target, `/blobs/${hash}`, {
            method: "PUT",
            raw: Buffer.from(bytes),
            timeoutMs: 30000,
            signal,
          });
        }
      };
      // Each operation retries a busy hub, and reconciles at most one unknown outcome.
      const send = async () => {
        let unknown = false;
        let retries = 0;
        for (;;) {
          signal.throwIfAborted();
          try {
            return ImportResult.parse(
              await apiRequest(stateDir, target, "/import", {
                method: "POST",
                json: result.json,
                timeoutMs: 300000,
                signal,
                onSend: () => {
                  evidence.latest = "unknown";
                },
                successStatuses: [200, 201],
              }),
            );
          } catch (error) {
            if (refused(error)) {
              // blob_missing proves absence: it comes from inside the import
              // slot, after checking that the hub does not already hold the review.
              evidence.latest =
                (evidence.newMark && !unknownSeen) ||
                (error instanceof CliApiError && [400, 413].includes(error.status))
                  ? "absent"
                  : "other";
            }
            signal.throwIfAborted();
            if (error instanceof CliApiError && error.status === 429 && error.code === "rate_limited" && retries < 5) {
              retries++;
              await pause(1000, signal);
              continue;
            }
            if (refused(error) || error instanceof CliConnectionError) throw error;
            unknownSeen = true;
            if (unknown) throw error;
            unknown = true;
          }
        }
      };
      let imported: ImportResult;
      if (!result.resend) await upload();
      try {
        imported = await send();
      } catch (error) {
        if (!(error instanceof CliApiError) || error.status !== 400 || error.code !== "blob_missing") throw error;
        await upload();
        imported = await send();
      }
      if (imported.skipped) skipped++;
      else copied++;
    } catch (error) {
      // Recovery failures retain absence evidence; only another send replaces it.
      const clear = canClearCopyMark(evidence, error);
      let clearFailed = false;
      if (clear) {
        try {
          await db.transaction(
            (q) =>
              q
                .update(reviews)
                .set({ movedToUrl: null })
                .where(
                  and(
                    eq(reviews.ownerId, ownerId),
                    eq(reviews.originInstanceId, instance.id),
                    eq(reviews.id, id),
                    eq(reviews.movedToUrl, movedToUrl),
                  ),
                ),
            { offThread: true },
          );
        } catch {
          clearFailed = true;
        }
      }
      if (signal.aborted) {
        if (clearFailed)
          io.stderr(
            `emend: could not confirm the copy of review ${id}: could not clear the local mark. Run emend attach again.\n`,
          );
        signal.throwIfAborted();
      }
      failed++;
      if (clearFailed || (snapshotted && !clear)) {
        const recovery =
          !clearFailed && error instanceof CliApiError && error.status === 401 ? "" : " Run emend attach again.";
        io.stderr(
          `emend: could not confirm the copy of review ${id}: ${clearFailed ? "could not clear the local mark" : reason(error)}.${recovery}\n`,
        );
      } else io.stderr(`emend: could not copy review ${id}: ${reason(error)}.\n`);
    }
  }
  signal.throwIfAborted();
  return { copied, skipped, failed };
}
