import { expect, test } from "vitest";
import {
  InboxItem,
  LIMITS,
  REVIEW_PINS_FEATURE,
  ReviewEvent,
  ReviewEventName,
  ReviewPinRequest,
  ReviewView,
  SHORTCUT_DEFAULTS,
  ShortcutCommand,
} from "./index.ts";

const id = "11111111-1111-4111-8111-111111111111";

test("pin requests require a boolean and refuse unknown fields", () => {
  for (const pinned of [true, false]) expect(ReviewPinRequest.parse({ pinned })).toEqual({ pinned });
  for (const body of [{}, { pinned: "true" }, { pinned: 1 }, { pinned: null }, { pinned: true, ownerId: id }])
    expect(ReviewPinRequest.safeParse(body).success).toBe(false);
  expect(REVIEW_PINS_FEATURE).toBe("review-pins");
  expect(LIMITS.pins).toBe(50);
});

test("read views default old responses to no pin and validate pin times", () => {
  for (const schema of [InboxItem, ReviewView]) {
    expect(schema.shape.pinnedAt.parse(undefined)).toBeNull();
    for (const at of [null, "2026-01-01T00:00:00.000Z"]) expect(schema.shape.pinnedAt.parse(at)).toBe(at);
    for (const at of ["yesterday", "2026-01-01", 0, true])
      expect(schema.shape.pinnedAt.safeParse(at).success).toBe(false);
  }
});

test("pins events require a review UUID and strip content and revision", () => {
  expect(ReviewEventName.options).toContain("pins");
  expect(ReviewEvent.parse({ type: "pins", reviewId: id, revision: 1, body: "dropped" })).toEqual({
    type: "pins",
    reviewId: id,
  });
  for (const reviewId of [undefined, "bad"])
    expect(ReviewEvent.safeParse({ type: "pins", reviewId }).success).toBe(false);
});

test("pin shortcut defaults to shift+p immediately after snooze", () => {
  expect(SHORTCUT_DEFAULTS["review.pin"]).toBe("shift+p");
  expect(ShortcutCommand.options[ShortcutCommand.options.indexOf("review.snooze") + 1]).toBe("review.pin");
  expect(Object.keys(SHORTCUT_DEFAULTS)).toEqual(ShortcutCommand.options);
});
