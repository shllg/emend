import type { Context } from "hono";
import { ApiError } from "./errors.ts";
export function hostGuard(c: Context, allowedHosts: readonly string[]) {
  const host = c.req.header("Host")?.toLowerCase();
  if (!host || !allowedHosts.some((allowed) => allowed.toLowerCase() === host)) throw new ApiError("bad_host");
}
