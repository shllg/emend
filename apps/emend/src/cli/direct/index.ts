import { join } from "node:path";
import {
  type AgentReviewQuery,
  LIMITS,
  MAX_TAKE_WAIT_SECONDS,
  PublishRequest,
  ReplyCreated,
  ReplyRequest,
  SCOPES_BY_KIND,
  type WaitResult,
} from "@emend/contract";
import { listAgentReviews } from "../../db/repo/agent-reviews.ts";
import { replyToComment } from "../../db/repo/replies.ts";
import { beginWait, endWait, renewWait } from "../../db/repo/waiters.ts";
import type { Principal } from "../../server/auth/principal.ts";
import { ApiError } from "../../server/http/errors.ts";
import { confirmDelivery, takeDelivery } from "../../server/mailbox/take.ts";
import { ingest } from "../../server/publish/ingest.ts";
import { initializeServerState } from "../../server/state.ts";
import { StateFolderWriteError, stateAccessError } from "../../state/files.ts";
import { CliApiError } from "../http.ts";
import { pause } from "../pause.ts";
import { readRegular } from "../publish/read.ts";
import type { resolvePublish } from "../publish/resolve.ts";
import { readBlob } from "../publish/upload.ts";

type State = Awaited<ReturnType<typeof initializeServerState>>;
function localPrincipal(state: State): Principal {
  return {
    ownerId: state.ownerId,
    instanceId: state.instance.id,
    kind: "agent",
    // Direct access is local setup, never bearer authentication.
    tokenId: "",
    scopes: [...SCOPES_BY_KIND.agent],
  };
}

async function withState<T>(stateDir: string, operation: (state: State, principal: Principal) => Promise<T>) {
  try {
    return await operateWithState(stateDir, operation);
  } catch (error) {
    throw stateAccessError(stateDir, error);
  }
}

async function operateWithState<T>(stateDir: string, operation: (state: State, principal: Principal) => Promise<T>) {
  const state = await initializeServerState(stateDir, { tokens: false });
  try {
    // A separate writer connection may hold the WAL lock while this process is
    // also serving HTTP or another MCP call. Wait for that lock off the event loop.
    const db: State["db"] = { ...state.db, transaction: (fn) => state.db.transaction(fn, { offThread: true }) };
    return await operation({ ...state, db }, localPrincipal(state));
  } catch (error) {
    if (error instanceof ApiError) throw new CliApiError(error.code, error.message);
    throw error;
  } finally {
    await state.db.close();
  }
}

async function savedBaseUrl(stateDir: string): Promise<string> {
  try {
    const record: unknown = JSON.parse(
      (await readRegular(join(stateDir, "server-url.json"), LIMITS.publicJsonBytes)).toString(),
    );
    if (record && typeof record === "object" && "baseUrl" in record && typeof record.baseUrl === "string") {
      const value = record.baseUrl;
      // Reject repairs by URL(), including whitespace, dot paths and backslashes.
      if (/^https?:\/\/[^/?#\\\s]+\/?$/.test(value)) {
        const url = new URL(value);
        if (!url.username && !url.password && !value.includes("@")) return url.origin;
      }
    }
  } catch (error) {
    const mapped = stateAccessError(stateDir, error);
    if (mapped instanceof StateFolderWriteError) throw mapped;
    // Old state directories and malformed records use the default local origin.
  }
  return "http://127.0.0.1:3636";
}

export function publishDirect(stateDir: string, collected: Awaited<ReturnType<typeof resolvePublish>>) {
  return withState(stateDir, async (state, principal) => {
    for (const [hash, source] of collected.blobs) {
      if (await state.blobs.has(principal.ownerId, hash)) continue;
      const bytes = await readBlob(hash, source);
      await state.blobs.put(principal.ownerId, bytes, "application/octet-stream", hash);
    }
    return ingest(
      principal.ownerId,
      state.instance.id,
      PublishRequest.parse(collected.forInstance(state.instance.id)),
      {
        db: state.db,
        blobs: state.blobs,
        baseUrl: await savedBaseUrl(stateDir),
      },
    );
  });
}

export function replyDirect(stateDir: string, commentId: string, input: ReplyRequest, signal?: AbortSignal) {
  signal?.throwIfAborted();
  return withState(stateDir, async (state, principal) => {
    signal?.throwIfAborted();
    return ReplyCreated.parse(
      await replyToComment(state.db, principal, commentId, ReplyRequest.parse(input), Date.now()),
    );
  });
}

export function listDirect(stateDir: string, query: AgentReviewQuery = {}) {
  return withState(stateDir, async (state, principal) =>
    listAgentReviews(state.db, principal, await savedBaseUrl(stateDir), query),
  );
}

export function takeDirect(
  stateDir: string,
  reviewId: string,
  timeoutSeconds: number,
  options: { signal?: AbortSignal; progress?: (seconds: number) => Promise<void>; maxBytes?: number } = {},
): Promise<WaitResult> {
  options.signal?.throwIfAborted();
  return withState(stateDir, async ({ db }, principal) => {
    options.signal?.throwIfAborted();
    const start = performance.now();
    const deadline = start + timeoutSeconds * 1000;
    let renewAt = start + 10000;
    let progressAt = start + MAX_TAKE_WAIT_SECONDS * 1000;
    const waiterId =
      timeoutSeconds > 0 ? await beginWait(principal.ownerId, db, principal, reviewId, Date.now()) : undefined;
    try {
      while (true) {
        options.signal?.throwIfAborted();
        if (waiterId && performance.now() >= renewAt) {
          await renewWait(principal.ownerId, db, waiterId, Date.now());
          renewAt = performance.now() + 10000;
        }
        const result = await takeDelivery(db, principal, reviewId, Date.now(), undefined, options.maxBytes, ["closed"]);
        options.signal?.throwIfAborted();
        if (result) return result;
        if (performance.now() >= deadline) break;
        await pause(Math.min(1000, deadline - performance.now()), options.signal);
        if (performance.now() >= progressAt) {
          await options.progress?.(Math.floor((performance.now() - start) / 1000));
          progressAt += MAX_TAKE_WAIT_SECONDS * 1000;
        }
      }
      return {
        kind: "pending",
        reviewId,
        waitedSeconds: timeoutSeconds === 0 ? 0 : Math.floor((performance.now() - start) / 1000),
      };
    } finally {
      if (waiterId) await endWait(principal.ownerId, db, waiterId).catch(() => {});
    }
  });
}

export function confirmDirect(stateDir: string, deliveryId: string) {
  return withState(stateDir, async ({ db }, principal) => {
    if (!(await confirmDelivery(db, principal, deliveryId, Date.now()))) throw new ApiError("not_found");
  });
}
