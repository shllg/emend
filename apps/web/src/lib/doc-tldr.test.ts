import type { RenderedBlock } from "@emend/contract";
import { expect, test } from "vitest";
import { docTldrRange } from "./doc-tldr.ts";

const paragraph: RenderedBlock = {
  id: "doc-12345678-12345678",
  section: "doc-12345678",
  kind: "paragraph",
  html: "<p>Summary</p>",
  text: "Summary",
};

function heading(text: string, level = 2): RenderedBlock {
  return {
    ...paragraph,
    kind: "heading",
    html: `<h${level} id="heading-abc">${text}</h${level}>`,
    text,
  };
}

test("finds an h2 TL;DR after the document title", () => {
  const blocks = [heading("Guide", 1), heading("TL;DR"), paragraph, heading("Details"), paragraph];
  expect(docTldrRange(blocks)).toEqual({ start: 1, end: 3 });
});

test("ignores an h3 TL;DR", () => {
  expect(docTldrRange([heading("TL;DR", 3), paragraph])).toBeUndefined();
});

test("includes h3 headings and their content inside the section", () => {
  const blocks = [heading("TL;DR"), paragraph, heading("Context", 3), paragraph, heading("Details")];
  expect(docTldrRange(blocks)).toEqual({ start: 0, end: 4 });
});

test.each([1, 2])("ends the section at the next h%i", (level) => {
  expect(docTldrRange([heading("TL;DR"), paragraph, heading("Details", level), paragraph])).toEqual({
    start: 0,
    end: 2,
  });
});

test("runs to the end of the document without another h1 or h2", () => {
  expect(docTldrRange([heading("Guide", 1), heading("TL;DR"), paragraph])).toEqual({ start: 1, end: 3 });
});

test("ignores an empty section, including one at the end", () => {
  expect(docTldrRange([heading("TL;DR"), heading("Details"), paragraph])).toBeUndefined();
  expect(docTldrRange([heading("Guide", 1), heading("TL;DR")])).toBeUndefined();
});

test("uses only the first TL;DR section", () => {
  const blocks = [heading("TL;DR"), paragraph, heading("Details"), paragraph, heading("TL;DR"), paragraph];
  expect(docTldrRange(blocks)).toEqual({ start: 0, end: 2 });
});

test("does not skip an empty first TL;DR to use a later section", () => {
  expect(docTldrRange([heading("TL;DR"), heading("Details"), heading("TL;DR"), paragraph])).toBeUndefined();
});

test.each(["TL;DR:", "tl;dr", "  Tl;Dr:  "])("recognizes %s", (text) => {
  expect(docTldrRange([heading(text), paragraph])).toEqual({ start: 0, end: 2 });
});

test("recognizes a heading without attributes", () => {
  expect(docTldrRange([{ ...heading("TL;DR"), html: "<h2>TL;DR</h2>" }, paragraph])).toEqual({
    start: 0,
    end: 2,
  });
});

test("requires both the heading kind and an h2 element", () => {
  expect(docTldrRange([{ ...heading("TL;DR"), kind: "paragraph" }, paragraph])).toBeUndefined();
  expect(docTldrRange([{ ...heading("TL;DR"), html: "<h20>TL;DR</h20>" }, paragraph])).toBeUndefined();
});

test("returns undefined without a TL;DR heading", () => {
  expect(docTldrRange([])).toBeUndefined();
  expect(docTldrRange([heading("Guide", 1), paragraph, heading("Details")])).toBeUndefined();
  expect(docTldrRange([heading("TL;DR::"), paragraph])).toBeUndefined();
});
