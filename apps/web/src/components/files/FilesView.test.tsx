import type { FileView, RevisionView } from "@emend/contract";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { createLayoutStore, layoutStore } from "../../lib/layout-store.ts";
import { FilesView } from "./FilesView.tsx";

afterEach(() => {
  cleanup();
  layoutStore.update({ fileOrder: "topics" });
});
const file = (path: string, order: number, topic: string | null = null): FileView => ({
  id: crypto.randomUUID(),
  path,
  order,
  topic,
  oldPath: null,
  role: "diff",
  status: "modified",
  mediaType: "text/plain",
  flag: null,
  hasOld: true,
  hasNew: true,
});

test("topic totals are ready before any file has been parsed", () => {
  const revision: RevisionView = {
    seq: 1,
    base: null,
    head: null,
    main: null,
    writeupEmpty: true,
    topics: [{ slug: "first", title: "First", importance: 10, summary: "" }],
    files: [
      { ...file("a.ts", 0, "first"), counts: { additions: 2, deletions: 1 } },
      { ...file("b.ts", 1, "first"), counts: { additions: 3, deletions: 5 } },
      { ...file("c.ts", 2), counts: { additions: 7, deletions: 9 } },
      { ...file("d.ts", 3), flag: "binary" },
    ],
    docs: [],
    threads: [],
    writeup: { sections: [] },
    changedBlocks: [],
  };
  const { container, rerender } = render(
    <FilesView revision={revision} counts={new Map()} onViewed={vi.fn()} onNavigate={vi.fn()} />,
  );
  for (const [title, added, removed] of [
    ["First", "+5", "−6"],
    ["Other files", "+7", "−9"],
  ] as const) {
    const head = screen.getByRole("region", { name: title }).querySelector<HTMLElement>(".em-files-group__head");
    expect(head).toBeTruthy();
    if (!head) throw new Error("Missing topic header");
    expect(within(head).getByText(added)).toBeTruthy();
    expect(within(head).getByText(removed)).toBeTruthy();
  }
  for (const row of container.querySelectorAll(".em-files-row__counts")) expect(row.textContent).toBe("");
  for (const files of [
    revision.files.map(({ counts: _counts, ...file }) => file),
    [{ ...file("doc.md", 0), role: "doc" as const }],
    [],
  ]) {
    rerender(
      <FilesView revision={{ ...revision, files }} counts={new Map()} onViewed={vi.fn()} onNavigate={vi.fn()} />,
    );
    expect(container.querySelector(".text-diff-add-fg, .text-diff-del-fg")).toBeNull();
  }
});

test("Files groups match diff order, render counts, old-side threads, stale marks and hostile paths as text", () => {
  const hostile = "<img src=x onerror=alert(1)>/a.ts";
  const first = {
    ...file(hostile, 1, "first"),
    status: "renamed" as const,
    oldPath: "old/a.ts",
    viewed: "stale" as const,
    viewedOn: 1,
  };
  const last = { ...file("tail.ts", 0, "last"), viewed: "viewed" as const, viewedOn: 2 };
  const other = file("misc.ts", 2);
  const view: RevisionView = {
    seq: 3,
    base: null,
    head: null,
    main: null,
    writeupEmpty: true,
    files: [last, other, first, { ...file("doc.md", 3), role: "doc" }],
    topics: [
      { slug: "last", title: "Last", importance: 20, summary: "" },
      { slug: "first", title: "First", importance: 10, summary: "" },
    ],
    threads: [
      {
        id: crypto.randomUUID(),
        target: { kind: "file", path: first.path },
        state: "open",
        createdOn: 1,
        comments: [],
        placement: { status: "placed", location: { kind: "lines", path: "old/a.ts", side: "old", start: 1, end: 1 } },
      },
    ],
    docs: [],
    writeup: { sections: [] },
    changedBlocks: [],
  };
  const onViewed = vi.fn(),
    onNavigate = vi.fn();
  const counts = new Map([[first.id, { additions: 2, deletions: 1 }]]);
  const { container, rerender } = render(
    <FilesView revision={view} counts={counts} onViewed={onViewed} onNavigate={onNavigate} />,
  );
  expect(screen.getAllByRole("region").map((group) => group.getAttribute("aria-label"))).toEqual([
    "First",
    "Last",
    "Other files",
  ]);
  const group = within(screen.getByRole("region", { name: "First" }));
  expect(group.getByText("01")).toBeTruthy();
  expect(group.getByText("0/1")).toBeTruthy();
  expect(group.getByText("R")).toBeTruthy();
  const row = group.getByRole("button", { name: `Open diff for ${hostile}, renamed, 2 added, 1 removed, 1 thread` });
  expect(within(row).getByText("+2")).toBeTruthy();
  expect(within(row).getByText("−1")).toBeTruthy();
  expect(group.getByText("1 thread")).toBeTruthy();
  const path = group.getByTitle(hostile);
  expect(path.querySelector("bdi")?.textContent).toBe(hostile);
  expect(path.querySelector(".em-files-row__dir")?.textContent).toBe("<img src=x onerror=alert(1)>/");
  expect(container.querySelector("img, script")).toBeNull();
  expect(group.getByText("changed")).toBeTruthy();
  const toggle = group.getByRole("button", {
    name: `Viewed in revision 1; this revision differs. Mark ${hostile} as viewed`,
  });
  expect(toggle.hasAttribute("data-stale")).toBe(true);
  expect(toggle.title).toBe(`Viewed in revision 1; this revision differs. Mark ${hostile} as viewed`);
  expect(toggle.getAttribute("aria-pressed")).toBe("false");
  const box = toggle.querySelector(".em-viewed-mark__box");
  const unviewed = screen.getByRole("button", { name: "Mark misc.ts as viewed" });
  expect(box?.childElementCount).toBe(0);
  expect(box?.querySelector("svg")).toBeNull();
  expect(box?.className).toBe(unviewed.querySelector(".em-viewed-mark__box")?.className);
  const hint = within(toggle).getByText("changed");
  expect(box?.compareDocumentPosition(hint)).toBe(Node.DOCUMENT_POSITION_PRECEDING);
  expect(within(toggle).queryByText("Viewed")).toBeNull();
  expect(screen.getByText("1 of 3 viewed")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Open diff for misc.ts, modified" })).toBeTruthy();
  expect(screen.getByRole("progressbar").getAttribute("value")).toBe("1");
  fireEvent.click(row);
  expect(onNavigate).toHaveBeenCalledWith(first);
  expect(row.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(row.tabIndex).toBe(0);
  expect(toggle.tabIndex).toBe(0);
  fireEvent.click(toggle);
  expect(onViewed).toHaveBeenCalledWith([hostile], true);
  expect(onNavigate).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("region", { name: "Last" }).querySelector(".em-files-row__counts")?.textContent).toBe("");
  rerender(
    <FilesView
      revision={view}
      counts={new Map([...counts, [last.id, { additions: 4, deletions: 0 }]])}
      onViewed={onViewed}
      onNavigate={onNavigate}
    />,
  );
  expect(
    within(screen.getByRole("button", { name: "Open diff for tail.ts, modified, 4 added, 0 removed" })).getByText("+4"),
  ).toBeTruthy();
  const rowStates = () =>
    Object.fromEntries(
      [...container.querySelectorAll(".em-files-row")].map((row) => {
        const main = row.querySelector(".em-files-row__main");
        const mark = row.querySelector(".em-viewed-mark");
        return [
          row.querySelector(".em-files-row__path")?.getAttribute("title"),
          {
            label: main?.getAttribute("aria-label"),
            text: main?.textContent,
            viewed: row.getAttribute("data-viewed"),
            markLabel: mark?.getAttribute("aria-label"),
            pressed: mark?.getAttribute("aria-pressed"),
            stale: mark?.hasAttribute("data-stale"),
          },
        ];
      }),
    );
  const topicRows = rowStates();
  const order = screen.getByRole("radiogroup", { name: "File order" });
  expect(within(order).getByRole("radio", { name: "Topics" }).getAttribute("aria-checked")).toBe("true");
  fireEvent.click(within(order).getByRole("radio", { name: "A to Z" }));
  expect(screen.getAllByRole("region").map((group) => group.getAttribute("aria-label"))).toEqual(["Files A to Z"]);
  expect(container.querySelector(".em-files-group__head")).toBeNull();
  expect(screen.queryAllByRole("button", { name: /\btopic (First|Last|Other files)\b/ })).toHaveLength(0);
  expect([...container.querySelectorAll(".em-files-row__path")].map((path) => path.getAttribute("title"))).toEqual([
    hostile,
    "misc.ts",
    "tail.ts",
  ]);
  expect(rowStates()).toEqual(topicRows);
  expect(container.querySelector("img, script")).toBeNull();
  expect(screen.getByText("1 of 3 viewed")).toBeTruthy();
  expect(screen.getByRole("progressbar").getAttribute("value")).toBe("1");
  expect(layoutStore.getSnapshot().fileOrder).toBe("path");
  const pathRow = screen.getByRole("button", {
    name: `Open diff for ${hostile}, renamed, 2 added, 1 removed, 1 thread`,
  });
  fireEvent.click(pathRow);
  expect(onNavigate).toHaveBeenLastCalledWith(first);
  expect(onNavigate).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "Unmark tail.ts as viewed" }));
  expect(onViewed).toHaveBeenLastCalledWith([last.path], false);
  fireEvent.click(within(order).getByRole("radio", { name: "Topics" }));
  expect(screen.getAllByRole("region").map((group) => group.getAttribute("aria-label"))).toEqual([
    "First",
    "Last",
    "Other files",
  ]);
  expect(screen.getAllByRole("button", { name: /\btopic (First|Last|Other files)\b/ })).toHaveLength(3);
  expect(rowStates()).toEqual(topicRows);
});

test("the saved file order applies to a fresh render of a different revision", () => {
  const revision: RevisionView = {
    seq: 1,
    base: null,
    head: null,
    main: null,
    writeupEmpty: true,
    topics: [],
    files: [file("z.ts", 0), file("a.ts", 1)],
    docs: [],
    threads: [],
    writeup: { sections: [] },
    changedBlocks: [],
  };
  const { unmount } = render(
    <FilesView revision={revision} counts={new Map()} onViewed={vi.fn()} onNavigate={vi.fn()} />,
  );
  fireEvent.click(screen.getByRole("radio", { name: "A to Z" }));
  expect(layoutStore.getSnapshot().fileOrder).toBe("path");
  expect(createLayoutStore().getSnapshot().fileOrder).toBe("path");
  unmount();
  render(
    <FilesView
      revision={{ ...revision, seq: 2, files: [file("src/y.ts", 0), file("src/b.ts", 1)] }}
      counts={new Map()}
      onViewed={vi.fn()}
      onNavigate={vi.fn()}
    />,
  );
  expect(screen.getByRole("radio", { name: "A to Z" }).getAttribute("aria-checked")).toBe("true");
  const rows = screen.getAllByRole("button", { name: /^Open diff for / });
  expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
    "Open diff for src/b.ts, modified",
    "Open diff for src/y.ts, modified",
  ]);
  expect(screen.queryByRole("region", { name: "Other files" })).toBeNull();
});
