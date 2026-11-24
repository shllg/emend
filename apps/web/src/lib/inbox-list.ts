import { type InboxItem, type InboxListGroup, LIMITS } from "@recense/contract";
import { fuzzyMatchFields } from "./fuzzy-match.ts";

// Agent-written fields may be far longer; an issue number and a name sit at the start.
const paletteFieldChars = LIMITS.titleChars;

export type InboxKind = "" | "review" | "publish";
export const inboxKindKey = "recense:inbox-kind";
export function readInboxKind(): InboxKind {
  try {
    const stored = localStorage.getItem(inboxKindKey);
    return stored === "review" || stored === "publish" ? stored : "";
  } catch {
    return "";
  }
}
function effectiveList(review: InboxItem, now: number) {
  return review.activeUntil !== null && new Date(review.activeUntil).getTime() <= now ? "done" : review.list;
}

/** Pinned and Active start open; every other section starts folded. */
export function sectionOpen(open: Readonly<Record<string, boolean>>, key: string) {
  return open[key] ?? (key === "pinned" || key === "active");
}

/** One display order for rendered sections and keyboard navigation, including collapsed sections. */
export function inboxSections(
  items: InboxItem[],
  now: number,
  {
    kind = "",
    filter = "",
    machine = "",
    project = "",
    open = {},
    groups = [],
  }: {
    kind?: InboxKind;
    filter?: string;
    machine?: string;
    project?: string;
    open?: Record<string, boolean>;
    groups?: InboxListGroup[];
  } = {},
) {
  const groupIds = new Set(groups.map((group) => group.id));
  const sectionKey = (review: InboxItem) =>
    review.groupId && groupIds.has(review.groupId) ? `group:${review.groupId}` : effectiveList(review, now);
  const lists: {
    key: string;
    list: "pinned" | "active" | "snoozed" | "group" | "done";
    title: string;
    group?: InboxListGroup;
  }[] = [
    { key: "pinned", list: "pinned", title: "Pinned" },
    { key: "active", list: "active", title: "Active" },
    { key: "snoozed", list: "snoozed", title: "Snoozed" },
    ...[...groups]
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
      .map((group) => ({
        key: `group:${group.id}`,
        list: "group" as const,
        title: group.name,
        group,
      })),
    { key: "done", list: "done", title: "Done" },
  ];
  const needle = filter.toLocaleLowerCase();
  const filtered = items.filter(
    (review) =>
      (!machine || review.origin.id === machine) &&
      (!project || review.project === project) &&
      // Never hide an agent-waiting item under Reviews.
      (!kind || review.kind === kind || (kind === "review" && review.agentWaiting)) &&
      [review.title, review.branch, review.origin.name, review.project].some((value) =>
        value?.toLocaleLowerCase().includes(needle),
      ),
  );
  return lists.map(({ key, list, title, group }) => {
    const rows = filtered.filter((review) =>
      list === "pinned"
        ? review.pinnedAt !== null
        : sectionKey(review) === key && (list !== "active" || review.pinnedAt === null),
    );
    if (list === "pinned")
      rows.sort(
        (a, b) =>
          (a.pinOrder ?? 0) - (b.pinOrder ?? 0) ||
          Date.parse(a.pinnedAt ?? "") - Date.parse(b.pinnedAt ?? "") ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
    if (list === "done")
      rows.sort(
        (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
    return {
      key,
      list,
      title,
      group,
      count: group && !kind && !filter && !machine && !project ? group.members : rows.length,
      empty: group?.members === 0,
      unloaded: group !== undefined && group.members > 0 && !items.some((review) => review.groupId === group.id),
      rows,
      nothingActive:
        list === "active" && !items.some((review) => review.pinnedAt === null && sectionKey(review) === "active"),
      expanded: sectionOpen(open, key) || needle !== "",
    };
  });
}

function openInboxRows(sections: ReturnType<typeof inboxSections>): { key: string; row: InboxItem }[] {
  const seen = new Set<string>();
  return sections.flatMap(({ key, expanded, rows }) =>
    expanded
      ? rows.flatMap((row) => {
          if (row.movedTo || seen.has(row.id)) return [];
          seen.add(row.id);
          return [{ key, row }];
        })
      : [],
  );
}

export function jumpRows(sections: ReturnType<typeof inboxSections>, count: number) {
  return openInboxRows(sections).slice(0, count);
}

/** Palette matches keep the inbox's display order on ties, with Done after every other section. */
export function matchInboxItems(items: InboxItem[], now: number, query: string, groups: InboxListGroup[] = []) {
  if (!query.trim()) return [];
  const seen = new Set<string>();
  return inboxSections(items, now, { groups })
    .flatMap(({ rows, list }) =>
      rows.flatMap((item) => {
        if (seen.has(item.id)) return [];
        seen.add(item.id);
        const fields = [item.title, item.origin.name];
        if (item.branch !== null) fields.push(item.branch);
        if (item.project !== null) fields.push(item.project);
        const score = fuzzyMatchFields(
          query,
          fields.map((field) => field.slice(0, paletteFieldChars)),
        );
        return score === null ? [] : [{ item, score, done: list === "done" }];
      }),
    )
    .toSorted((a, b) => Number(a.done) - Number(b.done) || b.score - a.score);
}

export function inboxSequence(sections: ReturnType<typeof inboxSections>) {
  return openInboxRows(sections).map(({ row }) => row);
}

export function adjacentInboxItem(items: InboxItem[], current: string | undefined, delta: 1 | -1) {
  const index = items.findIndex((item) => item.id === current);
  return items[index < 0 ? (delta === 1 ? 0 : items.length - 1) : index + delta];
}

/** Visit first occurrences only, starting from the focused row's own position. */
export function adjacentInboxRow(ids: string[], focused: number, delta: 1 | -1): number {
  const seen = new Set<string>();
  const canonical = ids.map((id) => {
    const first = !seen.has(id);
    seen.add(id);
    return first;
  });
  const start = focused < 0 ? (delta === 1 ? 0 : ids.length - 1) : focused + delta;
  for (let index = start; index >= 0 && index < ids.length; index += delta) {
    if (canonical[index]) return index;
  }
  return -1;
}
