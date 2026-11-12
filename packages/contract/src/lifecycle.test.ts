import { expect, test } from "vitest";
import {
  APPROVED_ACTIVE_HOURS,
  BinItem,
  BinView,
  ERROR_STATUS,
  ImportResult,
  InboxItem,
  InboxList,
  LIMITS,
  REVIEW_BIN_FEATURE,
  RetireRequest,
  ReviewEvent,
  ReviewEventName,
  SnoozeRequest,
  TakeRequest,
  WaitResult,
} from "./index.ts";

const id = "11111111-1111-4111-8111-111111111111";
const delivery = "66666666-6666-4666-8666-666666666666";
const item = {
  id,
  title: "Synthetic",
  origin: { id, name: "Synthetic machine" },
  repo: null,
  project: null,
  branch: null,
  state: "open",
  newestRevision: 1,
  unsentCount: 0,
  openThreads: 0,
  agentWaiting: false,
  pendingSend: false,
  updatedAt: "2026-11-04T10:00:00.000Z",
  movedTo: null,
  list: "active",
  snoozed: false,
  snoozedUntil: null,
  activeUntil: null,
  releasedAt: null,
  pickedUpAt: null,
  kind: "review",
};

test("approvals default to 12 hours in Active", () => {
  expect(APPROVED_ACTIVE_HOURS).toBe(12);
});

test("snooze takes exactly one strict end condition", () => {
  expect(SnoozeRequest.parse({ until: "2026-11-05T09:00:00.000Z" })).toEqual({ until: "2026-11-05T09:00:00.000Z" });
  expect(SnoozeRequest.parse({ untilRevision: true })).toEqual({ untilRevision: true });
  for (const body of [
    {},
    { untilRevision: false },
    { until: "tomorrow" },
    { until: "2026-11-05T09:00:00.000Z", untilRevision: true },
    { untilRevision: true, extra: 1 },
  ])
    expect(SnoozeRequest.safeParse(body).success).toBe(false);
});

test("retire takes an optional discardUnsent flag and nothing else", () => {
  expect(RetireRequest.parse({})).toEqual({});
  expect(RetireRequest.parse({ discardUnsent: true })).toEqual({ discardUnsent: true });
  expect(RetireRequest.safeParse({ discardUnsent: "yes" }).success).toBe(false);
  expect(RetireRequest.safeParse({ other: true }).success).toBe(false);
});

test("a take announces what it can parse and announces nothing by default", () => {
  expect(TakeRequest.parse({})).toEqual({ waitSeconds: 0 });
  expect(TakeRequest.parse({ accepts: ["closed"] }).accepts).toEqual(["closed"]);
  expect(TakeRequest.safeParse({ accepts: ["other"] }).success).toBe(false);
});

test("closed carries its reason, and a retired review has no wake time", () => {
  const closed = { kind: "closed", reviewId: id, deliveryId: delivery, revision: 2 };
  expect(WaitResult.parse({ ...closed, reason: "snoozed", until: "2026-11-05T09:00:00.000Z" }).kind).toBe("closed");
  expect(WaitResult.parse({ ...closed, reason: "snoozed", until: null }).kind).toBe("closed");
  expect(WaitResult.parse({ ...closed, reason: "retired", until: null }).kind).toBe("closed");
  expect(WaitResult.safeParse({ ...closed, reason: "retired", until: "2026-11-05T09:00:00.000Z" }).success).toBe(false);
  expect(WaitResult.safeParse({ ...closed, reason: "deleted", until: null }).success).toBe(false);
  expect(WaitResult.safeParse({ ...closed, reason: "snoozed" }).success).toBe(false);
});

test("the inbox item carries its list, snooze and release fields", () => {
  expect(InboxItem.parse(item)).toEqual(item);
  const snoozed = { ...item, list: "snoozed", snoozed: true, snoozedUntil: "2026-11-05T09:00:00.000Z" };
  expect(InboxItem.parse(snoozed)).toEqual(snoozed);
  expect(InboxItem.safeParse({ ...item, list: "pinned" }).success).toBe(false);
  for (const field of ["list", "snoozed", "snoozedUntil", "activeUntil", "releasedAt"]) {
    const { [field]: _, ...rest } = item as Record<string, unknown>;
    expect(InboxItem.safeParse(rest).success).toBe(false);
  }
});

test("activeUntil is a required nullable ISO datetime", () => {
  for (const activeUntil of [null, "2026-11-05T09:00:00.000Z"])
    expect(InboxItem.parse({ ...item, activeUntil }).activeUntil).toBe(activeUntil);
  for (const activeUntil of [undefined, "tomorrow", "2026-11-05", 0])
    expect(InboxItem.safeParse({ ...item, activeUntil }).success).toBe(false);
});

test("the inbox requires a server clock as an ISO datetime", () => {
  expect(InboxList.safeParse({ items: [] }).success).toBe(false);
  for (const serverTime of [null, "tomorrow", "2026-11-04", 0])
    expect(InboxList.safeParse({ items: [], serverTime }).success).toBe(false);
  const list = { items: [], approvedActiveHours: 12, serverTime: "2026-11-04T10:00:00.000Z" };
  expect(InboxList.parse(list)).toEqual(list);
});

test("the inbox cap applies per list", () => {
  const items = Array.from({ length: LIMITS.inboxItems * 3 }, () => item);
  expect(InboxList.safeParse({ approvedActiveHours: 12, serverTime: "2026-11-04T10:00:00.000Z", items }).success).toBe(
    true,
  );
  expect(
    InboxList.safeParse({ approvedActiveHours: 12, serverTime: "2026-11-04T10:00:00.000Z", items: [...items, item] })
      .success,
  ).toBe(false);
});

test("lifecycle events carry ids and a revision only", () => {
  for (const type of ["snooze", "unsnooze", "retire", "reopen", "delete", "bin", "restore"] as const) {
    expect(ReviewEventName.options).toContain(type);
    expect(ReviewEvent.parse({ type, reviewId: id, revision: 3, body: "dropped" })).toEqual({
      type,
      reviewId: id,
      revision: 3,
    });
  }
});

test("the new refusals are 409 and an import can report a deleted review", () => {
  expect(ERROR_STATUS.review_closed).toBe(409);
  expect(ERROR_STATUS.invalid_state).toBe(409);
  expect(ImportResult.parse({ skipped: true, deleted: true })).toEqual({ skipped: true, deleted: true });
  expect(ImportResult.parse({ skipped: false })).toEqual({ skipped: false });
});

test("the bin view lists items with an ISO binnedAt and is capped", () => {
  const binned = { id, title: "Synthetic", machine: "Synthetic machine", binnedAt: "2026-11-04T10:00:00.000Z" };
  expect(BinItem.parse({ ...binned, extra: 1 })).toEqual(binned);
  expect(BinView.parse({ items: [binned], total: 1 })).toEqual({ items: [binned], total: 1 });
  expect(BinItem.safeParse({ ...binned, binnedAt: "yesterday" }).success).toBe(false);
  expect(BinView.safeParse({ items: [], total: -1 }).success).toBe(false);
  expect(
    BinView.safeParse({ items: Array.from({ length: LIMITS.binItems + 1 }, () => binned), total: 201 }).success,
  ).toBe(false);
  expect(ERROR_STATUS.review_in_bin).toBe(409);
  expect(REVIEW_BIN_FEATURE).toBe("review-bin");
});
