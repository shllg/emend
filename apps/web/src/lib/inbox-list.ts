import { type InboxItem, type InboxListGroup, LIMITS } from "@emend/contract";
import { fuzzyMatchFields } from "./fuzzy-match.ts";

// Agent-written fields may be far longer; an issue number and a name sit at the start.
const paletteFieldChars = LIMITS.titleChars;

export type InboxKind = "" | "review" | "publish";
export const inboxKindKey = "emend:inbox-kind";
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
  const lists: { key: string; list: "active" | "snoozed" | "group" | "done"; title: string; group?: InboxListGroup }[] =
    [
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
    const rows = filtered.filter((review) => sectionKey(review) === key);
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
      nothingActive: list === "active" && !items.some((review) => sectionKey(review) === "active"),
      expanded: list === "active" || (open[key] ?? false) || needle !== "",
    };
  });
}

export function activeJumpRows(sections: ReturnType<typeof inboxSections>) {
  return (
    sections
      .find((section) => section.list === "active")
      ?.rows.filter((row) => !row.movedTo)
      .slice(0, 9) ?? []
  );
}

/** Palette matches keep the inbox's display order on ties, with Done after every other section. */
export function matchInboxItems(items: InboxItem[], now: number, query: string, groups: InboxListGroup[] = []) {
  if (!query.trim()) return [];
  return inboxSections(items, now, { groups })
    .flatMap(({ rows, list }) =>
      rows.flatMap((item) => {
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
  return sections.flatMap(({ expanded, rows }) => (expanded ? rows.filter((row) => !row.movedTo) : []));
}

export function adjacentInboxItem(items: InboxItem[], current: string | undefined, delta: 1 | -1) {
  const index = items.findIndex((item) => item.id === current);
  return items[index < 0 ? (delta === 1 ? 0 : items.length - 1) : index + delta];
}
