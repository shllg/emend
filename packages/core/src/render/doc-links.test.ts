import { expect, test, vi } from "vitest";
import { markdownHeadings } from "../doc-headings.ts";
import { headingLookups } from "../heading-lookups.ts";
import type { HtmlRoot } from "./blocks.ts";
import { renderCommentHtml, renderDoc } from "./markdown.ts";
import { hardenLinks } from "./sanitize.ts";
import { renderWriteup } from "./writeup.ts";

const docs = new Map([
  [
    "docs/b.md",
    new Map([
      ["part", "user-content-part"],
      ["thread-unsafe", "user-content-thread-unsafe"],
    ]),
  ],
  ["a b&c.html", new Map<string, string>()],
]);
const html = (blocks: { html: string }[]) => blocks.map((b) => b.html).join("");
test("doc links use only declared paths and heading ids, dropping queries and other fragments", async () => {
  const rendered = html(
    await renderDoc(
      "[ok](b.md#part) [query](b.md?rev=9#part) [unknown](b.md#thread-foreign) [outside](missing.md) [namespace](b.md#thread-unsafe)",
      "docs/a.md",
      undefined,
      docs,
    ),
  );
  expect(rendered).toContain('href="?tab=docs&#x26;doc=docs%2Fb.md#h-user-content-part"');
  expect(rendered.match(/#h-user-content-part/g)).toHaveLength(2);
  expect(rendered).toContain('href="?tab=docs&#x26;doc=docs%2Fb.md">unknown');
  expect(rendered).toContain("<a>outside</a>");
  expect(rendered).toContain("#h-user-content-thread-unsafe");
  expect(rendered).not.toContain("rev=9");
});
test("writeup links start at the root; comments receive no doc context", async () => {
  const rendered = await renderWriteup(
    { overview: "[doc](a%20b%26c.html#no)", tldr: "", decisions: null, topics: {} },
    [],
    { docs },
  );
  expect(html(rendered.sections.flatMap((s) => s.blocks))).toContain('href="?tab=docs&#x26;doc=a+b%26c.html"');
  expect(await renderCommentHtml("[doc](docs/b.md#part)")).toBe("<p><a>doc</a></p>");
});
test("doc context cannot bypass hostile content isolation, including glossary and diagrams", async () => {
  const source =
    '<script>evil()</script>\n\n<img src="x" onerror="evil()">\n\n[bad](javascript:evil) <svg><title>evil</title></svg> <a href="/docs/b.md" data-docs="x">root</a>\n\n```mermaid\ngraph TD; A-->B; click A "javascript:evil()"\n```';
  const rendered = await renderWriteup(
    { overview: source, glossary: source, tldr: "", decisions: null, topics: {} },
    [],
    { docs },
  );
  const blocks = rendered.sections.flatMap((s) => s.blocks);
  expect(html(blocks)).not.toMatch(/<script|<svg|onerror|javascript:|data-docs|href=|src=/i);
  expect(blocks.filter((b) => b.kind === "diagram")).toHaveLength(2);
  expect(blocks.filter((b) => b.kind === "diagram").every((b) => b.html === "")).toBe(true);
});

test("author fragments resolve only to declared sanitized headings", async () => {
  const target = await renderDoc('<h2 id="x">Author</h2>', "docs/b.md");
  const declared = new Map([["docs/b.md", headingLookups(markdownHeadings(target))]]);
  const rendered = html(await renderDoc("[yes](b.md#x) [no](b.md#absent)", "docs/a.md", undefined, declared));
  expect(rendered).toContain('href="?tab=docs&#x26;doc=docs%2Fb.md#h-user-content-x">yes');
  expect(rendered).toContain('href="?tab=docs&#x26;doc=docs%2Fb.md">no');
  expect(rendered).not.toMatch(/href="[^"]*#x"/);
});

test("HTML doc links discard fragments", async () => {
  expect(docs.get("a b&c.html")).toEqual(new Map());
  expect(html(await renderDoc("[html](a%20b%26c.html#author)", "a.md", undefined, docs))).toContain(
    'href="?tab=docs&#x26;doc=a+b%26c.html">html',
  );
});

test("author fragments map only to their own prefixed id, never generated heading ids", async () => {
  const target = await renderDoc('<h2 id="x">One</h2><h2 id="user-content-x">Two</h2>\n\n## Generated', "docs/b.md");
  const headings = markdownHeadings(target);
  expect(headings.slice(0, 2).map((heading) => heading.id)).toEqual(["user-content-x", "user-content-user-content-x"]);
  const generated = headings[2]?.id;
  expect(generated).toMatch(/^heading-/);
  const declared = new Map([["docs/b.md", headingLookups(headings)]]);
  const rendered = html(
    await renderDoc(
      `[one](b.md#x) [two](b.md#user-content-x) [generated](b.md#${generated})`,
      "docs/a.md",
      undefined,
      declared,
    ),
  );
  expect(rendered).toContain('href="?tab=docs&#x26;doc=docs%2Fb.md#h-user-content-x">one');
  expect(rendered).toContain('href="?tab=docs&#x26;doc=docs%2Fb.md#h-user-content-user-content-x">two');
  expect(rendered).toContain('href="?tab=docs&#x26;doc=docs%2Fb.md">generated');
});

test("rendering without links does no per-path work on the doc map", async () => {
  const declared = new Map(docs);
  const keys = vi.spyOn(declared, "keys");
  const entries = vi.spyOn(declared, Symbol.iterator);
  const has = vi.spyOn(declared, "has");
  const get = vi.spyOn(declared, "get");
  await renderDoc("# No links\n\nPlain text.", "docs/a.md", undefined, declared);
  expect(keys).not.toHaveBeenCalled();
  expect(entries).not.toHaveBeenCalled();
  expect(has).not.toHaveBeenCalled();
  expect(get).not.toHaveBeenCalled();
});

test("footnote markers and links with block children receive no doc rewrite", async () => {
  const declared = new Map([
    [
      "docs/a.md",
      new Map([
        ["fn-1", "user-content-fn-1"],
        ["fnref-1", "user-content-fnref-1"],
      ]),
    ],
    ["docs/b.md", new Map<string, string>()],
  ]);
  const rendered = html(
    await renderDoc(
      'Foot[^1].\n\n[^1]: note\n\n<div><a href="b.md"><p>Block link</p></a></div>',
      "docs/a.md",
      undefined,
      declared,
    ),
  );
  expect(rendered).not.toContain("href=");
});

test("nested docs and writeup resolve identical links against their own bases", async () => {
  const declared = new Map([
    ["target.md", new Map<string, string>()],
    ["docs/nested/target.md", new Map<string, string>()],
  ]);
  const writeup = await renderWriteup({ overview: "[go](target.md)", tldr: "", decisions: null, topics: {} }, [], {
    docs: declared,
  });
  expect(html(writeup.sections.flatMap((s) => s.blocks))).toContain('doc=target.md"');
  expect(html(await renderDoc("[go](target.md)", "docs/nested/start.md", undefined, declared))).toContain(
    'doc=docs%2Fnested%2Ftarget.md"',
  );
});

test("the hardener records path dependence in file data", () => {
  const tree: HtmlRoot = {
    type: "root",
    children: [
      { type: "element", tagName: "a", properties: { href: "b.md" }, children: [{ type: "text", value: "Go" }] },
    ],
  };
  const file = { data: { docs, docBase: "docs/a.md" } as Record<string, unknown> };
  hardenLinks()(tree, file);
  expect(file.data.docBaseUsed).toBe(true);
});

test("lookup keys never become emitted fragments, including hostile and noncanonical names", async () => {
  const blocks = await renderDoc('<h2 id="x">Author</h2>\n\n## Setup\n\n## Café', "target.md");
  const headings = markdownHeadings(blocks);
  const names = headingLookups(headings);
  const docs = new Map([["target.md", names]]);
  for (const fragment of [
    "constructor",
    "__proto__",
    headings[1]?.id ?? "",
    "user-content-x",
    "cafe\u0301",
    "setup\u200b",
  ]) {
    const rendered = html(
      await renderDoc(`[miss](target.md#${encodeURIComponent(fragment)})`, "start.md", undefined, docs),
    );
    expect(rendered).toBe('<p><a href="?tab=docs&#x26;doc=target.md">miss</a></p>');
  }
  const rendered = html(await renderDoc("[go](#setup)", "target.md", undefined, docs));
  expect(rendered).toContain(`#h-${headings[1]?.id}`);
  expect(rendered).not.toContain("#setup");
});
