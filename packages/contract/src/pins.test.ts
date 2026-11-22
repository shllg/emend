import { expect, test } from "vitest";
import {
  InboxItem,
  LIMITS,
  placePin,
  REVIEW_PIN_ORDER_FEATURE,
  REVIEW_PINS_FEATURE,
  ReviewEvent,
  ReviewEventName,
  ReviewPinPlaceRequest,
  ReviewPinRequest,
  ReviewView,
  SHORTCUT_DEFAULTS,
  ShortcutCommand,
} from "./index.ts";

const id = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
const third = "33333333-3333-4333-8333-333333333333";

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

test("pin placement requires exactly one UUID anchor and refuses unknown fields", () => {
  for (const body of [{ before: id }, { after: id }]) expect(ReviewPinPlaceRequest.parse(body)).toEqual(body);
  for (const body of [
    {},
    { before: id, after: second },
    { before: id, extra: true },
    { after: id, extra: true },
    { before: "bad" },
    { after: "bad" },
    { before: null },
    { after: 1 },
    null,
    [],
  ])
    expect(ReviewPinPlaceRequest.safeParse(body).success).toBe(false);
  expect(REVIEW_PIN_ORDER_FEATURE).toBe("review-pin-order");
});

test("read views default omitted pin places to null and require nonnegative integers", () => {
  for (const schema of [InboxItem, ReviewView]) {
    expect(schema.shape.pinOrder.parse(undefined)).toBeNull();
    for (const position of [null, 0, 1, 50]) expect(schema.shape.pinOrder.parse(position)).toBe(position);
    for (const position of [-1, 0.5, "1", true]) expect(schema.shape.pinOrder.safeParse(position).success).toBe(false);
  }
});

test.each([
  [third, { before: id }, [third, id, second]],
  [id, { after: second }, [second, id, third]],
  [id, { after: third }, [second, third, id]],
  [third, { before: second }, [id, third, second]],
  [id, { before: second }, [id, second, third]],
  [third, { after: second }, [id, second, third]],
  [second, { before: second }, [id, second, third]],
  [second, { after: second }, [id, second, third]],
] satisfies [string, ReviewPinPlaceRequest, string[]][])(
  "placing %s at %j preserves the other pins and the input",
  (reviewId, place, expected) => {
    const order = Object.freeze([id, second, third]);
    expect(placePin(order, reviewId, place)).toEqual(expected);
    expect(order).toEqual([id, second, third]);
  },
);

test("placement refuses missing targets and anchors, including a missing self anchor", () => {
  expect(placePin([], id, { before: id })).toBeNull();
  expect(placePin([id, second], third, { before: id })).toBeNull();
  expect(placePin([id, second], id, { before: third })).toBeNull();
  expect(placePin([id, second], id, { after: third })).toBeNull();
  expect(placePin([id], id, { after: id })).toEqual([id]);
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
