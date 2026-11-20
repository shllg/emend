import { InboxItem, LIMITS } from "@emend/contract";
import { expect, test } from "vitest";
import {
  adjacentInboxRow,
  inboxSections,
  inboxSequence,
  jumpRows,
  matchInboxItems,
  sectionOpen,
} from "./inbox-list.ts";

const a = { id: "11111111-1111-4111-8111-111111111111", name: "Alpha", members: 3 };
const b = { id: "22222222-2222-4222-8222-222222222222", name: "Beta", members: 0 };
const now = Date.parse("2026-11-04T12:00:00.000Z");
function item(n: number, patch: Partial<InboxItem> = {}): InboxItem {
  return InboxItem.parse({
    id: `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`,
    title: `Item ${n}`,
    origin: { id: a.id, name: "Workshop" },
    repo: null,
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
    ...patch,
  });
}
test("group sections sort by name and id between Snoozed and Done, preserving server row order", () => {
  const rows = [
    item(1),
    item(2, { list: "snoozed" }),
    item(3, { groupId: b.id }),
    item(4, { groupId: a.id }),
    item(5, { groupId: a.id }),
    item(6, { list: "done" }),
  ];
  const groups = [
    { ...b, members: 1 },
    { ...a, members: 2 },
  ];
  const sections = inboxSections(rows, now, { groups });
  expect(sections.map((s) => s.key)).toEqual(["pinned", "active", "snoozed", `group:${a.id}`, `group:${b.id}`, "done"]);
  expect(sections.map((s) => s.rows.map((r) => r.id))).toEqual([
    [],
    [rows[0]?.id],
    [rows[1]?.id],
    [rows[3]?.id, rows[4]?.id],
    [rows[2]?.id],
    [rows[5]?.id],
  ]);
  expect(sections.map((s) => s.expanded)).toEqual([true, true, false, false, false, false]);
  expect(inboxSequence(sections)).toEqual([rows[0]]);
  const expanded = inboxSections(rows, now, {
    groups,
    open: { snoozed: true, done: true, [`group:${a.id}`]: true, [`group:${b.id}`]: true },
  });
  expect(inboxSequence(expanded)).toEqual([rows[0], rows[1], rows[3], rows[4], rows[2], rows[5]]);
  expect(
    inboxSections([], now, { groups: [{ ...b, name: a.name }, a] })
      .filter((s) => s.group)
      .map((s) => s.group?.id),
  ).toEqual([a.id, b.id]);
});
test("Active starts open, can fold, and expands for a filter without changing its fold state", () => {
  const rows = [item(1), item(2)];
  const open = { active: false };
  expect(inboxSections(rows, now)[1]).toMatchObject({ expanded: true, rows });
  expect(inboxSections(rows, now, { open })[1]).toMatchObject({ expanded: false, rows });
  expect(inboxSections(rows, now, { open, filter: "Item 2" })[1]).toMatchObject({
    expanded: true,
    rows: [rows[1]],
  });
  expect(inboxSections(rows, now, { open })[1]?.expanded).toBe(false);
});
test("the inbox sequence skips folded Active rows and keeps the other open sections in order", () => {
  const rows = [item(1), item(2, { list: "snoozed" }), item(3, { groupId: a.id }), item(4, { list: "done" })];
  const options = { groups: [a], open: { active: false, snoozed: true, [`group:${a.id}`]: true, done: true } };
  const sections = inboxSections(rows, now, options);
  expect(inboxSequence(sections)).toEqual(rows.slice(1));
  expect(jumpRows(sections, 10)).toEqual([
    { key: "snoozed", row: rows[1] },
    { key: `group:${a.id}`, row: rows[2] },
    { key: "done", row: rows[3] },
  ]);
  expect(inboxSequence(inboxSections(rows, now, { ...options, filter: "Item" }))).toEqual(rows);
});
test("membership wins over approved, retired and snoozed states, even after the approval window", () => {
  const rows = [
    item(1, { groupId: a.id, state: "approved", activeUntil: "2026-11-04T11:00:00.000Z" }),
    item(2, { groupId: a.id, state: "settled", list: "done" }),
    item(3, { groupId: a.id, snoozed: true, list: "snoozed" }),
  ];
  const sections = inboxSections(rows, now, { groups: [a, b] });
  expect(sections.find((s) => s.group?.id === a.id)?.rows).toEqual(rows);
  expect(sections.filter((s) => !s.group).flatMap((s) => s.rows)).toEqual([]);
  expect(sections[1]?.nothingActive).toBe(true);
  expect(sections.find((s) => s.group?.id === b.id)?.empty).toBe(true);
  expect(sections.find((s) => s.group?.id === a.id)?.empty).toBe(false);
});
test("an unknown group id behaves as ungrouped", () => {
  const row = item(1, { groupId: a.id });
  expect(inboxSections([row], now)[1]).toMatchObject({ rows: [row], nothingActive: false });
});
test("a group with members beyond the loaded rows is not empty", () => {
  const sections = inboxSections([], now, { groups: [a, b] });
  expect(sections.find((section) => section.group?.id === a.id)).toMatchObject({ rows: [], count: 3, empty: false });
  expect(sections.find((section) => section.group?.id === b.id)).toMatchObject({ rows: [], count: 0, empty: true });
});
test.each([
  [{}, 3],
  [{ filter: "Item" }, 1],
  [{ kind: "review" }, 1],
  [{ machine: a.id }, 1],
  [{ project: "One" }, 1],
] as const)("section counts use total group membership unless narrowed by %j", (filters, count) => {
  const rows = [
    item(1, { groupId: a.id, project: "One" }),
    item(2),
    item(3, { list: "snoozed" }),
    item(4, { list: "done" }),
  ];
  const sections = inboxSections(rows, now, { groups: [a], ...filters });
  expect(sections.find((section) => section.group?.id === a.id)).toMatchObject({ rows: [rows[0]], count });
  for (const section of sections.filter((section) => !section.group)) expect(section.count).toBe(section.rows.length);
});
test("only non-empty groups without loaded members are unloaded, regardless of filters", () => {
  const capped = { id: "44444444-4444-4444-8444-444444444444", name: "Gamma", members: 1 };
  const rows = [item(1, { groupId: a.id })];
  for (const filter of ["", "missing"]) {
    const sections = inboxSections(rows, now, { groups: [a, b, capped], filter });
    expect(sections.find((section) => section.group?.id === capped.id)).toMatchObject({
      rows: [],
      unloaded: true,
    });
    expect(sections.find((section) => section.group?.id === b.id)).toMatchObject({
      rows: [],
      empty: true,
      unloaded: false,
    });
    expect(sections.find((section) => section.group?.id === a.id)).toMatchObject({
      rows: filter ? [] : rows,
      unloaded: false,
    });
    for (const section of sections.filter((section) => !section.group)) expect(section.unloaded).toBe(false);
  }
});
test("all filters apply within groups; search expands them, and filtered-out members do not mean empty", () => {
  const rows = [
    item(1, { groupId: a.id, project: "One" }),
    item(2, { groupId: a.id, kind: "publish", project: "Two", origin: { id: b.id, name: "Machine B" } }),
    item(3, { groupId: a.id, kind: "publish", agentWaiting: true }),
  ];
  for (const [filter, expected] of [
    [{ filter: "Item 2" }, [rows[1]]],
    [{ kind: "publish" as const }, [rows[1], rows[2]]],
    [{ kind: "review" as const }, [rows[0], rows[2]]],
    [{ machine: b.id }, [rows[1]]],
    [{ project: "One" }, [rows[0]]],
    [{ filter: "missing" }, []],
  ] as const) {
    const section = inboxSections(rows, now, { groups: [a], ...filter }).find((s) => s.group);
    expect(section?.rows).toEqual(expected);
    expect(section?.count).toBe(expected.length);
    expect(section?.empty).toBe(false);
    if ("filter" in filter) expect(section?.expanded).toBe(true);
  }
});

test.each([{}, { open: { active: true } }, { open: { active: false }, filter: "Item" }] as const)(
  "Active jumps take the first ten openable rows in display order with %j",
  (options) => {
    const rows = Array.from({ length: 12 }, (_, i) => item(i + 1));
    expect(jumpRows(inboxSections(rows, now, options), 10)).toEqual(
      rows.slice(0, 10).map((row) => ({ key: "active", row })),
    );
    rows[1] = item(2, { movedTo: "https://example.com/review" });
    expect(jumpRows(inboxSections(rows, now, options), 10)).toEqual(
      [rows[0], ...rows.slice(2, 11)].map((row) => ({ key: "active", row })),
    );
  },
);

test("jumps continue through open Snoozed, groups and Done, including expired rows", () => {
  const rows = [
    item(1),
    item(2, { list: "snoozed", snoozed: true }),
    item(3, { groupId: a.id }),
    item(4, { list: "done" }),
    item(5, { activeUntil: "2026-11-04T11:00:00.000Z" }),
  ];
  expect(
    jumpRows(
      inboxSections(rows, now, {
        groups: [a],
        open: { snoozed: true, done: true, [`group:${a.id}`]: true },
      }),
      10,
    ),
  ).toEqual([
    { key: "active", row: rows[0] },
    { key: "snoozed", row: rows[1] },
    { key: `group:${a.id}`, row: rows[2] },
    { key: "done", row: rows[3] },
    { key: "done", row: rows[4] },
  ]);
  expect(jumpRows(inboxSections(rows.slice(1), now, { groups: [a] }), 10)).toEqual([]);
});

test("Active jumps count only rows shown by Kind, text, machine and project filters", () => {
  const rows = [
    item(1),
    item(2, { kind: "publish", project: "One" }),
    item(3, { kind: "publish", origin: { id: b.id, name: "Machine B" } }),
  ];
  for (const [filters, expected] of [
    [{ kind: "publish" }, rows.slice(1)],
    [{ filter: "Item 3" }, [rows[2]]],
    [{ kind: "publish", filter: "Item 1" }, []],
    [{ machine: b.id }, [rows[2]]],
    [{ project: "One" }, [rows[1]]],
  ] as const)
    expect(jumpRows(inboxSections(rows, now, filters), 10)).toEqual(expected.map((row) => ({ key: "active", row })));
});

test.each([
  ["title", { title: "Needle" }],
  ["branch", { branch: "emend-needle" }],
  ["project", { project: "Needle" }],
  ["machine", { origin: { id: b.id, name: "Needle" } }],
] as const)("palette matches the %s", (_field, patch) => {
  const match = item(1, patch);
  expect(matchInboxItems([item(2), match], now, "needle").map(({ item }) => item)).toEqual([match]);
});

test("palette finds a title's initials and words in different fields", () => {
  const match = item(1, { title: "Performance Harness Results", branch: "emend-175-harness" });
  expect(matchInboxItems([match], now, "phr").map(({ item }) => item)).toEqual([match]);
  expect(matchInboxItems([match], now, "175 results workshop").map(({ item }) => item)).toEqual([match]);
});

test("palette ranks the branch carrying an issue number above separated digits and rejects reversed digits", () => {
  const match = item(1, { branch: "emend-175-a-perf-harness" });
  const apart = item(2, { title: "1 thing, 7 tasks, 5 results" });
  const reversed = item(3, { branch: "emend-157-foo" });
  expect(matchInboxItems([apart, reversed, match], now, "175").map(({ item }) => item)).toEqual([match, apart]);
});

test.each([
  ["175", "emend-175-a-perf-harness", "emend-1750-other"],
  ["18", "emend-18-x", "emend-184-y"],
] as const)("palette ranks issue %s above a longer number despite inbox order", (query, branch, longerBranch) => {
  const match = item(1, { branch });
  const longer = item(2, { branch: longerBranch });
  expect(matchInboxItems([longer, match], now, query).map(({ item }) => item)).toEqual([match, longer]);
});

test("palette finds an issue number at the start of a long branch", () => {
  const match = item(1, { branch: `emend-175-${"x".repeat(4000)}` });
  expect(matchInboxItems([match], now, "175").map(({ item }) => item)).toEqual([match]);
});

test("palette only searches the first title limit characters of a branch", () => {
  const outside = item(1, { branch: `${"x".repeat(LIMITS.titleChars)}needle` });
  const inside = item(2, { branch: `${"x".repeat(LIMITS.titleChars - "needle".length)}needle` });
  expect(matchInboxItems([outside, inside], now, "needle").map(({ item }) => item)).toEqual([inside]);
});

test("palette ranks every active match above Done even when Done scores higher", () => {
  const done = item(1, { title: "Harness", list: "done" });
  const active = item(2, { title: "Performance harness" });
  const matches = matchInboxItems([done, active], now, "harness");
  expect(matches.map(({ item, done }) => [item, done])).toEqual([
    [active, false],
    [done, true],
  ]);
  expect(matches[1]?.score).toBeGreaterThan(matches[0]?.score as number);
});

test("palette uses section membership for Done and preserves the inbox order on ties", () => {
  const active = item(1);
  const expired = item(2, { activeUntil: "2026-11-04T11:00:00.000Z" });
  const snoozed = item(3, { snoozed: true, list: "snoozed" });
  const grouped = item(4, { groupId: a.id, list: "done", activeUntil: expired.activeUntil });
  const done = item(5, { list: "done", updatedAt: "2026-11-04T11:00:00.000Z" });
  const matches = matchInboxItems([done, grouped, expired, snoozed, active], now, "item", [a]);
  expect(matches.map(({ item, done }) => [item, done])).toEqual([
    [active, false],
    [snoozed, false],
    [grouped, false],
    [done, true],
    [expired, true],
  ]);
});

test("palette keeps moved matches and returns nothing for blank queries", () => {
  const moved = item(1, { movedTo: "https://example.com/review" });
  expect(matchInboxItems([moved], now, "item").map(({ item }) => item)).toEqual([moved]);
  expect(matchInboxItems([moved], now, "")).toEqual([]);
  expect(matchInboxItems([moved], now, " \t\n")).toEqual([]);
});

const pinnedAt = "2026-11-04T09:00:00.000Z";
test("Pinned comes first, ordered by oldest pin then id, and takes pinned Active items out of Active", () => {
  const oldest = item(3, { pinnedAt: "2026-11-03T09:00:00.000Z" });
  const first = item(1, { pinnedAt });
  const second = item(2, { pinnedAt });
  const active = item(4);
  const rows = [second, active, first, oldest];
  const sections = inboxSections(rows, now);
  expect(sections[0]).toMatchObject({
    key: "pinned",
    list: "pinned",
    title: "Pinned",
    count: 3,
    expanded: true,
    rows: [oldest, first, second],
  });
  expect(sections[1]).toMatchObject({ rows: [active], nothingActive: false });
  expect(inboxSections([first], now)[1]).toMatchObject({ rows: [], nothingActive: true });
  expect(rows).toEqual([second, active, first, oldest]);
});

test("pinned Snoozed, grouped, Done and expired items stay in their own sections too", () => {
  const snoozed = item(1, { pinnedAt, list: "snoozed", snoozed: true });
  const grouped = item(2, { pinnedAt, groupId: a.id });
  const done = item(3, { pinnedAt, list: "done", state: "settled" });
  const expired = item(4, { pinnedAt, state: "approved", activeUntil: "2026-11-04T11:00:00.000Z" });
  const rows = [snoozed, grouped, done, expired];
  const sections = inboxSections(rows, now, { groups: [a] });
  expect(sections[0]?.rows).toEqual(rows);
  expect(sections.find((s) => s.list === "snoozed")?.rows).toEqual([snoozed]);
  expect(sections.find((s) => s.group?.id === a.id)?.rows).toEqual([grouped]);
  expect(sections.find((s) => s.list === "done")?.rows).toEqual([done, expired]);
  expect(sections[1]).toMatchObject({ rows: [], nothingActive: true });
});

test("Pinned is empty without pins, starts open and uses the same fold map as Active", () => {
  expect(inboxSections([item(1)], now)[0]).toMatchObject({ rows: [], count: 0 });
  expect(sectionOpen({}, "pinned")).toBe(true);
  expect(sectionOpen({ pinned: false }, "pinned")).toBe(false);
  const rows = [item(1, { pinnedAt })];
  const open = { pinned: false };
  expect(inboxSections(rows, now)[0]).toMatchObject({ expanded: true, rows });
  expect(inboxSections(rows, now, { open })[0]).toMatchObject({ expanded: false, rows });
  expect(inboxSections(rows, now, { open, filter: "Item" })[0]?.expanded).toBe(true);
  expect(inboxSections(rows, now, { open })[0]?.expanded).toBe(false);
});

test("Kind, search, machine and project filters limit Pinned rows and their count", () => {
  const rows = [
    item(1, { pinnedAt, project: "One" }),
    item(2, { pinnedAt, kind: "publish", project: "Two", origin: { id: b.id, name: "Machine B" } }),
    item(3, { pinnedAt, kind: "publish", agentWaiting: true }),
    item(4),
  ];
  for (const [filters, expected] of [
    [{ kind: "publish" }, [rows[1], rows[2]]],
    [{ kind: "review" }, [rows[0], rows[2]]],
    [{ filter: "Item 2" }, [rows[1]]],
    [{ kind: "publish", filter: "Item 1" }, []],
    [{ machine: b.id }, [rows[1]]],
    [{ project: "One" }, [rows[0]]],
  ] as const)
    expect(inboxSections(rows, now, filters)[0]).toMatchObject({ rows: expected, count: expected.length });
});

test("jumps take Pinned then Active, skip moved rows and folded sections, and stop at ten", () => {
  const active = Array.from({ length: 10 }, (_, i) => item(i + 1));
  const pinned = item(20, { pinnedAt, list: "done" });
  const movedPin = item(21, { pinnedAt, movedTo: "https://example.com/review" });
  const movedActive = item(22, { movedTo: "https://example.com/review" });
  const rows = [movedActive, ...active, movedPin, pinned];
  expect(jumpRows(inboxSections(rows, now), 10)).toEqual([
    { key: "pinned", row: pinned },
    ...active.slice(0, 9).map((row) => ({ key: "active", row })),
  ]);
  expect(jumpRows(inboxSections(rows, now, { open: { pinned: false } }), 10)).toEqual(
    active.map((row) => ({ key: "active", row })),
  );
  expect(jumpRows(inboxSections(rows, now, { open: { active: false } }), 10)).toEqual([{ key: "pinned", row: pinned }]);
  expect(jumpRows(inboxSections(rows, now, { open: { pinned: false, active: false, done: true } }), 10)).toEqual([
    { key: "done", row: pinned },
  ]);
  const pins = active.map((row) => ({ ...row, pinnedAt }));
  expect(jumpRows(inboxSections([...pins, item(30)], now), 10)).toEqual(pins.map((row) => ({ key: "pinned", row })));
});

test.each([0, 1, 3, 10])("jumps take %s entries from the same deduplicated order as j/k", (count) => {
  const active = item(1);
  const pinned = item(2, { pinnedAt, list: "done" });
  const done = item(3, { list: "done" });
  const sections = inboxSections([active, done, pinned], now, { open: { done: true } });
  expect(jumpRows(sections, count)).toEqual(
    [
      { key: "pinned", row: pinned },
      { key: "active", row: active },
      { key: "done", row: done },
    ].slice(0, count),
  );
  expect(jumpRows(sections, count).map(({ row }) => row)).toEqual(inboxSequence(sections).slice(0, count));
});

test("the sequence visits a pinned Done item once at its first expanded section", () => {
  const active = item(1);
  const pinned = item(2, { pinnedAt, list: "done" });
  const done = item(3, { list: "done" });
  const rows = [active, done, pinned];
  expect(inboxSequence(inboxSections(rows, now, { open: { done: true } }))).toEqual([pinned, active, done]);
  expect(inboxSequence(inboxSections(rows, now, { open: { done: true, pinned: false } }))).toEqual([
    active,
    pinned,
    done,
  ]);
});

test("row navigation skips duplicate links in both directions", () => {
  const ids = ["pinned", "active", "pinned", "done", "active"];
  expect(adjacentInboxRow(ids, 0, 1)).toBe(1);
  expect(adjacentInboxRow(ids, 1, 1)).toBe(3);
  expect(adjacentInboxRow(ids, 3, -1)).toBe(1);
  expect(adjacentInboxRow(ids, 1, -1)).toBe(0);
});

test("row navigation starts from a duplicate link's own position", () => {
  const ids = ["pinned", "active", "pinned", "done"];
  expect(adjacentInboxRow(ids, 2, 1)).toBe(3);
  expect(adjacentInboxRow(ids, 2, -1)).toBe(1);
});

test("row navigation without focus starts at the first or last canonical link", () => {
  const ids = ["pinned", "active", "pinned", "done", "active"];
  expect(adjacentInboxRow(ids, -1, 1)).toBe(0);
  expect(adjacentInboxRow(ids, -1, -1)).toBe(3);
});

test("row navigation stops at the ends and has no target without links", () => {
  const ids = ["pinned", "active", "pinned", "done", "active"];
  expect(adjacentInboxRow(ids, 0, -1)).toBe(-1);
  expect(adjacentInboxRow(ids, 3, 1)).toBe(-1);
  expect(adjacentInboxRow(ids, 4, 1)).toBe(-1);
  expect(adjacentInboxRow([], -1, 1)).toBe(-1);
  expect(adjacentInboxRow([], -1, -1)).toBe(-1);
});

test("palette matches include a pinned Done item once at its first place", () => {
  const active = item(1, { title: "Needle" });
  const pinned = item(2, { title: "Needle", pinnedAt, list: "done" });
  const done = item(3, { title: "Needle", list: "done" });
  expect(matchInboxItems([active, done, pinned], now, "Needle").map(({ item, done }) => [item, done])).toEqual([
    [pinned, false],
    [active, false],
    [done, true],
  ]);
});
