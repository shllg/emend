import { MAX_TAKE_WAIT_SECONDS, WaitResult } from "@emend/contract";
import type { Io } from "../../main.ts";
import { confirmDirect, takeDirect } from "../direct/index.ts";
import { apiRequest, CliError, CliSignalExit, CliUsageError, jsonLine, printJson } from "../http.ts";
import { binnedError, deletedError, movedError } from "../moved.ts";
import { pause } from "../pause.ts";
import {
  type CheckedFolder,
  checkSaveFolder,
  cleanupFeedback,
  saveFeedback,
  verifySavedFeedback,
} from "../save-feedback.ts";
import { resolveTarget, type Target } from "../target.ts";

export const ReviewId = WaitResult.options[2].shape.reviewId;
export const confirmWarning = "emend: Could not confirm receipt; the same feedback will be offered again.\n";

function parseFeedback(value: unknown, reviewId: string): WaitResult {
  const parsed = WaitResult.safeParse(value);
  if (!parsed.success || parsed.data.reviewId !== reviewId)
    throw new CliError("The emend server returned an invalid response.");
  return parsed.data;
}

export async function takeFeedback(
  stateDir: string,
  target: Target,
  reviewId: string,
  timeoutSeconds: number,
  options: { signal?: AbortSignal; progress?: (seconds: number) => Promise<void>; maxBytes?: number } = {},
): Promise<WaitResult> {
  try {
    if (target.via === "direct")
      return parseFeedback(await takeDirect(stateDir, reviewId, timeoutSeconds, options), reviewId);
    const start = performance.now();
    const deadline = start + timeoutSeconds * 1000;
    do {
      options.signal?.throwIfAborted();
      const roundStart = performance.now();
      const remaining = Math.max(0, (deadline - roundStart) / 1000);
      if (timeoutSeconds > 0 && remaining < 0.05) {
        await pause(remaining * 1000, options.signal);
        break;
      }
      const waitSeconds = Math.min(MAX_TAKE_WAIT_SECONDS, remaining);
      const result = parseFeedback(
        await apiRequest(stateDir, target, `/reviews/${reviewId}/take`, {
          method: "POST",
          body: {
            waitSeconds,
            // This CLI parses the closed result, so a retired or snoozed review may answer with it.
            accepts: ["closed"],
            ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
          },
          timeoutMs: Math.ceil((waitSeconds + 10) * 1000),
          signal: options.signal,
        }),
        reviewId,
      );
      options.signal?.throwIfAborted();
      if (result.kind !== "pending") return result;
      await pause(Math.min(deadline, roundStart + waitSeconds * 1000) - performance.now(), options.signal);
      if (waitSeconds === MAX_TAKE_WAIT_SECONDS)
        await options.progress?.(Math.floor((performance.now() - start) / 1000));
    } while (performance.now() < deadline);
    return {
      kind: "pending",
      reviewId,
      waitedSeconds: timeoutSeconds === 0 ? 0 : Math.floor((performance.now() - start) / 1000),
    };
  } catch (error) {
    return deletedError(stateDir, error, reviewId, target.via === "hub" ? target.url : undefined)
      .catch((next) => movedError(stateDir, next, { reviewId }))
      .catch((next) => binnedError(stateDir, next, { reviewId }));
  }
}

/** Resolves true only when the server recorded the confirmation. */
export async function confirmFeedback(
  stateDir: string,
  target: Target,
  deliveryId: string,
  stderr: Io["stderr"],
): Promise<boolean> {
  try {
    if (target.via === "direct") await confirmDirect(stateDir, deliveryId);
    else await apiRequest(stateDir, target, `/deliveries/${deliveryId}/confirm`, { method: "POST" });
    return true;
  } catch {
    stderr(confirmWarning);
    return false;
  }
}

// HTTP waits retain Node's default signal behavior. Direct waits need a chance
// to remove their row; both transports must stop confirmation during stdout flush.
async function withSignals<T>(operation: (signal: AbortSignal) => Promise<T>, interrupt = false): Promise<T> {
  const controller = new AbortController();
  const interrupted = Promise.withResolvers<never>();
  const cancel = (code: number) => {
    controller.abort(new CliSignalExit(code));
    if (interrupt) interrupted.reject(controller.signal.reason);
  };
  const int = () => cancel(130);
  const term = () => cancel(143);
  process.on("SIGINT", int);
  process.on("SIGTERM", term);
  try {
    const pending = operation(controller.signal);
    const result = await (interrupt ? Promise.race([pending, interrupted.promise]) : pending);
    controller.signal.throwIfAborted();
    return result;
  } catch (error) {
    controller.signal.throwIfAborted();
    throw error;
  } finally {
    process.off("SIGINT", int);
    process.off("SIGTERM", term);
  }
}

export async function deliverFeedback(
  stateDir: string,
  target: Target,
  result: WaitResult,
  io: Io,
  signal?: AbortSignal,
  saveFolder?: CheckedFolder,
): Promise<boolean> {
  signal?.throwIfAborted();
  const canConfirm = await withSignals(async (saveSignal) => {
    const saved = saveFolder ? await saveFeedback(saveFolder, jsonLine(result), saveSignal) : undefined;
    try {
      saveSignal.throwIfAborted();
      if (saved && saveFolder) await verifySavedFeedback(saveFolder, saved);
      await withSignals(async (flushSignal) => {
        await printJson(io, result);
        flushSignal.throwIfAborted();
      }, true);
      saveSignal.throwIfAborted();
    } catch (error) {
      if (saved && saveFolder && !(error instanceof CliSignalExit))
        await cleanupFeedback(saveFolder, saved.path, saved.identity);
      throw error;
    }
    if (saved && saveFolder) {
      try {
        await verifySavedFeedback(saveFolder, saved);
      } catch {
        if (result.kind !== "pending") io.stderr(confirmWarning);
        return false;
      }
    }
    return true;
  });
  signal?.throwIfAborted();
  if (canConfirm && result.kind !== "pending") return confirmFeedback(stateDir, target, result.deliveryId, io.stderr);
  return false;
}

export function parseFeedbackArgs(command: "wait" | "feedback", args: string[]) {
  const usage = () =>
    new CliUsageError(
      command === "wait"
        ? "Usage: emend wait <review> [--timeout <seconds>] [--save <folder>]."
        : "Usage: emend feedback <review> [--save <folder>].",
    );
  const review = ReviewId.safeParse(args[0]);
  if (!review.success) throw usage();
  const options = new Map<string, string>();
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (
      !flag ||
      (flag !== "--save" && !(command === "wait" && flag === "--timeout")) ||
      !value ||
      value.includes("\0") ||
      value.startsWith("--") ||
      options.has(flag)
    )
      throw usage();
    options.set(flag, value);
  }
  const seconds = options.get("--timeout");
  if (seconds !== undefined && !/^\d+$/.test(seconds)) throw usage();
  const timeout = seconds === undefined ? 540 : Number(seconds);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 86400)
    throw new CliUsageError("Timeout must be an integer from 1 to 86400.");
  return { reviewId: review.data, timeout, saveFolder: options.get("--save") };
}

export async function waitCommand(stateDir: string, args: string[], io: Io) {
  const { reviewId, timeout, saveFolder } = parseFeedbackArgs("wait", args);
  const folder = saveFolder ? await checkSaveFolder(saveFolder, stateDir) : undefined;
  try {
    const target = await resolveTarget(stateDir);
    const result =
      target.via === "direct"
        ? await withSignals((signal) => takeFeedback(stateDir, target, reviewId, timeout, { signal }))
        : await takeFeedback(stateDir, target, reviewId, timeout);
    await deliverFeedback(stateDir, target, result, io, undefined, folder);
  } finally {
    await folder?.handle.close().catch(() => {});
  }
}
