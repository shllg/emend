import type { WriteupInput } from "@emend/contract";
import { expect, test } from "vitest";
import { type RenderEffects, renderDoc } from "./markdown.ts";
import { renderWriteup } from "./writeup.ts";

const media = new Map([["media/listed.png", "a".repeat(64)]]);
const source = (overview: string): WriteupInput => ({ overview, tldr: "", decisions: "", topics: {} });

test.each([
  ['<pre><code class="language-js"><img src="missing.png">const x=1</code></pre>', "code"],
  ['<pre><code class="language-mermaid"><img src="missing.png">graph TD; A-->B</code></pre>', "diagram"],
  ["```mermaid\ngraph TD; A[\"<img src='missing.png'>\"]\n```", "diagram"],
])("does not report images removed from %j", async (overview, kind) => {
  const effects: RenderEffects = {};
  const input = source(overview);
  const rendered = await renderWriteup(input, [], { effects });
  expect([...(effects.unlistedMedia ?? [])]).toEqual([]);
  expect(rendered.sections[0]?.blocks).toHaveLength(1);
  expect(rendered.sections[0]?.blocks[0]?.kind).toBe(kind);
  expect(rendered.sections[0]?.blocks[0]?.html).not.toContain("<img");
  expect(rendered).toEqual(await renderWriteup(input, []));
});

test.each([
  ["media//x.png", "media//x.png"],
  ["media/./x.png", "media/./x.png"],
  ["%2e/media/x.png", "./media/x.png"],
])("reports malformed path %s even when the corrected path is listed", async (path, normalized) => {
  const effects: RenderEffects = {};
  const input = source(`Screenshot: ![Before](${path})`);
  const media = new Map([["media/x.png", "a".repeat(64)]]);
  const rendered = await renderWriteup(input, [], { media, effects });
  expect([...(effects.unlistedMedia ?? [])]).toEqual([normalized]);
  expect(rendered.sections[0]?.blocks[0]?.html).toBe('<p>Screenshot: <img alt="Before"></p>');
  expect(rendered).toEqual(await renderWriteup(input, [], { media }));
});

test.each([
  ["media/a%20b.png", "media/a b.png"],
  ["media/a.png?x=1#y", "media/a.png"],
  ["media/listed.png", "media/listed.png"],
])("resolves listed path %s with unchanged HTML", async (src, path) => {
  const effects: RenderEffects = {};
  const input = source(`Screenshot: ![Before](${src})`);
  const media = new Map([[path, "a".repeat(64)]]);
  const rendered = await renderWriteup(input, [], { media, effects });
  expect([...(effects.unlistedMedia ?? [])]).toEqual([]);
  expect(rendered.sections[0]?.blocks[0]?.html).toBe(
    '<p>Screenshot: <span class="emend-media"><img src="/api/v1/media/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" alt="Before" loading="lazy" decoding="async"><span class="emend-media-caption">Before</span></span></p>',
  );
  expect(rendered).toEqual(await renderWriteup(input, [], { media }));
});

test("keeps unlisted images in labelled topic example rows", async () => {
  const input: WriteupInput = {
    ...source(""),
    topics: { example: { why: "Synthetic example", example: "Before: ![Before](media/missing.png)\nAfter: fixed" } },
  };
  const topics = [{ slug: "example", title: "Example", summary: "Synthetic", importance: 10 }];
  const effects: RenderEffects = {};
  const rendered = await renderWriteup(input, topics, { effects });
  expect([...(effects.unlistedMedia ?? [])]).toEqual(["media/missing.png"]);
  expect(rendered.sections.find((section) => section.key === "t-example-example")?.blocks[0]?.html).toBe(
    '<p class="emend-example-rows"><span class="emend-example-row"><span class="emend-example-label">Before:</span><span class="emend-example-value"> <img alt="Before"></span></span>\n<span class="emend-example-row"><span class="emend-example-label">After:</span><span class="emend-example-value"> fixed</span></span></p>',
  );
  expect(rendered).toEqual(await renderWriteup(input, topics));
});

test("shares one ordered set across sections and subsequent renders", async () => {
  const paths = new Set<string>();
  const effects: RenderEffects = { unlistedMedia: paths };
  await renderWriteup({ ...source("![A](media/a.png)"), tldr: "![B](media/b.png)" }, [], { effects });
  await renderWriteup(source("![B](media/b.png) ![C](media/c.png)"), [], { effects });
  expect(effects.unlistedMedia).toBe(paths);
  expect([...paths]).toEqual(["media/a.png", "media/b.png", "media/c.png"]);
});

test.each([
  ["![Before](media/missing.png)", ["media/missing.png"]],
  ["![Before](./media/missing.png)", ["media/missing.png"]],
  ["![a][ref]\n\n[ref]: media/missing.png", ["media/missing.png"]],
  ['<img src="media/missing.png" alt="x">', ["media/missing.png"]],
  ["![a](media/missing.png) ![b](./media/missing.png)", ["media/missing.png"]],
  ["![a](media/z.png) ![b](media/a.png) ![c](media/z.png)", ["media/z.png", "media/a.png"]],
  ["![a](media/listed.png)", []],
  ["![a](./media/listed.png)", []],
  ["![a](https://example.com/a.png)", []],
  ["![a](http://example.com/a.png)", []],
  ["![a](data:image/png;base64,AAAA)", []],
  ["![a](../x.png)", []],
  ["<img src=x onerror=alert(1)>", ["x"]],
  ['<img src="javascript:alert(1)" alt="x">', []],
  ['<img src="media/\u001b[31m.png" alt="x">', []],
  ['<img src="media/\u0001.png" alt="x">', []],
  ["![a](media/%1b[31m.png)", []],
  ['<img src="media/\u009b31m.png" alt="x">', ["media/\u009b31m.png"]],
] satisfies [string, string[]][])("reports only unlisted local paths in %j", async (overview, expected) => {
  const effects: RenderEffects = {};
  const input = source(`Screenshot: ${overview}`);
  const rendered = await renderWriteup(input, [], { media, effects });
  expect([...(effects.unlistedMedia ?? [])]).toEqual(expected);
  expect(rendered).toEqual(await renderWriteup(input, [], { media }));
  const html = rendered.sections
    .flatMap((section) => section.blocks)
    .map((block) => block.html)
    .join("");
  expect(html).not.toMatch(/onerror|javascript:|data:|https?:/);
  for (const control of ["\u001b", "\u0001", "\u009b"]) expect(html).not.toContain(control);
  if (overview.includes("listed.png") && !overview.includes("missing.png")) {
    expect(html).toContain(`/api/v1/media/${"a".repeat(64)}`);
  } else {
    expect(html).not.toContain("src=");
    expect(html).toContain("<img");
  }
});

test("reports unlisted media when no media map is supplied", async () => {
  const effects: RenderEffects = {};
  const input = source("![Before](media/missing.png)");
  const rendered = await renderWriteup(input, [], { effects });
  expect([...(effects.unlistedMedia ?? [])]).toEqual(["media/missing.png"]);
  expect(rendered).toEqual(await renderWriteup(input, []));
  // An image-only paragraph without a resolved source has no visible block today.
  expect(rendered.sections[0]?.blocks).toEqual([]);
});

test.each([false, true])("collects every section and deduplicates across them (glossary list: %s)", async (list) => {
  const image = (name: string) => `![Before](media/${name}.png)`;
  const input: WriteupInput = {
    overview: image("overview"),
    tldr: image("tldr"),
    whyItMatters: image("whyItMatters"),
    // The verdict is accepted but never rendered, so its media is not collected.
    review: { level: "skim", reason: image("review") },
    checked: image("checked"),
    notChecked: image("notChecked"),
    outOfScope: image("outOfScope"),
    whereToLook: image("whereToLook"),
    context: image("context"),
    decisions: image("decisions"),
    glossary: list
      ? [{ term: "Screenshot", definition: `${image("glossary")} ${image("overview")}` }]
      : `${image("glossary")} ${image("overview")}`,
    topics: { example: { why: image("why"), example: image("example"), body: `${image("body")} ${image("why")}` } },
  };
  const topics = [{ slug: "example", title: "Example", summary: "Synthetic", importance: 10 }];
  const effects: RenderEffects = {};
  const rendered = await renderWriteup(input, topics, { effects });
  expect([...(effects.unlistedMedia ?? [])]).toEqual(
    [
      "tldr",
      "whyItMatters",
      "checked",
      "notChecked",
      "overview",
      "outOfScope",
      "whereToLook",
      "context",
      "decisions",
      "glossary",
      "why",
      "example",
      "body",
    ].map((name) => `media/${name}.png`),
  );
  expect(rendered).toEqual(await renderWriteup(input, topics));
});

test("hostile HTML and diagrams in the overview and glossary keep the same sanitized output", async () => {
  const hostile = [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    "[Unsafe](javascript:alert(1))",
    '<div onclick="alert(1)">Raw HTML</div>',
    '<svg onload="alert(1)"><circle /></svg>',
    '```mermaid\ngraph TD; A-->B; click A "javascript:alert(1)"\n```',
  ].join("\n\n");
  const input = { ...source(hostile), glossary: hostile };
  const effects: RenderEffects = {};
  const rendered = await renderWriteup(input, [], { effects });
  expect([...(effects.unlistedMedia ?? [])]).toEqual(["x"]);
  expect(rendered).toEqual(await renderWriteup(input, []));
  const blocks = rendered.sections.flatMap((section) => section.blocks);
  expect(blocks.map((block) => block.html).join("")).not.toMatch(/<(script|svg)|\son\w+=|javascript:/);
  expect(blocks.filter((block) => block.kind === "diagram")).toHaveLength(2);
});

test("Markdown docs may report the effect without changing their rendered output", async () => {
  const effects: RenderEffects = {};
  const markdown = "![Before](media/missing.png)";
  const rendered = await renderDoc(markdown, "doc.md", undefined, undefined, effects);
  expect([...(effects.unlistedMedia ?? [])]).toEqual(["media/missing.png"]);
  expect(rendered).toEqual(await renderDoc(markdown, "doc.md"));
});
