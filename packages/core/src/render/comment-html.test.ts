import { fromHtml } from "hast-util-from-html";
import type { Processor } from "unified";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderCommentHtml, renderMarkdown } from "./markdown.ts";

const { convert } = vi.hoisted(() => ({ convert: vi.fn() }));
vi.mock("remark-rehype", async (original) => {
  const module = await original<typeof import("remark-rehype")>();
  return {
    ...module,
    default: function (this: Processor, ...args: Parameters<typeof module.default>) {
      const transform = module.default.apply(this, args);
      return (tree: Parameters<typeof transform>[0], file: Parameters<typeof transform>[1]) => {
        convert(tree, file);
        return transform(tree, file);
      };
    },
  };
});
beforeEach(() => convert.mockClear());

const repo = "https://github.com/owner/name";

describe("comment Markdown", () => {
  test("renders bold, a list, inline code and a link with target and rel", async () => {
    const html = await renderCommentHtml("**Bold** and `code`\n\n- one\n- two\n\n[site](https://example.test/a)");
    expect(html).toContain("<strong>Bold</strong>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain('href="https://example.test/a"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  test("a fence stays plain code with no highlighting, and a mermaid fence is not a diagram", async () => {
    const fence = await renderCommentHtml("```ts\nconst a = 1;\n```");
    expect(fence).toContain("<pre><code");
    expect(fence).not.toMatch(/shiki|style=|<span/);
    const diagram = await renderCommentHtml("```mermaid\ngraph TD\n  A --> B\n```");
    expect(diagram).toContain("<pre><code");
    expect(diagram).toContain("graph TD");
    const source = '{"type":"bar","labels":["Day"],"series":[{"name":"Count","values":[2]}]}';
    const chart = await renderCommentHtml(`\`\`\`chart\n${source}\n\`\`\``);
    expect(chart).toContain("<pre><code");
    expect(chart).toContain(source);
    expect(chart).not.toContain("<svg");
  });

  test("a plain one-line comment is one paragraph", async () => {
    expect(await renderCommentHtml("Looks fine to me.")).toBe("<p>Looks fine to me.</p>");
  });

  test("a single newline in a paragraph is a line break", async () => {
    expect(await renderCommentHtml("line one\nline two")).toBe("<p>line one<br>\nline two</p>");
    expect(await renderCommentHtml("a **b\nc** d")).toBe("<p>a <strong>b<br>\nc</strong> d</p>");
  });

  test("a loose list, a nested list, a fence, inline code and raw HTML get no extra breaks", async () => {
    expect(await renderCommentHtml("- one\n\n- two")).not.toContain("<br");
    expect(await renderCommentHtml("- one\n  - nested\n- two")).not.toContain("<br");
    expect(await renderCommentHtml("1. a\n2. b\n\n   para\n   more")).toContain("para<br>\nmore");
    const fence = await renderCommentHtml("```\nline 1\nline 2\n```");
    expect(fence).not.toContain("<br");
    expect(fence).toContain("line 1\nline 2");
    expect(await renderCommentHtml("`a\nb`")).not.toContain("<br");
    expect(await renderCommentHtml("<span>a\nb</span>")).not.toContain("<br");
    expect(await renderCommentHtml("| a | b |\n| - | - |\n| 1 | 2 |")).not.toContain("<br");
  });

  test("CRLF and CR line endings give breaks and no stray carriage return", async () => {
    expect(await renderCommentHtml("one\r\ntwo\rthree")).toBe("<p>one<br>\ntwo<br>\nthree</p>");
    expect(await renderCommentHtml("# head\r\n\r\ntext")).not.toContain("\r");
  });

  test("references that resolve to too much URL text are rejected before conversion", async () => {
    const wide = `[a]: https://x.test/${"€".repeat(10_000)}\n\n${"[a] ".repeat(2500)}`;
    expect(wide.length).toBeLessThan(21_000);
    await expect(renderCommentHtml(wide)).rejects.toThrow("too much URL text");
    await expect(
      renderCommentHtml(`[a]: https://x.test/${"p".repeat(10_000)}\n\n${"![A] ".repeat(4)}`),
    ).rejects.toThrow();
    const titled = `[a]: http://x "${"t".repeat(20_000)}"\n\n${"[a] ".repeat(2500)}`;
    await expect(renderCommentHtml(titled)).rejects.toThrow("too much URL text");
    // The cost does not depend on which definition comes first: a later empty one must not hide the long one.
    const hidden = `[a]: https://x.test/${"€".repeat(9990)}\n\n${"[a] ".repeat(2495)}\n\n[a]: <>`;
    await expect(renderCommentHtml(hidden)).rejects.toThrow("too much URL text");
    expect(convert).not.toHaveBeenCalled();
    const smallTitle = `[a]: http://x "${"t".repeat(100)}"\n\n${"[a] ".repeat(50)}`;
    expect(await renderCommentHtml(smallTitle)).toContain("<a ");
    expect(convert).toHaveBeenCalledOnce();
    const fine = `[a]: https://x.test/${"p".repeat(200)}\n\n${"[a] ".repeat(50)}`;
    expect(await renderCommentHtml(fine)).toContain("<a ");
    // An unresolved reference costs nothing, and docs are not limited.
    expect(await renderCommentHtml("[nothing] ".repeat(5000))).toContain("[nothing]");
    const blocks = await renderMarkdown(`[a]: https://x.test/${"p".repeat(10_000)}\n\n${"[a] ".repeat(5)}`, "overview");
    expect(blocks.length).toBeGreaterThan(0);
  });

  test("an image in a comment keeps no src, even for a path the writeup declares", async () => {
    const html = await renderCommentHtml("![x](shot.png)", repo);
    expect(html).toContain("<img");
    expect(html).not.toContain("src=");
    expect(html).not.toContain("/api/v1/media/");
  });

  test("docs fold a single newline as before", async () => {
    const blocks = await renderMarkdown("line one\nline two", "overview");
    expect(blocks.map((block) => block.html).join("")).not.toContain("<br");
  });

  test("links #123 only with a repoUrl, and never in code", async () => {
    expect(await renderCommentHtml("See #123")).not.toContain("<a ");
    const linked = await renderCommentHtml("See #123 and `#124`", repo);
    expect(linked).toContain(`href="${repo}/issues/123"`);
    expect(linked).not.toContain("issues/124");
  });
});

const hostile = [
  "<script>alert(1)</script>",
  '<img src=x onerror="alert(1)">',
  "[x](javascript:alert(1))",
  "[x](data:text/html,<script>alert(1)</script>)",
  "[x](vbscript:alert(1))",
  '<a href="javascript:alert(1)">y</a>',
  '<svg onload="alert(1)"><circle/></svg>',
  '<iframe src="https://example.test"></iframe>',
  '<p style="position:fixed;inset:0">cover</p>',
  '<div onclick="alert(1)" id="x" class="y" data-a="b">raw</div>',
  '<form action="https://example.test"><button>go</button></form>',
  '```mermaid\nflowchart LR\n  A --> B\n  click A href "javascript:alert(1)"\n```',
  "<style>body{display:none}</style>",
  "<object data=x></object><embed src=x>",
  "![x](javascript:alert(1))",
  "&lt;script&gt;alert(1)&lt;/script&gt;",
];

describe("hostile comment input", () => {
  test.each(hostile)("is inert: %j", async (source) => {
    const html = await renderCommentHtml(source, repo);
    const check = (node: ReturnType<typeof fromHtml> | ReturnType<typeof fromHtml>["children"][number]) => {
      if (node.type === "element") {
        expect(node.tagName).not.toMatch(/^(script|style|iframe|object|embed|form|button|svg|math)$/i);
        for (const [key, value] of Object.entries(node.properties)) {
          expect(key).not.toMatch(/^(on|data|style)/i);
          if (key === "href") expect(String(value)).toMatch(/^(https?:|mailto:)/i);
          if (key === "src") expect(String(value)).toMatch(/^https?:/i);
          if (key === "id" || key === "name") expect(String(value)).toMatch(/^user-content-/);
        }
      }
      if ("children" in node) for (const child of node.children) check(child);
    };
    check(fromHtml(html, { fragment: true }));
    // Text inside a code block is inert, so a Mermaid `click` directive may keep its words there.
    expect(html.replace(/<pre>[\s\S]*?<\/pre>/g, "")).not.toMatch(/javascript:|vbscript:|data:text/i);
  });
});
