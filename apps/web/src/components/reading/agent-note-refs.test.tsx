import type { FileView } from "@recense/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { renderMarkdown } from "../../../../../packages/core/src/render/markdown.ts";
import { BlockReader, type ReaderGroup } from "./BlockReader.tsx";

afterEach(cleanup);
test("sanitized refs upgrade only within their topic, follow state changes and retire old controls", async () => {
  const blocks = await renderMarkdown(
    '<span class="ref" onclick="alert(1)" data-x="forged" data-agent-note-ref="forged">ref A</span> <span class="ref">ref Z</span> <span class="ref">ref A and more</span> <span class="ref">ref A\n</span>',
    "t-first-body",
  );
  const secondBlocks = await renderMarkdown('<span class="ref">ref A</span>', "t-second-body");
  const topic = { slug: "first", title: "First", summary: "", importance: 1 };
  const groups: ReaderGroup[] = [
    { key: "first", topic, blocks },
    { key: "second", topic: { ...topic, slug: "second" }, blocks: secondBlocks },
  ];
  const note = { id: crypto.randomUUID(), side: "new" as const, start: 1, end: 1, summary: "Decision", ref: "A" };
  const file: FileView = {
    id: crypto.randomUUID(),
    path: "first.ts",
    oldPath: null,
    role: "diff",
    status: "modified",
    topic: "first",
    order: 0,
    mediaType: "text/plain",
    flag: null,
    hasOld: true,
    hasNew: true,
    notes: [note],
  };
  const second = {
    ...file,
    id: crypto.randomUUID(),
    topic: "second",
    path: "second.ts",
    notes: [{ ...note, id: crypto.randomUUID() }],
  };
  const navigate = vi.fn();
  const client = new QueryClient();
  const view = (files: FileView[]) => (
    <QueryClientProvider client={client}>
      <BlockReader
        reviewId="synthetic"
        revision={1}
        changedBlocks={[]}
        threads={[]}
        groups={groups}
        files={files}
        onNote={navigate}
      />
    </QueryClientProvider>
  );
  const { rerender, container } = render(view([file, second]));
  expect(container.querySelector("[onclick],[data-x]")).toBeNull();
  expect(container.querySelectorAll("span[role=button]")).toHaveLength(2);
  for (const item of [file, second]) {
    const chip = screen.getByRole("button", { name: `Go to agent note A in ${item.path}` });
    fireEvent.keyDown(chip, { key: "Escape" });
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.click(chip);
    expect(navigate).toHaveBeenCalledWith(item.notes?.[0]?.id);
    navigate.mockClear();
  }
  const removed = screen.getByRole("button", { name: "Go to agent note A in first.ts" });
  rerender(view([second]));
  expect(removed.getAttribute("role")).toBeNull();
  expect(removed.getAttribute("data-agent-note-ref")).toBeNull();
  fireEvent.click(removed);
  expect(navigate).not.toHaveBeenCalled();
  const chip = screen.getByRole("button", { name: "Go to agent note A in second.ts" });
  fireEvent.keyDown(chip, { key: " " });
  expect(navigate).toHaveBeenCalledExactlyOnceWith(second.notes[0]?.id);
  expect(screen.getByText("ref Z").getAttribute("role")).toBeNull();
  expect(screen.getByText("ref A and more").getAttribute("role")).toBeNull();
  client.clear();
});
