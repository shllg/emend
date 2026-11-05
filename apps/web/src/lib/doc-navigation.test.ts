import type { RevisionView } from "@emend/contract";
import { afterEach, expect, test, vi } from "vitest";
import { docFilename, docHeading, docTitle, findDocHeadings } from "./doc-navigation.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
test("filenames use the shortest distinguishing suffix and old titles use the filename", () => {
  const docs: RevisionView["docs"] = ["one/api/guide.md", "two/api/guide.md", "web/guide.md"].map((path) => ({
    kind: "markdown",
    path,
    blocks: [],
    title: "Guide",
  }));
  expect(docs.map((doc) => docFilename(doc, docs))).toEqual(["one/api/guide.md", "two/api/guide.md", "web/guide.md"]);
  expect(docTitle({ kind: "markdown", path: "dir/old.md", blocks: [] })).toBe("old.md");
});
test("heading lookup scans the open doc once and checks the declared tag and id", () => {
  const section = document.createElement("section");
  section.dataset.readingDoc = "doc.md";
  const scroller = document.createElement("div");
  scroller.dataset.readingScroll = "";
  scroller.append(section);
  document.body.append(scroller);
  for (const [tag, id] of [
    ["p", "constructor"],
    ["h3", "constructor"],
    ["h2", "constructor"],
    ["h2", "undeclared"],
  ]) {
    const node = document.createElement(tag ?? "p");
    node.id = id ?? "";
    const block = document.createElement("div");
    block.id = "block-doc-heading";
    block.dataset.blockId = "doc-heading";
    block.dataset.blockKind = "heading";
    block.append(node);
    section.append(block);
  }
  const doc = {
    blocks: [{ id: "doc-heading", kind: "heading" as const }],
    path: "doc.md",
    headings: [{ level: 2 as const, id: "constructor", text: "Section" }],
  };
  const scan = vi.spyOn(section, "querySelectorAll");
  expect([...findDocHeadings(document, doc).values()]).toEqual([section.children[2]?.firstElementChild]);
  expect(scan).toHaveBeenCalledTimes(1);
  expect(docHeading(document, doc, "constructor")).toBe(section.children[2]?.firstElementChild);
  expect(docHeading(document, doc, "undeclared")).toBeUndefined();
});

test("R1.9 a writeup group with the doc's path is never a doc container", () => {
  const scroller = document.createElement("div");
  scroller.dataset.readingScroll = "";
  document.body.append(scroller);
  const writeup = document.createElement("section");
  writeup.dataset.readingSection = "overview";
  const collision = document.createElement("h2");
  collision.id = "heading-shared";
  writeup.append(collision);
  scroller.append(writeup);
  const doc = {
    blocks: [{ id: "doc-heading", kind: "heading" as const }],
    path: "overview",
    headings: [{ level: 2 as const, text: "Heading", id: collision.id }],
  };
  expect(docHeading(document, doc, collision.id)).toBeUndefined();
  expect(findDocHeadings(document, doc).size).toBe(0);
  const outside = document.createElement("div");
  outside.dataset.readingDoc = "overview";
  outside.append(collision.cloneNode());
  document.body.prepend(outside);
  expect(docHeading(document, doc, collision.id)).toBeUndefined();
  const body = outside.cloneNode() as HTMLElement;
  const block = document.createElement("div");
  block.id = "block-doc-heading";
  block.dataset.blockId = "doc-heading";
  block.dataset.blockKind = "heading";
  block.append(collision.cloneNode());
  body.append(block);
  scroller.append(body);
  const actual = (body as Element).querySelector("h2");
  expect(docHeading(document, doc, collision.id)).toBe(actual);
  expect([...findDocHeadings(document, doc).values()]).toEqual([actual]);
});
