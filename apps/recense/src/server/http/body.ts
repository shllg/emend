import type { Context } from "hono";
import type { AppEnv } from "../auth/principal.ts";
import { ApiError } from "./errors.ts";

export function checkContentLength(c: Context, limit: number) {
  const length = c.req.header("Content-Length");
  if (length !== undefined && Number(length) > limit) throw new ApiError("too_large");
}
export async function limitJsonBody(c: Context<AppEnv>, limit: number) {
  const reader = c.req.raw.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
          void reader.cancel().catch(() => {});
          throw new ApiError("too_large");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  c.set("jsonBody", Buffer.concat(chunks).toString("utf8"));
}
export function requireJson(c: Context) {
  if (c.req.header("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json")
    throw new ApiError("invalid_request");
}
export function parseBody<T>(
  c: Context<AppEnv>,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
): T {
  requireJson(c);
  let value: unknown;
  try {
    value = JSON.parse(c.get("jsonBody"));
  } catch {
    throw new ApiError("invalid_request");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError("invalid_request");
  return parsed.data;
}
