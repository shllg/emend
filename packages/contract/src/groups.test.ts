import { expect, test } from "vitest";
import {
  GroupName,
  GroupRequest,
  InboxGroup,
  InboxItem,
  InboxList,
  InboxListGroup,
  LIMITS,
  REVIEW_GROUPS_FEATURE,
  ReviewEvent,
  ReviewEventName,
  ReviewGroupRequest,
  ReviewList,
  ReviewView,
} from "./index.ts";

const id = "11111111-1111-4111-8111-111111111111";
test("group names trim spaces, bound length and preserve plain Unicode and hostile-looking text", () => {
  expect(GroupName.parse("  Project A  ")).toBe("Project A");
  for (const name of ["x".repeat(80), "مشروع", "👩\u200d💻", "<img src=x onerror=alert(1)>"])
    expect(GroupName.parse(` ${name} `)).toBe(name);
  expect(InboxGroup.parse({ id, name: " Project A " })).toEqual({ id, name: "Project A" });
  expect(REVIEW_GROUPS_FEATURE).toBe("review-groups");
});
test.each([
  "",
  "   ",
  "x".repeat(81),
  "a\0b",
  "a\u0085b",
  "a\u007fb",
  "a\nb",
  "a\tb",
  "a\u2028b",
  "a\u2029b",
  "\nname",
  "name\u2028",
  "a\u202eb",
  "a\u2067b",
])("refuses invalid group name %j", (name) => {
  expect(GroupName.safeParse(name).success).toBe(false);
});
test("create, rename and membership bodies are strict", () => {
  expect(GroupRequest.parse({ name: " A " })).toEqual({ name: "A" });
  expect(ReviewGroupRequest.parse({ groupId: id })).toEqual({ groupId: id });
  expect(ReviewGroupRequest.parse({ groupId: null })).toEqual({ groupId: null });
  for (const body of [{}, { name: 1 }, { name: "A", ownerId: id }])
    expect(GroupRequest.safeParse(body).success).toBe(false);
  for (const body of [{}, { groupId: "bad" }, { groupId: null, extra: true }])
    expect(ReviewGroupRequest.safeParse(body).success).toBe(false);
});
test("read views default old responses and bound groups", () => {
  const list = { items: [], approvedActiveHours: 12, approvedActiveLimit: 5, serverTime: "2026-01-01T00:00:00.000Z" };
  expect(InboxList.parse(list).groups).toEqual([]);
  for (const schema of [InboxItem, ReviewView]) {
    expect(schema.shape.groupId.parse(undefined)).toBeNull();
    expect(schema.shape.groupId.parse(id)).toBe(id);
    expect(schema.shape.groupId.safeParse("bad").success).toBe(false);
  }
  for (const count of [LIMITS.groups, LIMITS.groups + 1])
    expect(
      InboxList.safeParse({ ...list, groups: Array.from({ length: count }, () => ({ id, name: "A", members: 0 })) })
        .success,
    ).toBe(count === LIMITS.groups);
  expect(ReviewList.options).toEqual(["active", "snoozed", "done"]);
});
test("list groups require nonnegative integer member counts without changing write responses", () => {
  for (const members of [0, 201])
    expect(InboxListGroup.parse({ id, name: "A", members })).toEqual({ id, name: "A", members });
  for (const members of [undefined, -1, 1.5, "1"])
    expect(InboxListGroup.safeParse({ id, name: "A", members }).success).toBe(false);
  expect(InboxGroup.parse({ id, name: "A", members: 1 })).toEqual({ id, name: "A" });
});
test("groups events optionally name the moved review and strip content", () => {
  expect(ReviewEventName.options).toContain("groups");
  expect(ReviewEvent.parse({ type: "groups", name: "private" })).toEqual({ type: "groups" });
  expect(ReviewEvent.parse({ type: "groups", reviewId: id })).toEqual({ type: "groups", reviewId: id });
  expect(ReviewEvent.safeParse({ type: "groups", reviewId: "bad" }).success).toBe(false);
});
