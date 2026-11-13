import type { RenderedBlock, RenderedWriteup, TopicMeta } from "@emend/contract";
import { fromHtml } from "hast-util-from-html";
import { toString as hastText } from "hast-util-to-string";
import { expect, test, vi } from "vitest";
import type { HtmlElement as Element, HtmlRoot as Root } from "./blocks.ts";
import {
  buildDocDownload,
  buildHtmlDocDownload,
  buildWriteupDownload,
  DOWNLOAD_FILE_CSP,
  type ResolveResult,
} from "./download.ts";

const sha = "a".repeat(64);
const details = { project: "Sample", branch: "feature", seq: 2, publishedAt: "2026-01-02T23:00:00Z", links: [] };
const png = { mediaType: "image/png", bytes: new Uint8Array([1, 2, 3]) };
const block = (html: string): RenderedBlock => ({
  id: "overview-12345678",
  section: "overview",
  kind: "paragraph",
  html,
  text: "sample",
});
const writeup = (blocks: RenderedBlock[]): RenderedWriteup => ({
  sections: [{ key: "overview", label: "Overview <script>", topic: null, blocks }],
});
function elements(node: Root | Element): Element[] {
  return node.children.flatMap((child) => (child.type === "element" ? [child, ...elements(child)] : []));
}
function parsed(html: string) {
  return elements(fromHtml(html));
}
const render = (blocks: RenderedBlock[], resolveMedia: (hash: string) => Promise<ResolveResult> = async () => png) =>
  buildWriteupDownload({ title: "Review <script>", details, writeup: writeup(blocks), topics: [], resolveMedia });
const imageBlock = block(
  `<span><img src="/api/v1/media/${sha}"><span class="emend-media-caption">A caption</span></span>`,
);
function expectHead(html: string) {
  const head = parsed(html).find((el) => el.tagName === "head");
  expect(head?.children.slice(0, 3)).toMatchObject([
    { tagName: "meta", properties: { charSet: "utf-8" } },
    { tagName: "meta", properties: { httpEquiv: ["Content-Security-Policy"], content: DOWNLOAD_FILE_CSP } },
    { tagName: "meta", properties: { name: "referrer", content: "no-referrer" } },
  ]);
}

test("puts charset and the offline CSP before all other head elements", async () => {
  expectHead(await render([]));
  expectHead(
    await buildHtmlDocDownload({
      html: "<style>p{color:red}</style><head><title>Doc</title></head><body>Doc</body>",
      docPath: "doc.html",
      title: "Fallback",
      resolveAsset: async () => null,
    }),
  );
});

test("escapes titles and labels and builds in a media image with its caption", async () => {
  const resolve = vi.fn(async () => png);
  const html = await render([imageBlock, imageBlock], resolve);
  expect(parsed(html).some((el) => el.tagName === "script")).toBe(false);
  expect(hastText(fromHtml(html))).toContain("Review <script>");
  expect(hastText(fromHtml(html))).toContain("Overview <script>");
  expect(html).toContain("data:image/png;base64,AQID");
  expect(html).toContain("A caption");
  expect(html).toContain("Sample · feature · Revision 2 · 2026-01-02");
  expect(resolve).toHaveBeenCalledExactlyOnceWith(sha);
  for (const path of ["/api/v1/", "/content/", "?tab=", "/r/"]) expect(html).not.toContain(path);
});

test("removes unresolved images but keeps captions without a size note", async () => {
  const html = await render([imageBlock], async () => null);
  expect(parsed(html).some((el) => el.tagName === "img")).toBe(false);
  expect(html).toContain("A caption");
  expect(parsed(html).filter((el) => el.properties.className?.toString() === "em-download-note")).toHaveLength(0);
});

test("leaves oversized images out with one visible note at the top", async () => {
  const html = await render([imageBlock, imageBlock], async () => "too-large");
  expect(parsed(html).some((el) => el.tagName === "img")).toBe(false);
  const notes = parsed(html).filter((el) => el.properties.className?.toString() === "em-download-note");
  expect(notes).toHaveLength(1);
  expect(hastText(notes[0] as Element)).toBe(
    "Some images or files were left out because the download would pass 128 MiB.",
  );
});

test("turns doc links into plain text and preserves absolute web links with rel", async () => {
  const html = await render([
    block('<a href="?tab=docs&doc=plan.md">Plan</a><a href="https://example.com" target="_blank" download>Web</a>'),
  ]);
  const links = parsed(html).filter((el) => el.tagName === "a");
  expect(links).toHaveLength(1);
  expect(links[0]?.properties).toMatchObject({
    href: "https://example.com",
    rel: ["noopener", "noreferrer", "nofollow"],
  });
  expect(links[0]?.properties).not.toHaveProperty("target");
  expect(links[0]?.properties).not.toHaveProperty("download");
  expect(html).toContain('<span class="em-doc-link">Plan</span>');
});

test("shows Mermaid as escaped source in a labelled figure", async () => {
  const source = 'graph TD; A["<script>"] --> B; click A "https://example.com"';
  const html = await render([{ ...block(""), kind: "diagram", source }]);
  const figure = parsed(html).find((el) => el.tagName === "figure");
  expect(hastText(figure as Element)).toBe(`Mermaid diagram${source}`);
  expect(parsed(html).some((el) => ["script", "iframe"].includes(el.tagName))).toBe(false);
});

test("renders the ranked Topics list and written Why Example and Details sections", async () => {
  const topics: TopicMeta[] = [
    {
      slug: "second",
      title: "Second",
      summary: "First in review order",
      importance: 10,
      blastRadius: { scope: "module", note: "One module" },
    },
    { slug: "first", title: "First", summary: "Unwritten", importance: 20 },
    { slug: "other", title: "Other changes", summary: "Other", importance: 100 },
  ];
  const html = await buildWriteupDownload({
    title: "Topics",
    details,
    topics,
    resolveMedia: async () => null,
    writeup: {
      sections: [
        { key: "decisions", label: "Decisions and drift", topic: null, blocks: [] },
        ...(["why", "example", "body"] as const).map((kind) => ({
          key: `t-second-${kind}` as const,
          label: "stored",
          topic: "second",
          blocks: [block(`<p>${kind}</p>`)],
        })),
      ],
    },
  });
  const nodes = parsed(html);
  expect(nodes.filter((el) => el.tagName === "h2").map((node) => hastText(node))).toEqual([
    "Decisions & drift",
    "Topics",
    "Second",
  ]);
  expect(nodes.filter((el) => el.tagName === "h3").map((node) => hastText(node))).toEqual([
    "Why",
    "Example",
    "Details",
  ]);
  expect(nodes.filter((el) => el.tagName === "a").map((el) => el.properties.href)).toEqual(["#topic-second"]);
  expect(html).toContain("Blast radius: <strong>module</strong> — One module");
  expect(html).not.toContain("Other changes");
});

test("drops active hostile block HTML and unsafe style URLs", async () => {
  const html = await render([
    block(
      '<script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)">X</a><iframe>bad</iframe><svg><script>alert(2)</script></svg><span onclick="bad()" style="background:URL(x)">Y</span>',
    ),
  ]);
  for (const el of parsed(html)) {
    expect(["script", "iframe"]).not.toContain(el.tagName);
    for (const [key, value] of Object.entries(el.properties)) {
      expect(key).not.toMatch(/^on/i);
      expect(String(value)).not.toMatch(/^javascript:/i);
    }
  }
});

test("uses the same page frame for Markdown and escaped source tokens", async () => {
  const markdown = await buildDocDownload({
    title: "Doc",
    details,
    content: { kind: "markdown", blocks: [block("<p>Stored Markdown</p>")] },
    resolveMedia: async () => null,
  });
  expectHead(markdown);
  expect(markdown).toContain("Stored Markdown");
  const source = await buildDocDownload({
    title: "Source",
    details,
    content: {
      kind: "source",
      lines: [
        [
          { text: "<script>", light: "#123456", dark: "#abcdef" },
          { text: "bad colour", light: "red;url(x)" },
        ],
        [{ text: "line 2" }],
      ],
    },
    resolveMedia: async () => null,
  });
  expectHead(source);
  expect(source).toContain('style="--shiki-light:#123456;--shiki-dark:#abcdef"');
  expect(source).not.toContain("red;url");
  expect(parsed(source).some((el) => el.tagName === "script")).toBe(false);
  expect(hastText(parsed(source).find((el) => el.tagName === "pre") as Element)).toBe("<script>bad colour\nline 2");
});

const css = (value: string) => ({ mediaType: "text/css", bytes: new TextEncoder().encode(value) });
function htmlDoc(html: string, assets: Record<string, ResolveResult> = {}) {
  const resolveAsset = vi.fn(async (path: string) => assets[path] ?? null);
  return {
    resolveAsset,
    result: buildHtmlDocDownload({ html, docPath: "docs/index.html", title: "Fallback", resolveAsset }),
  };
}

test("removes HTML scripts handlers frames embeds templates base and author policy metas", async () => {
  const { result, resolveAsset } = htmlDoc(
    '<head><meta charset="latin1"><meta http-equiv="refresh" content="0;url=https://evil.example"><meta http-equiv="Content-Security-Policy" content="default-src *"><base href="https://evil.example"></head><body onclick="bad()"><script>alert(1)</script><script src="app.js"></script><iframe src="x"></iframe><object data="x"></object><embed src="x"><template><img src="hidden.png"></template><svg><script>alert(2)</script></svg><img src="app.js"><form action="https://example.com" method="post"></form></body>',
  );
  const html = await result;
  expectHead(html);
  for (const el of parsed(html)) {
    expect(["script", "iframe", "object", "embed", "template", "base"]).not.toContain(el.tagName);
    for (const key of Object.keys(el.properties)) expect(key).not.toMatch(/^(on|action$|method$)/i);
  }
  expect(parsed(html).filter((el) => el.tagName === "meta" && el.properties.httpEquiv)).toHaveLength(1);
  expect(resolveAsset).toHaveBeenCalledExactlyOnceWith("docs/app.js");
  expect(html).not.toContain("alert(");
});

test("inlines listed CSS and images relative to their own files and preserves srcset descriptors", async () => {
  const { result, resolveAsset } = htmlDoc(
    '<link rel="stylesheet" href="css/site.css" media="screen"><img src="img/a.png" srcset="img/a.png 1x, img/b.png 2x"><style>p{background:url(img/a.png)}</style><div style="background:url(img/a.png)"></div>',
    {
      "docs/css/site.css": css("body{background:url(../img/bg.png)}"),
      "docs/img/bg.png": png,
      "docs/img/a.png": png,
      "docs/img/b.png": png,
    },
  );
  const html = await result;
  expect(html).toContain('media="screen"');
  expect(html).toContain('url("data:image/png;base64,AQID")');
  expect(html).toContain('srcset="data:image/png;base64,AQID 1x, data:image/png;base64,AQID 2x"');
  expect(resolveAsset.mock.calls.map(([path]) => path).sort()).toEqual([
    "docs/css/site.css",
    "docs/img/a.png",
    "docs/img/b.png",
    "docs/img/bg.png",
  ]);
});

test("drops external resources and doc links while keeping web links and fragments", async () => {
  const { result, resolveAsset } = htmlDoc(
    '<img src="https://example.com/x.png"><link rel="stylesheet" href="https://cdn.example/x.css"><link rel="preload" href="local.png"><a href="other.html">Other</a><a href="https://example.com">Web</a><a href="#sec">Section</a><svg><use href="https://example.com/s.svg#a"/><image href="data:image/png;base64,AQID"/></svg>',
  );
  const nodes = parsed(await result);
  expect(nodes.filter((el) => el.tagName === "link")).toHaveLength(0);
  expect(
    nodes.filter((el) => ["img", "use"].includes(el.tagName)).every((el) => !el.properties.src && !el.properties.href),
  ).toBe(true);
  expect(nodes.filter((el) => el.tagName === "a").map((el) => el.properties.href)).toEqual([
    undefined,
    "https://example.com",
    "#sec",
  ]);
  expect(resolveAsset).not.toHaveBeenCalled();
});

test("prevents inlined CSS from closing style elements", async () => {
  const { result } = htmlDoc('<link rel="stylesheet" href="site.css">', {
    "docs/site.css": css("</style><script>alert(1)</script>"),
  });
  const html = await result;
  expect(parsed(html).some((el) => el.tagName === "script")).toBe(false);
  expect(html).toContain("\\3c /style>");
});

test("inlines imports with their own base and stops cycles depth and unresolved imports", async () => {
  const { result, resolveAsset } = htmlDoc(
    '<style>@import "css/more.css" screen; @import url(missing.css); p{background:url(https://example.com/x)} b{mask:url(#mask)} i{background:url(data:image/png;base64,AQID)}</style>',
    {
      "docs/css/more.css": css('@import "more.css"; @import "two.css"; p{background:url(../img/a.png)}'),
      "docs/css/two.css": css('@import "three.css"; .two{color:red}'),
      "docs/css/three.css": css('@import "four.css";'),
      "docs/css/four.css": css('@import "five.css"; .four{color:red}'),
      "docs/css/five.css": css(".five{color:red}"),
      "docs/img/a.png": png,
    },
  );
  const html = await result;
  expect(html).not.toContain("@import");
  expect(html).toContain(".two");
  expect(html).toContain(".four");
  expect(html).not.toContain(".five");
  expect(html).toContain('url("data:,")');
  expect(html).toContain("url(#mask)");
  expect(html).toContain("url(data:image/png;base64,AQID)");
  expect(resolveAsset.mock.calls.filter(([path]) => path === "docs/css/more.css")).toHaveLength(1);
});

test("rejects malformed encoded paths schemes and script asset types", async () => {
  const { result, resolveAsset } = htmlDoc(
    '<img src="%2foutside.png"><img src="%5coutside.png"><img src="%00.png"><img src="%zz"><img src="//example.com/a"><img src="blob:x"><img src="app.js"><img src="/root/a%20b.png?x#y">',
    {
      "docs/app.js": { mediaType: "text/javascript", bytes: new TextEncoder().encode("bad()") },
      "root/a b.png": png,
    },
  );
  const html = await result;
  expect(parsed(html).filter((el) => el.tagName === "img" && el.properties.src)).toHaveLength(1);
  expect(resolveAsset.mock.calls.map(([path]) => path)).toEqual(["docs/app.js", "root/a b.png"]);
});

test("puts one size note first in an HTML doc body", async () => {
  const { result } = htmlDoc('<body><img src="a.png"><img src="b.png"></body>', {
    "docs/a.png": "too-large",
    "docs/b.png": "too-large",
  });
  const body = parsed(await result).find((el) => el.tagName === "body");
  expect(body?.children[0]).toMatchObject({ tagName: "p", properties: { className: ["em-download-note"] } });
  expect(body?.children.filter((el) => el.type === "element" && el.tagName === "p")).toHaveLength(1);
});

test("keeps safe publish links with visible hosts and omits null metadata", async () => {
  const html = await buildWriteupDownload({
    title: "Links",
    details: {
      ...details,
      project: null,
      branch: null,
      links: [
        { label: "Issue <one>", url: "https://example.com/issue" },
        { label: "Unsafe", url: "https://user:pass@example.com/" },
        { label: "Plain HTTP", url: "http://example.com/" },
      ],
    },
    writeup: writeup([]),
    topics: [],
    resolveMedia: async () => null,
  });
  expect(parsed(html).filter((el) => el.tagName === "a")).toHaveLength(1);
  expect(hastText(fromHtml(html))).toContain("Issue <one>example.com");
  expect(html).toContain("Revision 2 · 2026-01-02");
  expect(html).not.toContain("Unsafe");
  expect(html).not.toContain("Plain HTTP");
});

test("never resolves assets for script elements", async () => {
  const { result, resolveAsset } = htmlDoc('<script src="app.js"></script><svg><script href="app.js"/></svg>');
  expect(parsed(await result).some((el) => el.tagName === "script")).toBe(false);
  expect(resolveAsset).not.toHaveBeenCalled();
});

test("inlines quoted CSS imports whose paths contain parentheses", async () => {
  const { result } = htmlDoc(
    '<style>@import url("css/more(1).css") layer(example) supports(display:grid) screen;</style>',
    {
      "docs/css/more(1).css": css("p{color:green}"),
    },
  );
  expect(await result).toContain("p{color:green}");
});

test("removes noscript elements and their meta refresh contents", async () => {
  const { result } = htmlDoc(
    '<noscript><meta http-equiv="refresh" content="0;url=https://example.com"><img src="https://example.com/a.png"></noscript>',
  );
  const nodes = elements(fromHtml(await result));
  expect(nodes.some((el) => el.tagName === "noscript")).toBe(false);
  expect(nodes.filter((el) => el.tagName === "meta" && el.properties.httpEquiv)).toHaveLength(1);
  expect(nodes.some((el) => el.properties.src === "https://example.com/a.png")).toBe(false);
});

test("rewrites SVG media and font assets and keeps only permitted resource attributes", async () => {
  const { result } = htmlDoc(
    '<style>@font-face{src:url(font.woff2)}</style><svg><image xlink:href="img/a.png"/><use xlink:href="https://example.com/icon.svg#x"/><use href="#x"/><a xlink:href="other.html">Other</a></svg><video src="movie.mp4" poster="img/a.png"><source srcset="https://example.com/no.png 1x, img/a.png 2x"><track src="captions.vtt"></video><audio src="sound.mp3"></audio><input type="image" src="img/a.png"><div data="blob:x"></div>',
    {
      "docs/font.woff2": { mediaType: "font/woff2", bytes: new Uint8Array([1]) },
      "docs/img/a.png": png,
      "docs/movie.mp4": { mediaType: "video/mp4", bytes: new Uint8Array([2]) },
      "docs/sound.mp3": { mediaType: "audio/mpeg", bytes: new Uint8Array([3]) },
      "docs/captions.vtt": { mediaType: "text/vtt", bytes: new Uint8Array([4]) },
    },
  );
  const html = await result;
  expect(html).toContain("data:font/woff2;base64,AQ==");
  expect(html).toContain('xlink:href="data:image/png;base64,AQID"');
  expect(html).toContain('href="#x"');
  expect(html).not.toContain("https://example.com");
  expect(html).not.toContain("other.html");
  expect(html).not.toContain("blob:x");
  expect(html).toContain("data:video/mp4;base64,Ag==");
  expect(html).toContain("data:audio/mpeg;base64,Aw==");
  expect(html).toContain("data:text/vtt;base64,BA==");
});

test("limits every repeated image copy in writeup and Markdown downloads", async () => {
  const asset = { mediaType: "image/png", bytes: new Uint8Array(1024) };
  const inlineBudget = 3000;
  const resolveMedia = vi.fn(async () => asset);
  const blocks = Array.from({ length: 20 }, () => imageBlock);
  for (const html of [
    await buildWriteupDownload({
      title: "Budget",
      details,
      writeup: writeup(blocks),
      topics: [],
      resolveMedia,
      inlineBudget,
    }),
    await buildDocDownload({
      title: "Budget",
      details,
      content: { kind: "markdown", blocks },
      resolveMedia,
      inlineBudget,
    }),
  ]) {
    expect(parsed(html).filter((el) => el.tagName === "img")).toHaveLength(2);
    expect(html.match(/Some images or files were left out/g)).toHaveLength(1);
    expect(new TextEncoder().encode(html).length).toBeLessThan(inlineBudget + 8000);
  }
});

test("budgets repeated HTML resource URLs and stylesheets at every emission", async () => {
  const stylesheet = "p{color:green}".repeat(100);
  const html = await buildHtmlDocDownload({
    html: Array.from({ length: 20 }, (_, index) => `<link rel="stylesheet" href="${index}.css">`).join(""),
    docPath: "doc.html",
    title: "Budget",
    inlineBudget: stylesheet.length,
    resolveAsset: async () => css(stylesheet),
  });
  expect(parsed(html).filter((el) => el.tagName === "style")).toHaveLength(1);
  expect(html.match(/Some images or files were left out/g)).toHaveLength(1);
  expect(html.length).toBeLessThan(stylesheet.length + 1000);
  const images = await buildHtmlDocDownload({
    html: '<img src="a.png">'.repeat(20),
    docPath: "doc.html",
    title: "Budget",
    inlineBudget: 26,
    resolveAsset: async () => png,
  });
  expect(parsed(images).filter((el) => el.properties.src)).toHaveLength(1);
  expect(images).toContain("Some images or files were left out");
});

test("replaces over-budget CSS URLs and drops over-budget imported CSS", async () => {
  const html = await buildHtmlDocDownload({
    html: '<style>p{background:url(a.png)}@import "big.css";</style>',
    docPath: "doc.html",
    title: "Budget",
    inlineBudget: 100,
    resolveAsset: async (path) =>
      path === "a.png" ? { mediaType: "image/png", bytes: new Uint8Array(1024) } : css("p{color:green}".repeat(100)),
  });
  expect(html).toContain('url("data:,")');
  expect(html).not.toContain("color:green");
  expect(html).toContain("Some images or files were left out");
});

const encodedPayload =
  '&lt;meta http-equiv="refresh" content="0;url=https://evil.example/"&gt;&lt;img src=x onerror=alert(1)&gt;&lt;script&gt;alert(1)&lt;/script&gt;';
test.each([
  ["SVG style", `<svg><style>${encodedPayload}</style></svg>`],
  ["MathML style", `<math><style>${encodedPayload}</style></math>`],
  [
    "MathML integration point",
    "<math><mtext><table><mglyph><style>&lt;img src=x onerror=alert(1)&gt;</style></mglyph></table></mtext></math>",
  ],
  ["SVG parser repair", '<svg></p><style><a id="</style><img src=1 onerror=alert(1)>">'],
])("keeps %s CSS inert after serialization and reparsing", async (_label, input) => {
  const html = await htmlDoc(input).result;
  for (const el of parsed(html)) {
    expect(el.tagName).not.toBe("script");
    if (el.tagName === "meta" && el.properties.httpEquiv) expect(el.properties.content).toBe(DOWNLOAD_FILE_CSP);
    for (const key of Object.keys(el.properties)) expect(key).not.toMatch(/^on/i);
  }
});

test("applies link rules only to anchors and areas and resource rules to all other hrefs", async () => {
  const html = await htmlDoc(
    '<html manifest="offline.appcache"><body background="https://evil.example/x.png"><map><area href="other.html"><area href="https://example.com"></map><svg><a xlink:href="javascript:alert(1)">X</a><pattern href="https://example.com/p.svg"/><linearGradient xlink:href="https://example.com/g.svg"/><textPath href="https://example.com/t.svg"/><pattern href="icon.svg#x"/></svg><math><mi href="https://example.com">x</mi><mi href="other.html">y</mi><mi href="#local">z</mi></math></body></html>',
    { "docs/icon.svg": { mediaType: "image/svg+xml", bytes: new Uint8Array([1]) } },
  ).result;
  const nodes = parsed(html);
  expect(nodes.find((el) => el.tagName === "html")?.properties).not.toHaveProperty("manifest");
  expect(nodes.find((el) => el.tagName === "body")?.properties).not.toHaveProperty("background");
  expect(nodes.filter((el) => el.tagName === "area").map((el) => el.properties.href)).toEqual([
    undefined,
    "https://example.com",
  ]);
  expect(nodes.filter((el) => el.tagName === "mi").map((el) => el.properties.href)).toEqual([
    undefined,
    undefined,
    "#local",
  ]);
  for (const el of nodes.filter((el) => el.properties.href === "https://example.com"))
    expect(el.properties.rel).toEqual(["noopener", "noreferrer", "nofollow"]);
  expect(
    nodes
      .filter((el) => ["a", "linearGradient", "textPath"].includes(el.tagName))
      .every((el) => !el.properties.href && !el.properties.xLinkHref),
  ).toBe(true);
  expect(nodes.filter((el) => el.tagName === "pattern").map((el) => el.properties.href)).toEqual([
    undefined,
    "data:image/svg+xml;base64,AQ==#x",
  ]);
});

test("preserves import media layer and supports conditions and removes charsets", async () => {
  const html = await htmlDoc(
    '<style>@charset "utf-8"; @import "print.css" print; @import "layer.css" layer; @import url(supports.css) layer(report) supports(display:grid) screen and (min-width: 10px);</style>',
    {
      "docs/print.css": css('@charset "utf-8";p{display:none}'),
      "docs/layer.css": css("p{display:none}"),
      "docs/supports.css": css("p{display:none}"),
    },
  ).result;
  expect(html).toContain("@media print { p{display:none} }");
  expect(html).toContain("@layer { p{display:none} }");
  expect(html).toContain(
    "@layer report { @supports (display:grid) { @media screen and (min-width: 10px) { p{display:none} } } }",
  );
  expect(html).not.toContain("@charset");
});

test("ends malformed import preludes at a block and rewrites the following rule", async () => {
  const { result, resolveAsset } = htmlDoc(
    '<style>@import "a.css" x{}body{background:url(https://evil.example/x.png)};</style>',
    { "docs/a.css": css("p{color:green}") },
  );
  const html = await result;
  expect(html).toContain('{}body{background:url("data:,")}');
  expect(html).not.toContain("https://evil.example");
  expect(html).not.toContain("@import");
  expect(html).not.toContain("p{color:green}");
  expect(resolveAsset).not.toHaveBeenCalled();
});

test.each([
  "url(https://evil.example/y)",
  "supports(background:URL(https://evil.example/y))",
  'supports(background:IMAGE-SET("https://evil.example/y" 1x))',
  "supports(--value: {invalid})",
  "screen}",
  "\\73 creen",
])("drops imports with unsafe conditions %s and still rewrites following URLs", async (conditions) => {
  const { result, resolveAsset } = htmlDoc(
    `<style>@import "a.css" ${conditions};body{background:url(https://evil.example/x.png)}</style>`,
    { "docs/a.css": css("p{color:green}") },
  );
  const html = await result;
  expect(html).toContain('<style>body{background:url("data:,")}</style>');
  expect(html).not.toContain("https://evil.example");
  expect(html).not.toContain("@import");
  expect(html).not.toContain("p{color:green}");
  expect(resolveAsset).not.toHaveBeenCalled();
});

test("applies resource rules to src on MathML and unknown elements in every namespace", async () => {
  const { result, resolveAsset } = htmlDoc(
    '<math><mglyph src="https://evil.example/g.png"/><mglyph src="glyph.png"/></math><custom-element src="https://evil.example/g.png"></custom-element><custom-element src="glyph.png"></custom-element><svg><custom-svg src="https://evil.example/g.png"/><custom-svg src="glyph.png"/></svg>',
    { "docs/glyph.png": png },
  );
  const html = await result;
  const nodes = parsed(html);
  for (const tag of ["mglyph", "custom-element", "custom-svg"])
    expect(nodes.filter((el) => el.tagName === tag).map((el) => el.properties.src)).toEqual([
      undefined,
      "data:image/png;base64,AQID",
    ]);
  expect(html).not.toContain("https://evil.example");
  expect(resolveAsset).toHaveBeenCalledExactlyOnceWith("docs/glyph.png");
});

test.each(["image-set", "-webkit-image-set"])("rewrites every quoted string and URL in %s arguments", async (fn) => {
  const html = await htmlDoc(
    `<style>p{background:${fn}("a.png" 1x type("image/png"), url(b.png) 2x, 'https://example.com/c.png' 3x)}</style>`,
    { "docs/a.png": png, "docs/b.png": png },
  ).result;
  expect(html).toContain(
    `${fn}("data:image/png;base64,AQID" 1x type("data:,"), url("data:image/png;base64,AQID") 2x, "data:," 3x)`,
  );
});

test("keeps author media data URLs across resource attributes and srcset candidates", async () => {
  const uri = "data:image/png;base64,AQID";
  const html = await htmlDoc(
    `<body background="${uri}"><img src="${uri}" srcset="${uri} 1x, data:text/html,bad 2x, ${uri} 3x"><img src="data:text/html,bad"><video src="data:VIDEO/mp4;base64,AQID" poster="${uri}"><track src="data:text/vtt,captions"></video><audio src="data:audio/mpeg;base64,AQID"></audio><svg><image href="${uri}"/><pattern xlink:href="${uri}"/></svg></body>`,
  ).result;
  const nodes = parsed(html);
  expect(nodes.filter((el) => el.tagName === "img").map((el) => el.properties.src)).toEqual([uri, undefined]);
  expect(nodes.find((el) => el.tagName === "img")?.properties.srcSet).toBe(`${uri} 1x, ${uri} 3x`);
  expect(nodes.find((el) => el.tagName === "body")?.properties.background).toBe(uri);
  expect(nodes.find((el) => el.tagName === "video")?.properties.poster).toBe(uri);
  expect(nodes.find((el) => el.tagName === "track")?.properties.src).toBe("data:text/vtt,captions");
  expect(nodes.find((el) => el.tagName === "image")?.properties.href).toBe(uri);
  expect(nodes.find((el) => el.tagName === "pattern")?.properties.xLinkHref).toBe(uri);
});

test("counts retained author data URLs against the inline budget", async () => {
  const html = await buildHtmlDocDownload({
    html: '<img src="data:image/png;base64,AQID">'.repeat(20),
    title: "Budget",
    docPath: "doc.html",
    inlineBudget: 26,
    resolveAsset: async () => null,
  });
  expect(parsed(html).filter((el) => el.properties.src)).toHaveLength(1);
  expect(html).toContain("Some images or files were left out");
});

test("preserves the original fragments on built-in HTML and CSS asset references", async () => {
  const asset = { mediaType: "image/svg+xml", bytes: new Uint8Array([1]) };
  const { result, resolveAsset } = htmlDoc(
    '<svg><image href="icons.svg#check"/></svg><style>p{filter:url(icons.svg?theme=dark#bl%75r)}</style>',
    { "docs/icons.svg": asset },
  );
  const html = await result;
  expect(html).toContain('href="data:image/svg+xml;base64,AQ==#check"');
  expect(html).toContain('url("data:image/svg+xml;base64,AQ==#bl%75r")');
  expect(resolveAsset).toHaveBeenCalledExactlyOnceWith("docs/icons.svg");
});

test("resolves quoted image-set candidates after CSS comments", async () => {
  const html = await htmlDoc('<style>p{background:image-set(/* preview */ "a.png" 1x)}</style>', {
    "docs/a.png": png,
  }).result;
  expect(html).toContain('image-set(/* preview */ "data:image/png;base64,AQID" 1x)');
});

test("bounds a repeated import tree to 64 stylesheet occurrences with a size note", async () => {
  const assets: Record<string, ResolveResult> = {};
  for (let level = 0; level < 4; level++) {
    const imports = level < 3 ? `@import "level-${level + 1}.css";`.repeat(24) : "";
    assets[`docs/level-${level}.css`] = css(`${imports}.level-${level}{color:green}`);
  }
  const { result, resolveAsset } = htmlDoc(
    '<style>@import "level-0.css";@import "level-0.css";</style><link rel="stylesheet" href="level-0.css"><link rel="stylesheet" href="level-1.css">',
    assets,
  );
  const html = await result;
  expect(html.match(/\.level-\d\{/g)).toHaveLength(64);
  expect(parsed(html).filter((el) => el.tagName === "style")).toHaveLength(1);
  expect(resolveAsset).toHaveBeenCalledTimes(4);
  expect(html).not.toContain("@import");
  expect(html.match(/Some images or files were left out/g)).toHaveLength(1);
  expect(html.length).toBeLessThan(4000);
});

test("inlines repeated stylesheet links and imports with their own media and layer conditions", async () => {
  const { result, resolveAsset } = htmlDoc(
    '<link rel="stylesheet" href="shared.css" media="print"><link rel="stylesheet" href="shared.css" media="screen"><style>@import "shared.css" layer(ui);</style>',
    { "docs/shared.css": css("p{color:green}") },
  );
  const html = await result;
  const styles = parsed(html).filter((el) => el.tagName === "style");
  expect(styles.map((el) => el.properties.media)).toEqual(["print", "screen", undefined]);
  expect(styles.map((el) => hastText(el))).toEqual([
    "p{color:green}",
    "p{color:green}",
    "@layer ui { p{color:green} }",
  ]);
  expect(resolveAsset).toHaveBeenCalledExactlyOnceWith("docs/shared.css");
  expect(html).not.toContain("Some images or files were left out");
});

test("caps inlined stylesheets at 64 across links and imports with one visible note", async () => {
  const assets: Record<string, ResolveResult> = {};
  const links: string[] = [];
  const imports: string[] = [];
  for (let index = 0; index < 66; index++) {
    assets[`docs/sheet-${index}.css`] = css(`.sheet-${index}{color:green}`);
    if (index < 32) links.push(`<link rel="stylesheet" href="sheet-${index}.css">`);
    else imports.push(`@import "sheet-${index}.css";`);
  }
  const { result, resolveAsset } = htmlDoc(`${links.join("")}<style>${imports.join("")}</style>`, assets);
  const html = await result;
  for (let index = 0; index < 64; index++) expect(html).toContain(`.sheet-${index}{`);
  expect(html).not.toContain(".sheet-64{");
  expect(html).not.toContain(".sheet-65{");
  expect(html.match(/Some images or files were left out/g)).toHaveLength(1);
  expect(resolveAsset).toHaveBeenCalledTimes(64);
});

test("unwraps nested forms without activating style contents after reparsing", async () => {
  const html = await htmlDoc(
    '<form><math><mtext></form><form><mglyph><style></math><meta http-equiv="refresh" content="0;url=https://evil.example/"><img src=x onerror=alert(1)></style></mglyph></form></mtext></math></form>',
  ).result;
  for (const el of parsed(html)) {
    expect(["form", "script"]).not.toContain(el.tagName);
    if (el.tagName === "meta" && el.properties.httpEquiv) expect(el.properties.content).toBe(DOWNLOAD_FILE_CSP);
    for (const key of Object.keys(el.properties)) expect(key).not.toMatch(/^on/i);
  }
});

test("preserves sanitized form children when unwrapping forms", async () => {
  const html = await htmlDoc(
    '<form action="https://example.com" method="post"><p>Offline text</p><input onclick="bad()"><script>bad()</script></form>',
  ).result;
  expect(html).toContain("<p>Offline text</p>");
  expect(parsed(html).some((el) => el.tagName === "input")).toBe(true);
  expect(parsed(html).some((el) => ["form", "script"].includes(el.tagName))).toBe(false);
  expect(html).not.toContain("onclick");
});

test("keeps only absolute web links and fragments on image map areas", async () => {
  const { result, resolveAsset } = htmlDoc(
    '<map name=m><area href="//attacker.example/share/x"><area href="other-doc.html"><area href="javascript:alert(1)"><area href="https://example.com/x"><area href="#top"></map>',
  );
  const areas = parsed(await result).filter((el) => el.tagName === "area");
  expect(areas.map((el) => el.properties.href)).toEqual([
    undefined,
    undefined,
    undefined,
    "https://example.com/x",
    "#top",
  ]);
  expect(areas[3]?.properties.rel).toEqual(["noopener", "noreferrer", "nofollow"]);
  expect(resolveAsset).not.toHaveBeenCalled();
});

test("removes protocol-relative anchor hrefs in HTML docs", async () => {
  const { result, resolveAsset } = htmlDoc('<a href="//attacker.example/x">External text</a>');
  const anchor = parsed(await result).find((el) => el.tagName === "a");
  expect(anchor?.properties).not.toHaveProperty("href");
  expect(anchor && hastText(anchor)).toBe("External text");
  expect(resolveAsset).not.toHaveBeenCalled();
});

test("turns protocol-relative writeup links into plain text", async () => {
  const html = await render([block('<a href="//attacker.example/x">External text</a>')]);
  expect(parsed(html).some((el) => el.tagName === "a")).toBe(false);
  const span = parsed(html).find((el) => el.properties.className?.toString() === "em-doc-link");
  expect(span && hastText(span)).toBe("External text");
  expect(html).not.toContain("//attacker.example");
});

test("replaces 2000 nested image-set openers and 100 KB of filler with none within 10 seconds", async () => {
  const start = Date.now();
  const { result, resolveAsset } = htmlDoc(
    `<style>i{background:${"image-set(".repeat(2000)}${"x".repeat(100_000)}${")".repeat(2000)}}p{color:green}</style>`,
  );
  const html = await result;
  expect(Date.now() - start).toBeLessThan(10_000);
  expect(html).toContain("<style>i{background:none}p{color:green}</style>");
  expect(resolveAsset).not.toHaveBeenCalled();
}, 15_000);

test("rewrites 5000 image-set rules within 10 seconds and resolves each candidate path once", async () => {
  const start = Date.now();
  const { result, resolveAsset } = htmlDoc(
    `<style>${'i{background:image-set("missing.png" 1x)}'.repeat(5000)}</style>`,
  );
  const html = await result;
  expect(Date.now() - start).toBeLessThan(10_000);
  expect(html).toContain(`<style>${'i{background:image-set("data:," 1x)}'.repeat(5000)}</style>`);
  expect(resolveAsset).toHaveBeenCalledExactlyOnceWith("docs/missing.png");
}, 15_000);

test("preserves image-set asset fragments and author data URLs while charging every copy", async () => {
  const uri = "data:image/png;base64,AQID";
  const resolveAsset = vi.fn(async () => png);
  const source = `i{background:image-set("a.png#part" 1x, url(a.png#part) 2x, "${uri}" 3x)}`;
  const html = await buildHtmlDocDownload({
    html: `<style>${source}</style>`,
    title: "Budget",
    docPath: "doc.html",
    resolveAsset,
  });
  expect(html).toContain(`image-set("${uri}#part" 1x, url("${uri}#part") 2x, "${uri}" 3x)`);
  expect(resolveAsset).toHaveBeenCalledExactlyOnceWith("a.png");
  const largeUri = `data:image/png;base64,${"A".repeat(1024)}`;
  const limited = await buildHtmlDocDownload({
    html: `<style>${`i{background:image-set("${largeUri}" 1x)}`.repeat(5)}</style>`,
    title: "Budget",
    docPath: "doc.html",
    inlineBudget: 2400,
    resolveAsset,
  });
  expect(limited.match(/data:image\/png/g)).toHaveLength(2);
  expect(limited).toContain('image-set("data:," 1x)');
  expect(limited).toContain("Some images or files were left out");
});

test("keeps CSS less-than and less-than-or-equal range comparisons intact", async () => {
  const source = "@media (width < 600px){p{color:green}}@media (width <= 600px){p{color:red}}";
  const html = await htmlDoc(`<style>${source}</style>`).result;
  expect(html).toContain(`<style>${source}</style>`);
});

test("escapes HTML token openers in CSS without creating elements on reparse", async () => {
  const payload = '<meta http-equiv="refresh" content="0;url=https://evil.example/"></style><!-- --><?x></p>';
  const html = await htmlDoc('<link rel="stylesheet" href="site.css">', { "docs/site.css": css(payload) }).result;
  for (const opener of ["meta", "/style", "!--", "?x", "/p"]) expect(html).toContain(`\\3c ${opener}`);
  const nodes = parsed(html);
  expect(nodes.some((el) => ["p", "script", "img"].includes(el.tagName))).toBe(false);
  expect(nodes.filter((el) => el.tagName === "meta" && el.properties.httpEquiv)).toMatchObject([
    { properties: { httpEquiv: ["Content-Security-Policy"], content: DOWNLOAD_FILE_CSP } },
  ]);
  const styles = nodes.filter((el) => el.tagName === "style");
  expect(styles).toHaveLength(1);
  expect(styles[0]?.children.every((node) => node.type === "text")).toBe(true);
});

test("inlines listed SVG images inside MathML annotation-xml and removes remote hrefs", async () => {
  const { result, resolveAsset } = htmlDoc(
    '<math><annotation-xml><svg><image href="chart.png"/><image href="https://evil.example/x.png"/></svg></annotation-xml><mi href="https://example.com/">x</mi></math>',
    { "docs/chart.png": png },
  );
  const nodes = parsed(await result);
  expect(nodes.filter((el) => el.tagName === "image").map((el) => el.properties.href)).toEqual([
    "data:image/png;base64,AQID",
    undefined,
  ]);
  expect(nodes.find((el) => el.tagName === "mi")?.properties).not.toHaveProperty("href");
  expect(resolveAsset).toHaveBeenCalledExactlyOnceWith("docs/chart.png");
});

test("ignores comments between import conditions when building wrappers", async () => {
  const html = await htmlDoc('<style>@import "a.css" layer(ui) /* note */ supports(display:grid);</style>', {
    "docs/a.css": css("p{color:green}"),
  }).result;
  expect(html).toContain("@layer ui { @supports (display:grid) { p{color:green} } }");
  expect(html).not.toContain("@media");
});

test("keeps rules after an import with an unmatched closing parenthesis", async () => {
  const html = await htmlDoc('<style>@import "missing.css"); p{color:green}</style>').result;
  expect(html).toContain("p{color:green}");
  expect(html).not.toContain("@import");
});

test.each(["element", "attribute"])(
  "rewrites 8 MiB of adversarial CSS in a style %s within 15 seconds",
  async (placement) => {
    const nested = `i{background:${"image-set(".repeat(3000)}"nested.png"${")".repeat(3000)}}`;
    const rules = 'i{background:image-set("missing.png" 1x)}'.repeat(5000);
    const strings = `i{background:image-set(${'"missing.png" '.repeat(5000)}1x)}`;
    const unterminated = `"a${'\\"'.repeat(40_000)}`;
    const prefix = nested + rules + strings;
    const filler = "x".repeat(8 * 1024 * 1024 - prefix.length - unterminated.length - 4);
    const source = `${prefix}/*${filler}*/${unterminated}`;
    const input = placement === "element" ? `<style>${source}</style>` : `<div style='${source}'></div>`;
    const start = Date.now();
    const { result, resolveAsset } = htmlDoc(input);
    const html = await result;
    expect(Date.now() - start).toBeLessThan(15_000);
    expect(html).toContain("background:none");
    expect(html).not.toContain("nested.png");
    expect(html.match(/data:,/g)).toHaveLength(10_000);
    expect(resolveAsset).toHaveBeenCalledExactlyOnceWith("docs/missing.png");
  },
  20_000,
);

test.each(['"', "'"])("keeps unterminated %s strings with a final escape in one token", async (quote) => {
  const source = `${quote}a${`\\${quote}`.repeat(40_000)}\\`;
  const { result, resolveAsset } = htmlDoc(`<style>${source}</style>`);
  const html = await result;
  expect(html).toContain(`<style>${source}</style>`);
  expect(resolveAsset).not.toHaveBeenCalled();
});

test("keeps commas inside data srcset payloads and trims only trailing separators", async () => {
  const uri = `data:image/png,${",".repeat(40_000)}tail`;
  const { result, resolveAsset } = htmlDoc(`<img srcset="${uri}, a.png 2x">`, { "docs/a.png": png });
  const img = parsed(await result).find((el) => el.tagName === "img");
  expect(img?.properties.srcSet).toBe(`${uri}, data:image/png;base64,AQID 2x`);
  expect(resolveAsset).toHaveBeenCalledExactlyOnceWith("docs/a.png");
});

test("removes SMIL elements that would give an SVG anchor a link target", async () => {
  const html = await htmlDoc(
    '<svg><a><set attributeName="href" to="//attacker.example/share"/><animate attributeName="xlink:href" values="other-doc.html"/><text y="20">click</text></a></svg>',
  ).result;
  const nodes = parsed(html);
  expect(nodes.some((el) => ["set", "animate"].includes(el.tagName))).toBe(false);
  const anchor = nodes.find((el) => el.tagName === "a");
  expect(anchor?.properties).not.toHaveProperty("href");
  expect(anchor?.properties).not.toHaveProperty("xLinkHref");
  expect(anchor && hastText(anchor)).toBe("click");
});

test.each(["set", "animate", "animateMotion", "animateTransform"])(
  "removes %s href changes after normalizing attributeName and preserves unrelated animation",
  async (tag) => {
    const html = await htmlDoc(
      `<svg><${tag} attributeName=" XLINK:HREF " to="https://example.com"/><${tag} attributeName="x" to="20"/></svg>`,
    ).result;
    const animations = parsed(html).filter((el) => el.tagName.toLowerCase() === tag.toLowerCase());
    expect(animations).toHaveLength(1);
    expect(animations[0]?.properties.attributeName).toBe("x");
  },
);

test.each(["href", "xlink:href"])("keeps only same-document fragments on SVG use %s", async (attribute) => {
  const { result, resolveAsset } = htmlDoc(
    `<svg><use ${attribute}="s.svg#icon"/><use ${attribute}="data:image/svg+xml,%3Csvg%3E%3C/svg%3E#x"/><use ${attribute}="#local"/></svg>`,
    { "docs/s.svg": { mediaType: "image/svg+xml", bytes: new TextEncoder().encode("<svg/>") } },
  );
  const property = attribute === "href" ? "href" : "xLinkHref";
  expect(
    parsed(await result)
      .filter((el) => el.tagName === "use")
      .map((el) => el.properties[property]),
  ).toEqual([undefined, undefined, "#local"]);
  expect(resolveAsset).not.toHaveBeenCalled();
});

test.each(["asset", "author data URL"])(
  "charges each CSS %s once so seven copies fit just as in images",
  async (kind) => {
    const uri = `data:image/png;base64,${"A".repeat(133_336)}`;
    const reference = kind === "asset" ? "a.png" : uri;
    for (const input of [
      `<style>${`i{background:url("${reference}")}`.repeat(10)}</style>`,
      `<img src="${reference}">`.repeat(10),
    ]) {
      const resolveAsset = vi.fn(async () => ({ mediaType: "image/png", bytes: new Uint8Array(100_000) }));
      const html = await buildHtmlDocDownload({
        html: input,
        title: "Budget",
        docPath: "doc.html",
        inlineBudget: 1_000_000,
        resolveAsset,
      });
      expect(html.match(/data:image\/png/g)).toHaveLength(7);
      expect(html).toContain("Some images or files were left out");
      expect(html.length).toBeLessThan(1_001_000);
      expect(resolveAsset).toHaveBeenCalledTimes(kind === "asset" ? 1 : 0);
    }
  },
);

test.each(["imports", "links"])(
  "bounds discarded 4 MiB CSS repeated through 64 %s to the work budget within 15 seconds",
  async (kind) => {
    const mib = 1024 * 1024;
    const suffix = ".large{color:green}";
    const stylesheet = `/*${"x".repeat(4 * mib - suffix.length - 4)}*/${suffix}`;
    const imports = '@import "large.css";'.repeat(64);
    const input =
      kind === "imports" ? `<style>${imports}</style>` : '<link rel="stylesheet" href="large.css">'.repeat(64);
    const pause = vi.fn(async () => {});
    const asset = css(stylesheet);
    const resolveAsset = vi.fn(async () => asset);
    const start = Date.now();
    const html = await buildHtmlDocDownload({
      html: `${input}<style>.late{color:red}</style><p style="color:red">Kept text</p>`,
      docPath: "doc.html",
      title: "Work budget",
      resolveAsset,
      inlineBudget: 4 * mib - 1,
      pause,
    });
    expect(Date.now() - start).toBeLessThan(15_000);
    expect(html).not.toContain(".large");
    expect(html).not.toContain(".late");
    expect(html).not.toContain('style="color:red"');
    expect(html).toContain("Kept text");
    expect(html.match(/Some images or files were left out/g)).toHaveLength(1);
    expect(html.length).toBeLessThan(2000);
    expect(resolveAsset).toHaveBeenCalledExactlyOnceWith("large.css");
    expect(pause).toHaveBeenCalledTimes(kind === "imports" ? 60 : 64);
  },
  20_000,
);

test.each(["writeup", "markdown", "html"])(
  "pauses every 1000 repeated references in a %s download and never for a tiny one",
  async (kind) => {
    for (const count of [1, 2000]) {
      const pause = vi.fn(async () => {});
      const resolve = vi.fn(async () => png);
      const blocks = [block(`<img src="/api/v1/media/${sha}">`.repeat(count))];
      const input = { title: "References", details, resolveMedia: resolve, pause };
      const html =
        kind === "writeup"
          ? await buildWriteupDownload({ ...input, writeup: writeup(blocks), topics: [] })
          : kind === "markdown"
            ? await buildDocDownload({ ...input, content: { kind: "markdown", blocks } })
            : await buildHtmlDocDownload({
                html: '<img src="a.png">'.repeat(count),
                title: "References",
                docPath: "doc.html",
                resolveAsset: resolve,
                pause,
              });
      expect(html.match(/data:image\/png/g)).toHaveLength(count);
      expect(pause).toHaveBeenCalledTimes(Math.floor(count / 1000));
      expect(resolve).toHaveBeenCalledTimes(1);
    }
  },
);

test("pauses for each MiB of UTF-8 CSS across style elements and attributes", async () => {
  const source = `/*${"é".repeat((1024 * 1024 - 4) / 2)}*/`;
  const pause = vi.fn(async () => {});
  const html = await buildHtmlDocDownload({
    html: `<style>${source}</style><div style="${source}"></div>`,
    title: "CSS progress",
    docPath: "doc.html",
    resolveAsset: async () => null,
    pause,
  });
  expect(html).toContain(source);
  expect(pause).toHaveBeenCalledTimes(2);
  pause.mockClear();
  await buildHtmlDocDownload({
    html: '<style>p{color:green}</style><div style="color:red"></div>',
    title: "Small CSS",
    docPath: "doc.html",
    resolveAsset: async () => null,
    pause,
  });
  await buildDocDownload({
    title: "Small source",
    details,
    resolveMedia: async () => null,
    content: { kind: "source", lines: [[{ text: "source text" }]] },
    pause,
  });
  expect(pause).not.toHaveBeenCalled();
});
