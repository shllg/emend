import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  CancelledNotificationSchema,
  ErrorCode,
  ListToolsRequestSchema,
  type RequestId,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { ReplyCreated, ReplyRequest, WaitResult } from "@recense/contract";
import { sendReply } from "../cli/commands/reply.ts";
import { confirmFeedback, takeFeedback } from "../cli/commands/wait.ts";
import { CliApiError, CliUsageError, errorLine } from "../cli/http.ts";
import { resolveTarget, type Target } from "../cli/target.ts";
import { VERSION } from "../version.ts";

const FeedbackInput = WaitResult.options[2].pick({ reviewId: true });
const WaitInput = FeedbackInput.extend({
  timeoutSeconds: WaitResult.options[2].shape.waitedSeconds.int().min(1).max(540).default(50),
});
const ReplyInput = ReplyRequest.extend({ commentId: ReplyCreated.shape.commentId });
function objectSchema(
  schema: { toJSONSchema(options: { io: "input" | "output" }): object },
  io: "input" | "output" = "output",
): Tool["inputSchema"] {
  // MCP requires type: object at the root, including for WaitResult's object union.
  return { ...schema.toJSONSchema({ io }), type: "object" };
}
const tools: Tool[] = [
  {
    name: "wait_for_review",
    description:
      "Wait for review feedback or approval. Keep timeoutSeconds below the client's own tool timeout. Call again on pending. A closed result means the reviewer retired or snoozed the review: stop waiting and tell the user.",
    inputSchema: objectSchema(WaitInput, "input"),
    outputSchema: objectSchema(WaitResult),
  },
  {
    name: "get_feedback",
    description:
      "Take available review feedback without waiting. A closed result means the reviewer retired or snoozed the review.",
    inputSchema: objectSchema(FeedbackInput, "input"),
    outputSchema: objectSchema(WaitResult),
  },
  {
    name: "reply",
    description: "Reply to a sent user comment with an outcome.",
    inputSchema: objectSchema(ReplyInput, "input"),
    outputSchema: objectSchema(ReplyCreated),
  },
];

export function createMcpServer(stateDir: string, stderr: (line: string) => void) {
  const server = new Server({ name: "recense", version: VERSION }, { capabilities: { tools: {} } });
  type Delivery = { target: Target; deliveryId: string; signal: AbortSignal; remove: () => void };
  const deliveries = new Map<RequestId, Delivery>();
  // SDK 1.32.2 ignores falsy cancellation ids. Own every request's controller so
  // cancellation also covers 0 and the empty string, without SDK private APIs.
  const requests = new Map<RequestId, AbortController>();
  server.onerror = () => stderr("recense: MCP transport failed.\n");
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const controller = requests.get(extra.requestId) ?? new AbortController();
    const signal = AbortSignal.any([extra.signal, controller.signal]);
    let feedbackReviewId: string | undefined;
    try {
      signal.throwIfAborted();
      let result: WaitResult | ReplyCreated;
      const name = request.params.name;
      if (name === "reply") {
        const input = ReplyInput.safeParse(request.params.arguments);
        if (!input.success) throw new CliUsageError("Invalid reply arguments.");
        const target = await resolveTarget(stateDir);
        result = await sendReply(stateDir, target, input.data.commentId, ReplyRequest.parse(input.data), signal);
      } else if (name === "wait_for_review" || name === "get_feedback") {
        const input = (name === "wait_for_review" ? WaitInput : FeedbackInput).safeParse(request.params.arguments);
        if (!input.success) throw new CliUsageError("Invalid feedback arguments.");
        feedbackReviewId = input.data.reviewId;
        const timeout =
          "timeoutSeconds" in input.data && typeof input.data.timeoutSeconds === "number"
            ? input.data.timeoutSeconds
            : 0;
        const target = await resolveTarget(stateDir);
        const progressToken = extra._meta?.progressToken;
        result = await takeFeedback(stateDir, target, input.data.reviewId, timeout, {
          signal,
          maxBytes: 3145728,
          progress:
            progressToken === undefined
              ? undefined
              : async (seconds) => {
                  await extra.sendNotification({
                    method: "notifications/progress",
                    params: { progressToken, progress: seconds, total: timeout },
                  });
                },
        });
        signal.throwIfAborted();
        if (result.kind !== "pending") {
          const remove = () => {
            if (deliveries.get(extra.requestId)?.signal === signal) deliveries.delete(extra.requestId);
            signal.removeEventListener("abort", remove);
          };
          deliveries.set(extra.requestId, { target, deliveryId: result.deliveryId, signal, remove });
          signal.addEventListener("abort", remove, { once: true });
        }
      } else {
        throw new CliUsageError("Unknown recense tool.");
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      if (feedbackReviewId && error instanceof CliApiError && error.code === "too_large") {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `This feedback is too large for MCP. Run \`recense feedback ${feedbackReviewId}\` in a shell to get it.`,
            },
          ],
        };
      }
      return { isError: true, content: [{ type: "text" as const, text: errorLine(error) }] };
    }
  });

  async function connect(transport: Transport) {
    let closed = false;
    const wrapped: Transport = {
      async start() {
        transport.onmessage = (message, extra) => {
          if (!("id" in message) && "method" in message && message.method === "notifications/cancelled") {
            // Consume cancellation now: the SDK defers notifications to a microtask,
            // after later messages from this same stdin chunk have been registered.
            const parsed = CancelledNotificationSchema.safeParse(message);
            if (parsed.success && parsed.data.params.requestId !== undefined)
              requests.get(parsed.data.params.requestId)?.abort();
            return;
          }
          if ("id" in message && "method" in message) {
            if (requests.has(message.id)) {
              // Bypass response cleanup: this error belongs to the refused duplicate,
              // not the original request, which must remain cancellable until it ends.
              void transport
                .send({
                  jsonrpc: "2.0",
                  id: message.id,
                  error: { code: ErrorCode.InvalidRequest, message: "Request id is already in flight." },
                })
                .catch((error) => wrapped.onerror?.(error));
              return;
            }
            // Reserve every method before the SDK schedules its handler or response.
            requests.set(message.id, new AbortController());
          }
          wrapped.onmessage?.(message, extra);
        };
        transport.onerror = (error) => wrapped.onerror?.(error);
        transport.onclose = () => {
          closed = true;
          for (const controller of requests.values()) controller.abort();
          requests.clear();
          for (const delivery of deliveries.values()) delivery.remove();
          wrapped.onclose?.();
        };
        await transport.start();
      },
      async close() {
        await transport.close();
      },
      async send(message, options) {
        const responseId = "id" in message && !("method" in message) ? message.id : undefined;
        const controller = responseId === undefined ? undefined : requests.get(responseId);
        const delivery = "id" in message && "result" in message ? deliveries.get(message.id) : undefined;
        try {
          if (controller?.signal.aborted) return;
          if (closed || delivery?.signal.aborted) throw new Error("Transport closed or request cancelled.");
          await transport.send(message, options);
          if (
            delivery &&
            !closed &&
            !delivery.signal.aborted &&
            "result" in message &&
            (message.result.structuredContent as { deliveryId?: string } | undefined)?.deliveryId ===
              delivery.deliveryId
          ) {
            await confirmFeedback(stateDir, delivery.target, delivery.deliveryId, stderr);
          }
        } finally {
          delivery?.remove();
          if (responseId !== undefined && requests.get(responseId) === controller) requests.delete(responseId);
        }
      },
    };
    await server.connect(wrapped);
  }
  return { server, connect };
}
