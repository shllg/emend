import type { InboxItem } from "@emend/contract";

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
const lists = [
  { list: "active", title: "Active" },
  { list: "snoozed", title: "Snoozed" },
  { list: "done", title: "Done" },
] as const;
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
    open = { snoozed: false, done: false },
  }: {
    kind?: InboxKind;
    filter?: string;
    machine?: string;
    project?: string;
    open?: { snoozed: boolean; done: boolean };
  } = {},
) {
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
  return lists.map(({ list, title }) => {
    const rows = filtered.filter((review) => effectiveList(review, now) === list);
    if (list === "done")
      rows.sort(
        (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
    return {
      list,
      title,
      rows,
      nothingActive: list === "active" && !items.some((review) => effectiveList(review, now) === "active"),
      expanded: list === "active" || open[list] || needle !== "",
    };
  });
}

export function inboxSequence(sections: ReturnType<typeof inboxSections>) {
  return sections.flatMap(({ expanded, rows }) => (expanded ? rows.filter((row) => !row.movedTo) : []));
}

export function adjacentInboxItem(items: InboxItem[], current: string | undefined, delta: 1 | -1) {
  const index = items.findIndex((item) => item.id === current);
  return items[index < 0 ? (delta === 1 ? 0 : items.length - 1) : index + delta];
}
