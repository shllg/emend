import { z } from "zod";
import { LIMITS } from "./limits.ts";

export const ERROR_STATUS = {
  internal: 500,
  unauthorized: 401,
  forbidden: 403,
  bad_host: 403,
  bad_origin: 403,
  not_found: 404,
  unknown_review: 404,
  invalid_request: 400,
  invalid_target: 400,
  empty_send: 400,
  blob_mismatch: 400,
  blob_missing: 400,
  wrong_origin: 400,
  stale_revision: 409,
  comment_frozen: 409,
  unsent_comments: 409,
  review_moved: 409,
  review_in_bin: 409,
  review_closed: 409,
  invalid_state: 409,
  instance_attached: 409,
  publish_conflict: 409,
  too_large: 413,
  client_outdated: 426,
  rate_limited: 429,
} as const;

export const ErrorCode = z.enum(Object.keys(ERROR_STATUS) as (keyof typeof ERROR_STATUS)[]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorBody = z.object({
  error: z.object({ code: ErrorCode, message: z.string().max(LIMITS.errorMessageChars) }),
});
export type ErrorBody = z.infer<typeof ErrorBody>;
