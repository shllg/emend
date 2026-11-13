import type { Context } from "hono";
import { sessionCookie } from "../auth/sessions.ts";
import { ApiError } from "./errors.ts";
export function originGuard(c: Context, appOrigins: readonly string[]) {
  if (c.req.method === "GET" || c.req.method === "HEAD") return;
  const origin = c.req.header("Origin");
  const hasSession = !c.req.path.startsWith("/content/") && sessionCookie(c) !== undefined;
  if (origin !== undefined) {
    let originHost: string;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      throw new ApiError("bad_origin");
    }
    if (!appOrigins.includes(origin) || originHost !== c.req.header("Host")?.toLowerCase())
      throw new ApiError("bad_origin");
  } else if (hasSession) throw new ApiError("bad_origin");
}
