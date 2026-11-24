import { CLIENT_HEADER, LEGACY_CLIENT_HEADER, MIN_CLIENT_VERSION } from "@recense/contract";
import type { Context } from "hono";
import { ApiError } from "./errors.ts";
export function clientVersion(c: Context) {
  const header = c.req.header(CLIENT_HEADER) ?? c.req.header(LEGACY_CLIENT_HEADER);
  if (header === undefined) return;
  if (header.length > 68 || !/^cli\/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(header))
    throw new ApiError("invalid_request");
  const actual = header.slice(4).split(".").map(BigInt);
  const minimum = MIN_CLIENT_VERSION.split(".").map(BigInt);
  for (let i = 0; i < 3; i++) {
    const a = actual[i] ?? 0n;
    const b = minimum[i] ?? 0n;
    if (a < b) throw new ApiError("client_outdated");
    if (a > b) break;
  }
}
