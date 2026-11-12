import { expect, test } from "vitest";
import { ERROR_STATUS, ErrorBody, ErrorCode } from "./index.ts";

test("maps every error code to its specified HTTP status", () => {
  const expected = {
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
  };
  expect(ERROR_STATUS).toEqual(expected);
  expect([...ErrorCode.options].sort()).toEqual(Object.keys(expected).sort());
  for (const code of ErrorCode.options) {
    expect(ErrorBody.parse({ error: { code, message: "Request refused.", stack: "private" }, extra: true })).toEqual({
      error: { code, message: "Request refused." },
    });
  }
  expect(ErrorBody.safeParse({ error: { code: "unknown", message: "No." } }).success).toBe(false);
});
