import { fromHtml } from "hast-util-from-html";
import { describe, expect, test, vi } from "vitest";
import { blockText, visitElements } from "./blocks.ts";
import { blockHash } from "./hash.ts";
import { renderMarkdown } from "./markdown.ts";
import { normalizeText } from "./normalize.ts";
import { sanitizeSchema } from "./sanitize.ts";

type Node = ReturnType<typeof fromHtml> | ReturnType<typeof fromHtml>["children"][number];

function assertInert(html: string) {
  const visit = (node: Node) => {
    if (node.type === "element") {
      expect(node.tagName).not.toMatch(/^(script|style|iframe|object|embed|form|button|svg)$/i);
      for (const [key, value] of Object.entries(node.properties)) {
        expect(key).not.toMatch(/^(on|data)/i);
        if (["href", "src", "cite", "longDesc"].includes(key)) {
          expect(String(value)).toMatch(key === "href" ? /^(https?:|mailto:)/i : /^https?:/i);
        }
        if (key === "style") {
          expect(node.tagName).toBe("span");
          for (const declaration of String(value).split(";").filter(Boolean)) {
            expect(declaration).toMatch(
              /^(?:color:var\(--(?:syn-(?:plain|keyword|type|function|string|number|comment|punct)|diff-(?:add|del)-fg)\)|font-style:italic|font-weight:bold)$/,
            );
          }
        }
      }
    }
    if ("children" in node) for (const child of node.children) visit(child);
  };
  visit(fromHtml(html, { fragment: true }));
}

async function render(md: string) {
  const blocks = await renderMarkdown(md, "overview");
  for (const block of blocks) assertInert(block.html);
  return blocks;
}

describe("hostile author content", () => {
  test("note refs keep only namespaced class and text, stripping author controls", async () => {
    const blocks = await render(
      '<span class="ref" onclick="alert(1)" data-x="forged" data-agent-note-ref="forged">ref A</span>',
    );
    expect(blocks[0]?.html).toContain('<span class="user-content-ref">ref A</span>');
    expect(blocks[0]?.html).not.toMatch(/onclick|data-x|data-agent-note-ref|role=|tabindex=/);
  });
  test("the sanitizer tag allowlist excludes active and parser-sensitive elements", () => {
    const forbidden = [
      "script",
      "style",
      "iframe",
      "object",
      "embed",
      "form",
      "svg",
      "math",
      "noscript",
      "template",
      "textarea",
      "title",
      "xmp",
      "plaintext",
      "noembed",
      "select",
      "base",
      "meta",
      "link",
    ];
    expect(sanitizeSchema.tagNames?.filter((tag) => forbidden.includes(tag))).toEqual([]);
  });

  test("the noscript parser payload produces no image or event handler", async () => {
    const blocks = await render('<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>');
    for (const block of blocks) {
      visitElements(fromHtml(block.html, { fragment: true }), (element) => {
        expect(element.tagName).not.toBe("img");
        expect(Object.keys(element.properties).some((key) => /^onerror$/i.test(key))).toBe(false);
      });
    }
  });

  test.each([
    ["image event", 'before <img src=x onerror="window.__pwn=1"> after', "before  after"],
    [
      "raw script and style",
      '<div onclick="window.__pwn=1"><script>window.__pwn=1</script><style>body{}</style>block</div>',
      "block",
    ],
    ["author style", '<div style="position:fixed;inset:0">cover</div>', "cover"],
    ["inline code", "`<img onerror=x>`", "<img onerror=x>"],
    ["entity attack", '<p><a href="jav&#x61;script:window.__pwn=1">bad</a></p>', "bad"],
    ["control attack", '<p><a href="java&#10;script:window.__pwn=1">bad</a></p>', "bad"],
  ])("keeps useful text inert: %s", async (_name, md, text) => {
    const blocks = await render(md);
    expect(blocks.map((block) => block.text).join("")).toBe(text);
    expect(blocks.length).toBeGreaterThan(0);
  });

  test.each([
    "[bad](javascript:window.__pwn=1)",
    "[x](javascript:alert(1))",
    '<a href="javascript:window.__pwn=1">bad</a>',
    "[bad](data:text/html,hello)",
    '<a href="vbscript:msgbox(1)">bad</a>',
    "[rel](./other.md)",
    "[proto](//example.com)",
    "[root](/api/v1/sends)",
    "[fragment](#sendButton)",
    "[ftp](ftp://example.com)",
    "[scheme-relative-path](http:other.md)",
    '<a href="http:/api/v1/sends">local</a>',
    '<a href="https:">empty</a>',
    '<a href="&#9;https://example.com">spaced</a>',
  ])("removes unsafe and relative hrefs: %s", async (md) => {
    const blocks = await render(md);
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.map((block) => block.html).join("")).not.toMatch(/\shref=/);
  });

  test.each([
    "<script>window.__pwn=1</script>",
    '<form action="/api/v1/sends"><button>go</button></form>',
    "<svg><script>window.__pwn=1</script></svg>",
    '<iframe src="https://example.com"></iframe>',
    '<object data="https://example.com"><embed src="https://example.com"></object>',
  ])("drops active elements: %s", async (md) => {
    const blocks = await render(`${md}\n\nSafe paragraph.`);
    expect(blocks.map((block) => block.html).join("")).not.toContain("window.__pwn");
    expect(blocks.at(-1)?.text).toBe("Safe paragraph.");
  });

  test("namespaces every author class, id and name and removes data attributes", async () => {
    const blocks = await render(
      '<div class="send-bar thread-card" id="top" data-thread-id="t1" data-start-line="1">x</div>',
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.html).toContain('class="user-content-send-bar user-content-thread-card"');
    expect(blocks[0]?.html).toContain('id="user-content-top"');
    expect((await render('<a name="spot">a</a>'))[0]?.html).toContain('name="user-content-spot"');
    expect((await render('<p id="x" data-foo="bar">x</p>'))[0]?.html).toContain('id="user-content-x"');
  });

  test("drops all author id references instead of pointing at app controls", async () => {
    const blocks = await render(
      '<label for="sendButton">l</label><span aria-labelledby="a b" aria-controls="d" aria-owns="e" aria-describedby="c">s</span><table><tbody><tr><td headers="h1 h2">t</td></tr></tbody></table><img src="https://example.com/x.png" usemap="#m"><input list="choices">',
    );
    const html = blocks.map((block) => block.html).join("");
    expect(html).not.toMatch(
      /\s(?:for|list|headers|usemap|aria-labelledby|aria-describedby|aria-controls|aria-owns)=/i,
    );
  });

  test("hardens external links and drops every image source without declared media", async () => {
    const blocks = await render(
      "[ext](https://example.com) [http](http://example.com) [mail](mailto:reader@example.com) ![safe](https://example.com/x.png) ![bad](mailto:reader@example.com) ![relative](./image.png) ![data](data:image/png;base64,AAAA)",
    );
    const html = blocks.map((block) => block.html).join("");
    expect(html.match(/rel="noopener noreferrer nofollow"/g)).toHaveLength(3);
    expect(html).not.toContain("src=");
  });

  test("drops alternate URL attributes and ignores forged renderer metadata", async () => {
    const blocks = await render(
      '<p><img src="https://example.com/x.png" longdesc="/api/v1/sends"><a href="https://example.com" data-emend-classes="send-bar" data-emend-diagram="evil">link</a></p><blockquote cite="/api/v1/sends">quote</blockquote>',
    );
    expect(blocks.every((block) => block.kind !== "diagram")).toBe(true);
    expect(blocks.map((block) => block.html).join("")).not.toMatch(/longdesc=|cite=|class="send-bar"/);
  });
});

test("splits top-level semantic blocks, keeps nested lists together, and skips rules", async () => {
  const blocks = await render(
    "# Heading\n\nParagraph with ~~old~~ text.\n\n- Parent\n  - Nested\n- Next\n\n```unknown-synthetic\ncode\n```\n\n| Key | Value |\n| --- | --- |\n| a | b |\n\n> Quoted\n>\n> Another paragraph\n\n---",
  );
  expect(blocks.map((block) => block.kind)).toEqual(["heading", "paragraph", "item", "item", "code", "table", "quote"]);
  expect(blocks[2]?.html).toContain("<ul>");
  expect(blocks[2]?.text).toContain("Nested");
  expect(blocks[3]?.text).toBe("Next");
  expect(blocks[6]?.html.match(/<p>/g)).toHaveLength(2);
  for (const block of blocks) expect(block.text).toBe(blockText(block.html));
  expect(await render("\n---\n\n<!-- comment -->\n\n<script>bad</script>")).toEqual([]);
});

test("keeps ordered list start values and task items disabled", async () => {
  const ordered = await render("3. Third\n4. Fourth");
  expect(ordered[0]?.html).toContain('<ol start="3">');
  expect(ordered[1]?.html).toContain('<ol start="4">');
  const tasks = await render("- [x] Done\n- [ ] Pending");
  expect(tasks).toHaveLength(2);
  expect(tasks[0]?.html).toContain("disabled");
  expect(tasks[0]?.html).toContain("user-content-task-list-item");
});

test("Shiki uses syntax CSS variables and works with WebAssembly disabled", async () => {
  vi.stubGlobal("WebAssembly", undefined);
  try {
    // A fresh module ensures this also covers first-time engine initialization.
    vi.resetModules();
    const { renderMarkdown: freshRender } = await import("./markdown.ts");
    const markdown = '<p style="color:red">Author</p>\n\n```ts\nconst count: number = 2;\n```';
    const blocks = await freshRender(markdown, "overview");
    expect(blocks[0]?.html).not.toContain("style=");
    expect(blocks[1]?.html).toContain("shiki");
    expect(blocks[1]?.html).toContain("color:var(--syn-keyword)");
    expect(blocks[1]?.html).not.toMatch(/<pre[^>]*style=|--shiki-/);
    for (const block of blocks) assertInert(block.html);
    // Warm the grammar before asserting late tokens; cold scans can exhaust the per-line limit under load.
    const warmBlocks = await freshRender(markdown, "overview");
    expect(warmBlocks[1]?.html).toContain("color:var(--syn-number)");
    for (const block of warmBlocks) assertInert(block.html);
  } finally {
    vi.unstubAllGlobals();
  }
});

test.each(["ts", "tsx", "js", "jsx", "json", "css", "html", "md", "yaml", "sh", "go", "py", "sql", "diff"])(
  "highlights the bundled %s language",
  async (language) => {
    expect((await render(`\`\`\`${language}\nconst value = 1\n\`\`\``))[0]?.html).toContain("shiki");
  },
);

test("unknown and unlabelled code fences stay plain and escaped", async () => {
  for (const language of ["unknown-synthetic", "", "constructor", "__proto__"]) {
    const blocks = await render(`\`\`\`${language}\n<img onerror=x>\n\`\`\``);
    expect(blocks[0]?.kind).toBe("code");
    expect(blocks[0]?.html).not.toMatch(/style=|<img/);
    expect(blocks[0]?.text).toBe("<img onerror=x>\n");
  }
});

test("Mermaid is a whole diagram, never HTML, and its id hashes its source", async () => {
  const source = "graph TD; A-->B; click A callback\n%% <script>bad</script>";
  const blocks = await render(`\`\`\`mermaid\n${source}\n\`\`\``);
  expect(blocks).toHaveLength(1);
  expect(blocks[0]).toMatchObject({ kind: "diagram", source, html: "", text: source });
  expect(blocks[0]?.id).toBe(`overview-${await blockHash(normalizeText(source))}`);
});

test("nested and empty Mermaid fences stay separate from containing HTML", async () => {
  const blocks = await render("- A diagram\n\n  ```mermaid\n  graph TD; A-->B\n  ```\n\n```mermaid\n```");
  expect(blocks.map((block) => block.kind)).toEqual(["item", "diagram", "diagram"]);
  expect(blocks[0]?.html).not.toContain("graph TD");
  expect(blocks[1]).toMatchObject({ source: "graph TD; A-->B", html: "" });
  expect(blocks[2]).toMatchObject({ source: "", html: "" });
});

test("a hostile class value cannot escape the serialized attribute", async () => {
  const blocks = await render('<p class="send-bar&#34;&#32;onclick=evil">safe</p>');
  expect(blocks[0]?.text).toBe("safe");
  expect(blocks[0]?.html).toContain("user-content-");
});

test("concurrent renders keep duplicate counters and diagram metadata local", async () => {
  const [first, second] = await Promise.all([
    render("Same\n\nSame\n\n```mermaid\ngraph TD; A-->B\n```"),
    render("Same\n\nSame\n\n```ts\nconst value = 1\n```"),
  ]);
  expect(first.slice(0, 2).map((block) => block.id)).toEqual(second.slice(0, 2).map((block) => block.id));
  expect(first[2]?.kind).toBe("diagram");
  expect(second[2]?.kind).toBe("code");
});

test("image references come from the same sanitized tree as rendering", async () => {
  const { markdownImageReferences } = await import("./markdown.ts");
  expect(
    markdownImageReferences(
      [
        "![inline](shots/a.png)",
        "![reference][shot]\n\n[shot]: shots/b.png",
        '<img src="shots/c.png" onerror="bad()">',
        "[![linked](shots/d.png)](https://example.com)",
        "| Shot |\n| --- |\n| ![table](shots/e.png) |",
        "Foot[^1].\n\n[^1]: ![note](shots/f.png)",
        '<script src="script.png"></script>',
        '<svg><image href="svg.png"/></svg>',
        '<iframe src="frame.png"></iframe>',
        '<template><img src="hidden.png"></template>',
        "![bad](javascript:alert) ![data](data:image/png;base64,AAAA)",
      ].join("\n\n"),
    ),
  ).toEqual({
    references: ["shots/a.png", "shots/b.png", "shots/c.png", "shots/d.png", "shots/e.png", "shots/f.png"],
    capped: false,
  });
});

test("image discovery returns distinct UTF-8 references in first-seen order", async () => {
  const { markdownImageReferences } = await import("./markdown.ts");
  const markdown =
    "![One][a] ![Again][a] <img src='二.png'> ![Too large][b] ![Later](c.png)\n\n[a]: a.png\n[b]: long-name.png";
  expect(markdownImageReferences(markdown)).toEqual({
    references: ["a.png", "二.png", "long-name.png", "c.png"],
    capped: false,
  });
  expect(markdownImageReferences(`${"![a][r] ".repeat(1000)}\n\n[r]: shot.png`)).toEqual({
    references: ["shot.png"],
    capped: false,
  });
});

test("image discovery stops before expanded references exceed the Markdown byte limit", async () => {
  const { markdownImageReferences } = await import("./markdown.ts");
  // UTF-8 URL encoding expands this sub-limit source past the one-MiB result budget.
  const markdown = `![First](first.png) ![Large](${"é".repeat(180000)}.png) ![Later](later.png)`;
  expect(markdownImageReferences(markdown)).toEqual({ references: ["first.png"], capped: true });
});

test.each([
  "<script>alert(1)</script>",
  '<img src=x onerror="alert(1)">',
  '<a href="javascript:alert(1)">link</a>',
  '<div style="color:red" onclick="alert(1)">raw HTML</div>',
  '<svg onload="alert(1)"><script>alert(1)</script></svg>',
  'graph TD; A-->B; click A "javascript:alert(1)"',
])("code fences keep hostile content as text: %s", async (payload) => {
  const blocks = await render(`\`\`\`html\n${payload}\n\`\`\`\n\n${payload}`);
  expect(blocks[0]?.text).toBe(`${payload}\n`);
  expect(blocks[0]?.html).toContain('class="shiki');
  expect(blocks[0]?.html).not.toMatch(/<pre[^>]*style=/);
});

test("code spans preserve the theme's italic and bold styles", async () => {
  const markdown = "```ts\n// comment\n```\n\n```md\n# Heading\n**bold** *italic*\n```";
  // Warm both grammars so cold scans under load do not cut the line short before its italic token.
  await render(markdown);
  const blocks = await render(markdown);
  expect(blocks[0]?.html).toContain("font-style:italic");
  expect(blocks[1]?.html).toContain("font-weight:bold");
  expect(blocks[1]?.html).toContain("font-style:italic");
});

const chartSource = JSON.stringify({
  type: "bar",
  title: "<script>alert(1)</script>",
  unit: "<x>",
  labels: ["<img src=x onerror=alert(1)>", "javascript:alert(1)"],
  series: [{ name: "<svg onload=alert(1)>", values: [2, 1] }],
});

test("a chart fence and raw code element keep the exact source outside block HTML", async () => {
  const escaped = chartSource.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  for (const markdown of [
    `\`\`\`chart\n${chartSource}\n\`\`\``,
    `<pre><code class="language-chart">${escaped}</code></pre>`,
  ]) {
    const blocks = await render(markdown);
    expect(blocks).toMatchObject([
      {
        id: `overview-${await blockHash(normalizeText(chartSource))}`,
        kind: "chart",
        source: chartSource,
        text: chartSource,
        html: "",
      },
    ]);
  }
  const both = await render(`<pre><code class="language-chart language-mermaid">${escaped}</code></pre>`);
  expect(both).toMatchObject([{ kind: "diagram", source: chartSource }]);
});

test.each([chartSource.slice(1), chartSource.replace("[2,1]", "[2,-1]")])(
  "invalid chart source stays visible as escaped code (%#)",
  async (source) => {
    const blocks = await render(`\`\`\`chart\n${source}\n\`\`\``);
    expect(blocks).toMatchObject([{ kind: "code" }]);
    const html = blocks[0]?.html ?? "";
    expect(html).toContain("<code");
    expect(html).not.toMatch(/<(script|img|svg)/i);
    expect(blockText(html)).toBe(`${source}\n`);
  },
);

test("a chart in a list splits the item around the source", async () => {
  const blocks = await render(`- Start\n\n  \`\`\`chart\n  ${chartSource}\n  \`\`\`\n\n  End`);
  expect(blocks.map(({ kind }) => kind)).toEqual(["item", "chart", "item"]);
  expect(blocks[1]).toMatchObject({ source: chartSource, html: "" });
  expect(blocks.map(({ html }) => html).join("")).not.toMatch(/<script|onerror|onload|<svg/i);
});

test("an empty chart spec still shows a code block", async () => {
  const blocks = await render("```chart\n```");
  expect(blocks).toMatchObject([{ kind: "code" }]);
  expect(blocks[0]?.html).toContain("<pre><code");
});
