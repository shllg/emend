import type { TopicMeta, WriteupInput } from "@emend/contract";
import { describe, expect, test } from "vitest";
import { renderMarkdownWithBudget } from "./markdown.ts";
import { renderWriteup } from "./writeup.ts";

const shaA = "a".repeat(64);
const shaB = "b".repeat(64);
const media = new Map([
  ["media/a.png", shaA],
  ["media/b.png", shaB],
  ["media/x.png", "c".repeat(64)],
]);
const render = (md: string, map: ReadonlyMap<string, string> | null = media) =>
  renderMarkdownWithBudget(md, "overview", { highlightedBytes: 0 }, undefined, map ?? undefined);
const html = async (md: string) => (await render(md)).map((block) => block.html).join("\n");

describe("writeup media", () => {
  test("resolves a declared image, wraps it with a caption and keeps lazy loading", async () => {
    const blocks = await render("![Before](media/a.png)");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.html).toBe(
      `<p class="emend-media-row"><span class="emend-media"><img src="/api/v1/media/${shaA}" alt="Before" loading="lazy" decoding="async"><span class="emend-media-caption">Before</span></span></p>`,
    );
    expect(blocks[0]?.text).toBe("Before");
    expect(blocks[0]?.kind).toBe("paragraph");
  });

  test("uses the file name when the alt text is empty", async () => {
    const blocks = await render("![](media/a.png)");
    expect(blocks[0]?.html).toContain('<span class="emend-media-caption">a.png</span>');
    expect(blocks[0]?.text).toBe("a.png");
  });

  test("renders nothing as an image without a media map", async () => {
    const blocks = await render("![Before](media/a.png) text", null);
    expect(blocks.map((block) => block.html).join("")).toBe('<p><img alt="Before"> text</p>');
  });

  test.each([
    ["javascript: URL", "javascript:alert(1)"],
    ["data: URL", "data:image/png;base64,AAAA"],
    ["parent traversal", "../media/a.png"],
    ["leading slash", "/media/a.png"],
    ["encoded traversal", "media/%2e%2e/x.png"],
    ["encoded slash", "media%2Fa.png"],
    ["backslash", "media%5Ca.png"],
    ["invalid escape", "media/%zz.png"],
    ["encoded NUL", "media/a%00.png"],
    ["undeclared path", "media/c.png"],
    ["scheme-like path", "x:media/a.png"],
  ])("does not resolve %s", async (_name, src) => {
    const out = await html(`<img src="${src}" alt="x">\n\n![x](<${src}>)`);
    expect(out).not.toMatch(/src=/);
    expect(out).not.toContain("emend-media");
    expect(out).not.toContain("/api/v1/media/");
  });

  test.each(["media/a.png?x#y", "./media/a.png", "media/a.png#frag", "media/%61.png"])("resolves %s", async (src) => {
    expect(await html(`<img src="${src}" alt="x">`)).toContain(`src="/api/v1/media/${shaA}"`);
  });

  test("strips event handlers and other attributes but still resolves", async () => {
    const out = await html('<img src="media/a.png" alt="A" onerror="alert(1)" style="x:y" srcset="evil 2x">');
    expect(out).toContain(`src="/api/v1/media/${shaA}"`);
    expect(out).not.toMatch(/onerror|style=|srcset|alert/);
  });

  test("keeps author classes prefixed so they cannot forge the generated ones", async () => {
    const out = await html(
      '<img src="media/a.png" class="emend-media" alt="x">\n\n<span class="emend-media emend-media-row">raw</span>\n\n<p class="emend-media-row">text</p>',
    );
    expect(out).toContain('class="user-content-emend-media"');
    expect(out).toContain('<span class="user-content-emend-media user-content-emend-media-row">raw</span>');
    expect(out).toContain('<p class="user-content-emend-media-row">text</p>');
    expect(out.match(/class="emend-media"/g)).toHaveLength(1);
  });

  test("keeps hostile neighbours inert next to a media image", async () => {
    const out = await html(
      '<script>alert(1)</script>\n\n<svg onload="x"><circle/></svg>\n\n[bad](javascript:alert(1)) ![ok](media/a.png)',
    );
    expect(out).not.toMatch(/<script|<svg|javascript:|onload/i);
    expect(out).toContain(`src="/api/v1/media/${shaA}"`);
  });

  test("resolves an image in a link and keeps the link hardened", async () => {
    const out = await html("[![Shot](media/a.png)](https://example.com/page)");
    expect(out).toContain('rel="noopener noreferrer nofollow"');
    expect(out).toContain(`src="/api/v1/media/${shaA}"`);
  });

  test.each([
    "https://example.com/x.png",
    `http://127.0.0.1:3636/api/v1/media/${shaA}`,
    `https://example.com/api/v1/media/${shaA}`,
    `/api/v1/media/${shaA}`,
  ])("drops the absolute image source %s even with media declared", async (src) => {
    const out = await html(`see ![Remote](${src})\n\n<img src="${src}" alt="raw">`);
    expect(out).not.toContain("src=");
    expect(out).not.toContain("emend-media");
  });

  test("still resolves a declared relative path next to dropped absolute sources", async () => {
    const out = await html("![a](https://example.com/x.png) ![b](media/a.png)");
    expect(out.match(/src=/g)).toHaveLength(1);
    expect(out).toContain(`src="/api/v1/media/${shaA}"`);
  });

  test("marks a paragraph of only images as a row, but not one with text", async () => {
    const two = await html("![Before](media/a.png) ![After](media/b.png)");
    expect(two).toContain('<p class="emend-media-row">');
    expect(two.match(/<span class="emend-media">/g)).toHaveLength(2);
    const mixed = await html("See ![Before](media/a.png) here");
    expect(mixed).not.toContain("emend-media-row");
    expect(mixed).toContain('<span class="emend-media">');
    const unresolved = await html("![Before](media/c.png)");
    expect(unresolved).not.toContain("emend-media-row");
  });

  test("changes the block id when the image hash changes and keeps it otherwise", async () => {
    const md = "![Before](media/a.png)";
    const first = (await render(md))[0]?.id;
    expect((await render(md))[0]?.id).toBe(first);
    const reshot = new Map(media).set("media/a.png", "d".repeat(64));
    expect((await render(md, reshot))[0]?.id).not.toBe(first);
    expect((await render("![After](media/a.png)"))[0]?.id).not.toBe(first);
    expect((await render("![Before](media/b.png)"))[0]?.id).not.toBe(first);
    expect(first).toMatch(/^overview-[0-9a-f]{8}$/);
  });
});

describe("renderWriteup media", () => {
  const topics: TopicMeta[] = [{ slug: "ui", title: "UI", importance: 1, summary: "UI." }];
  const writeup = {
    overview: "![Overview shot](media/a.png)",
    tldr: "No image.",
    decisions: null,
    glossary: "![Glossary shot](media/b.png)",
    topics: { ui: { why: "![Before](media/a.png) ![After](media/b.png)" } },
  } as WriteupInput;

  test("resolves images in every section, including the glossary", async () => {
    const rendered = await renderWriteup(writeup, topics, { media });
    const byKey = Object.fromEntries(rendered.sections.map((s) => [s.key, s.blocks.map((b) => b.html).join("")]));
    expect(byKey.overview).toContain(`/api/v1/media/${shaA}`);
    expect(byKey.glossary).toContain(`/api/v1/media/${shaB}`);
    expect(byKey["t-ui-why"]).toContain("emend-media-row");
    expect(byKey.tldr).not.toContain("<img");
  });

  test("resolves nothing without a media map", async () => {
    const rendered = await renderWriteup(writeup, topics);
    expect(JSON.stringify(rendered)).not.toContain("<img");
  });
});

describe("writeup media sizes", () => {
  const sizes = new Map([[shaA, { width: 640, height: 480 }]]);
  const withSizes = (md: string, map: ReadonlyMap<string, { width: number; height: number }> = sizes) =>
    renderMarkdownWithBudget(
      md,
      "overview",
      { highlightedBytes: 0 },
      undefined,
      media,
      undefined,
      "",
      undefined,
      map,
    ).then((blocks) => blocks.map((block) => block.html).join("\n"));

  test("emits the server's size after the other attributes", async () => {
    expect(await withSizes("![Before](media/a.png)")).toBe(
      `<p class="emend-media-row"><span class="emend-media"><img src="/api/v1/media/${shaA}" alt="Before" loading="lazy" decoding="async" width="640" height="480"><span class="emend-media-caption">Before</span></span></p>`,
    );
  });

  test("emits no size for an image the server could not read", async () => {
    const out = await withSizes("![Other](media/b.png)");
    expect(out).toContain("<img");
    expect(out).not.toMatch(/width|height/);
    expect(await html("![Before](media/a.png)")).not.toMatch(/width|height/);
  });

  test("drops author width and height, with and without server sizes", async () => {
    for (const md of [
      '<img src="media/a.png" width="9999" height="1">',
      '![x](media/a.png "t")\n\n<img src="media/a.png" height="7">',
    ]) {
      const plain = await html(md);
      expect(plain).not.toMatch(/width|height/);
      const sized = await withSizes(md);
      expect(sized.match(/width="640" height="480"/g)?.length).toBeGreaterThan(0);
      expect(sized).not.toMatch(/9999|height="1"|height="7"/);
    }
  });

  test.each([0, -1, 1.5, Number.NaN, 70000])("does not emit an invalid server size %s", async (side) => {
    const out = await withSizes("![x](media/a.png)", new Map([[shaA, { width: side, height: 10 }]]));
    expect(out).toContain("<img");
    expect(out).not.toMatch(/width|height/);
  });

  test("a non-media image keeps no source and gets no server size", async () => {
    const out = await withSizes(
      '<img src="media/c.png" alt="x" width="5">\n\n<img src="https://example.com/x.png" alt="y">',
    );
    expect(out).not.toMatch(/src=|height="480"|width="640"/);
  });

  test("hostile input stays inert while the declared image keeps its size", async () => {
    const hostile = [
      "<script>alert(1)</script>",
      '<img src="x" onerror="alert(1)">',
      "[bad](javascript:alert(1))",
      '<svg onload="x"><circle/></svg>',
      '<div style="x:y" onclick="z()">raw</div>',
    ].join("\n\n");
    const rendered = await renderWriteup(
      {
        overview: `${hostile}\n\n![Shot](media/a.png)`,
        tldr: "t",
        decisions: null,
        glossary: `${hostile}\n\n![Glossary](media/a.png)`,
        topics: {
          ui: {
            why: '```mermaid\nflowchart TD\n  A --> B\n  click A href "javascript:alert(1)"\n```\n\n![Why](media/a.png)',
          },
        },
      } as WriteupInput,
      [{ slug: "ui", title: "UI", importance: 1, summary: "UI." }],
      { media, mediaSizes: sizes },
    );
    for (const section of rendered.sections) {
      const out = section.blocks.map((b) => b.html).join("");
      expect(out).not.toMatch(/<script|<svg|\son\w+=|javascript:\s*alert/i);
      for (const style of out.matchAll(/ style="([^"]*)"/g))
        expect(style[1]).toMatch(/^(--shiki-[a-z]+:#?[\w(),. %-]+;?)+$/i);
    }
    const sized = rendered.sections.filter((s) => s.blocks.some((b) => b.html.includes("emend-media")));
    expect(sized.map((s) => s.key)).toEqual(expect.arrayContaining(["overview", "glossary"]));
    for (const section of sized)
      expect(section.blocks.map((b) => b.html).join("")).toContain('width="640" height="480"');
  });
});
