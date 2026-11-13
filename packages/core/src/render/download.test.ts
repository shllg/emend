import type { RenderedBlock, RenderedWriteup, TopicMeta } from "@emend/contract";
import { fromHtml } from "hast-util-from-html";
import { toString as hastText } from "hast-util-to-string";
import { expect, test, vi } from "vitest";
import type { HtmlElement as Element, HtmlRoot as Root } from "./blocks.ts";
import {
  buildDocDownload,
  buildHtmlDocDownload,
  buildOmittedDownload,
  buildWriteupDownload,
  createDownloadWork,
  DOWNLOAD_FILE_CSP,
  type ResolveResult,
} from "./download.ts";
import { checkDownloadCss, cssTokenize } from "./download-css.ts";

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
  return elements(fromHtml(html.replace(/^\uFEFF/, "")));
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
    "Some content was left out of this download because it passed a size or processing limit.",
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
  expect(html).toContain("< /style>");
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
  expect(html).toContain('url("#mask")');
  expect(html).toContain('url("data:image/png;base64,AQID")');
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
    expect(html.match(/Some content was left out/g)).toHaveLength(1);
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
  expect(html.match(/Some content was left out/g)).toHaveLength(1);
  expect(html.length).toBeLessThan(stylesheet.length + 1000);
  const images = await buildHtmlDocDownload({
    html: '<img src="a.png">'.repeat(20),
    docPath: "doc.html",
    title: "Budget",
    inlineBudget: 26,
    resolveAsset: async () => png,
  });
  expect(parsed(images).filter((el) => el.properties.src)).toHaveLength(1);
  expect(images).toContain("Some content was left out");
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
  expect(html).toContain("Some content was left out");
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
    undefined,
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
  expect(html).toContain("@media print { /**//**/p{display:none} }");
  expect(html).toContain("@layer { p{display:none} }");
  expect(html).toContain(
    "@layer report { @supports (display:grid) { @media screen and (min-width: 10px) { p{display:none} } } }",
  );
  expect(html).not.toContain("@charset");
});

test("drops malformed import preludes and their blocks before rewriting the following rule", async () => {
  const { result, resolveAsset } = htmlDoc(
    '<style>@import "a.css" x{}body{background:url(https://evil.example/x.png)};</style>',
    { "docs/a.css": css("p{color:green}") },
  );
  const html = await result;
  expect(html).toContain('<style>/**//**/body{background:/**/url("data:,")/**/};</style>');
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
])("drops imports with unsafe conditions %s and still rewrites following URLs", async (conditions) => {
  const { result, resolveAsset } = htmlDoc(
    `<style>@import "a.css" ${conditions};body{background:url(https://evil.example/x.png)}</style>`,
    { "docs/a.css": css("p{color:green}") },
  );
  const html = await result;
  expect(html).toContain('<style>/**//**/body{background:/**/url("data:,")/**/}</style>');
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
    `${fn}(/**/"data:image/png;base64,AQID"/**/ 1x type("image/png"), /**/url("data:image/png;base64,AQID")/**/ 2x, /**/"data:,"/**/ 3x)`,
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
  expect(nodes.find((el) => el.tagName === "pattern")?.properties).not.toHaveProperty("xLinkHref");
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
  expect(html).toContain("Some content was left out");
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
  expect(html).toContain('image-set(/* preview */ /**/"data:image/png;base64,AQID"/**/ 1x)');
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
  expect(html.match(/Some content was left out/g)).toHaveLength(1);
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
    "/**/@layer ui { p{color:green} }/**/",
  ]);
  expect(resolveAsset).toHaveBeenCalledExactlyOnceWith("docs/shared.css");
  expect(html).not.toContain("Some content was left out");
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
  expect(html.match(/Some content was left out/g)).toHaveLength(1);
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
  expect(html).toContain("<style>i{background:/**/none/**/}p{color:green}</style>");
  expect(resolveAsset).not.toHaveBeenCalled();
}, 15_000);

test("rewrites 5000 image-set rules within 10 seconds and resolves each candidate path once", async () => {
  const start = Date.now();
  const { result, resolveAsset } = htmlDoc(
    `<style>${'i{background:image-set("missing.png" 1x)}'.repeat(5000)}</style>`,
  );
  const html = await result;
  expect(Date.now() - start).toBeLessThan(10_000);
  expect(html).toContain(`<style>${'i{background:image-set(/**/"data:,"/**/ 1x)}'.repeat(5000)}</style>`);
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
  expect(html).toContain(`image-set(/**/"${uri}#part"/**/ 1x, /**/url("${uri}#part")/**/ 2x, /**/"${uri}"/**/ 3x)`);
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
  expect(limited).toContain('image-set(/**/"data:,"/**/ 1x)');
  expect(limited).toContain("Some content was left out");
});

test("keeps CSS less-than and less-than-or-equal range comparisons intact", async () => {
  const source = "@media (width < 600px){p{color:green}}@media (width <= 600px){p{color:red}}";
  const html = await htmlDoc(`<style>${source}</style>`).result;
  expect(html).toContain(`<style>${source}</style>`);
});

test("escapes HTML token openers in CSS without creating elements on reparse", async () => {
  const payload = '<meta http-equiv="refresh" content="0;url=https://evil.example/"></style><!-- --><?x></p>';
  const html = await htmlDoc('<link rel="stylesheet" href="site.css">', { "docs/site.css": css(payload) }).result;
  expect(html).toContain("< meta");
  expect(html).toContain("< /style>");
  expect(html).not.toContain("<!--");
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
    expect(html).toContain("background:/**/none/**/");
    expect(html).not.toContain("nested.png");
    expect(html.match(/data:,/g)).toHaveLength(10_000);
    expect(resolveAsset).toHaveBeenCalledExactlyOnceWith("docs/missing.png");
  },
  20_000,
);

test.each(['"', "'"])("closes unterminated %s strings after dropping a lone final escape", async (quote) => {
  const source = `${quote}a${`\\${quote}`.repeat(40_000)}\\`;
  const { result, resolveAsset } = htmlDoc(`<style>${source}</style>`);
  const html = await result;
  expect(html).toContain(`<style>${source.slice(0, -1)}${quote}</style>`);
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
      expect(html).toContain("Some content was left out");
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
    expect(html.match(/Some content was left out/g)).toHaveLength(1);
    expect(html.length).toBeLessThan(2000);
    expect(resolveAsset).toHaveBeenCalledExactlyOnceWith("large.css");
    expect(pause).toHaveBeenCalledTimes(kind === "imports" ? 120 : 128);
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
      expect(pause).toHaveBeenCalledTimes(2 * Math.floor(count / 1000));
      expect(resolve).toHaveBeenCalledTimes(1);
    }
  },
);

test("pauses in both source passes and the output check for each MiB across styles and attributes", async () => {
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
  expect(pause).toHaveBeenCalledTimes(6);
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

test.each(["element", "attribute"])(
  "finishes an unterminated import URL in a style %s within one second",
  async (kind) => {
    const source = `@import url(${" ".repeat(20_000)}`;
    const start = Date.now();
    const html = await htmlDoc(kind === "element" ? `<style>${source}</style>` : `<p style="${source}">Text</p>`)
      .result;
    expect(Date.now() - start).toBeLessThan(1000);
    expect(html).not.toContain("@import");
  },
);

test.each(["element", "attribute", "stylesheet"])(
  "decodes escaped CSS names before rewriting references in a %s",
  async (kind) => {
    const source = String.raw`p{a:u\72l(https://x/a.png);b:\75rl(https://x/b.png);c:u\rl(https://x/c.png);d:image-s\65t("https://x/d.png" 1x)}@\69mport "https://x/c.css";`;
    const input =
      kind === "element"
        ? `<style>${source}</style>`
        : kind === "attribute"
          ? `<p style='${source}'>Text</p>`
          : '<link rel="stylesheet" href="a.css">';
    const html = await htmlDoc(input, { "docs/a.css": css(source) }).result;
    expect(html).not.toContain("https://x/");
    expect(html).toContain("data:,");
  },
);

test("decodes escaped listed CSS paths and URL function names", async () => {
  const { result, resolveAsset } = htmlDoc(String.raw`<style>p{a:url(a\.png);b:u\72l(a.png)}</style>`, {
    "docs/a.png": png,
  });
  expect((await result).match(/data:image\/png/g)).toHaveLength(2);
  expect(resolveAsset).toHaveBeenCalledExactlyOnceWith("docs/a.png");
});

test("preserves namespace declarations without treating namespace URLs as resources", async () => {
  const source = "@namespace svg url(http://www.w3.org/2000/svg); svg|rect{fill:red}";
  const { result, resolveAsset } = htmlDoc(`<style>${source}</style>`);
  expect(await result).toContain(`<style>${source}</style>`);
  expect(resolveAsset).not.toHaveBeenCalled();
});

test("separates a less-than delimiter from a following function without changing a CSS comparison", async () => {
  const html = await htmlDoc("<style>@media(width<calc(600px)){p{color:red}}</style>").result;
  expect(html).toContain("@media(width< calc(600px))");
});

test("keeps comment-like text inside import condition strings", async () => {
  const html = await htmlDoc('<style>@import "a.css" supports(font-family:"a/*b");</style>', {
    "docs/a.css": css("p{color:green}"),
  }).result;
  expect(html).toContain('@supports (font-family:"a/*b") { p{color:green} }');
});

test("preserves image-set type strings while resolving candidate strings", async () => {
  const html = await htmlDoc('<style>p{background:image-set("a.png" 1x type("image/png"))}</style>', {
    "docs/a.png": png,
  }).result;
  expect(html).toContain('image-set(/**/"data:image/png;base64,AQID"/**/ 1x type("image/png"))');
});

test("does not mistake comments and strings for nested image-set functions", async () => {
  const html = await htmlDoc(
    '<style>p{a:image-set(/*image-set(*/ "a.png" 1x);b:image-set("image-set(1).png" 1x)}</style>',
    { "docs/a.png": png, "docs/image-set(1).png": png },
  ).result;
  expect(html.match(/data:image\/png/g)).toHaveLength(2);
  expect(hastText(parsed(html).find((el) => el.tagName === "style") as Element)).not.toContain("none");
});

test("ends bad strings at unescaped newlines so later resource references are rewritten", async () => {
  const html = await htmlDoc('<style>.bad{content:"oops\n}.ok{background:url(a.png)}</style>', { "docs/a.png": png })
    .result;
  expect(html).toContain('.ok{background:/**/url("data:image/png;base64,AQID")/**/}');
});

test.each([
  [16, "/*漢漢漢漢漢漢漢漢漢漢*/"],
  [8, "<url(#x)"],
] as const)("charges the final UTF-8 CSS bytes against a %i-byte budget", async (inlineBudget, source) => {
  const html = await buildHtmlDocDownload({
    html: `<style>${source}</style>`,
    title: "Budget",
    docPath: "doc.html",
    inlineBudget,
    resolveAsset: async () => null,
  });
  expect(parsed(html).filter((el) => el.tagName === "style")).toHaveLength(0);
  expect(html).toContain("Some content was left out");
});

const hostileCssCorpus = [
  '<meta http-equiv="refresh">',
  "</style>",
  "<!-- -->",
  "<?x>",
  "</p>",
  "/*<meta><script></style>*/",
  'p{content:"<meta></style>"}',
  'p{content:"<meta>\n}p{color:red}',
  'p{background:url("data:image/png,<meta>")}',
  '@import "a.css" supports(font-family:"<meta>");',
];

test("serializes hostile CSS tokens safely before the style escape backstop", async () => {
  for (const source of hostileCssCorpus) {
    const input = `<svg><style>${source.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</style></svg>`;
    const html = await htmlDoc(input, { "docs/a.css": css("p{color:green}") }).result;
    const attributeHtml = await htmlDoc(
      `<p style='${source.replaceAll("&", "&amp;").replaceAll("'", "&#39;")}'>Text</p>`,
      { "docs/a.css": css("p{color:green}") },
    ).result;
    const attribute = parsed(attributeHtml).find((el) => el.tagName === "p")?.properties.style;
    expect(typeof attribute).toBe("string");
    if (typeof attribute === "string") expect(attribute.replace(/<(?=[a-z/!?])/gi, "\\3c ")).toBe(attribute);
    const styleText = parsed(html).find((el) => el.tagName === "style");
    expect(styleText && hastText(styleText)).toBe(attribute);
    for (const el of parsed(html)) {
      expect(el.tagName).not.toBe("script");
      if (el.tagName === "meta" && el.properties.httpEquiv) expect(el.properties.content).toBe(DOWNLOAD_FILE_CSP);
      for (const key of Object.keys(el.properties)) expect(key).not.toMatch(/^on/i);
    }
  }
});

test.each(['url(bad"x)', 'url("a.png" extra)', 'src("a.png" extra)'])(
  "fails closed for malformed CSS resource %s",
  async (source) => {
    const html = await htmlDoc(`<style>p{background:${source}}</style>`).result;
    expect(html).toContain('background:/**/url("data:,")/**/');
  },
);

test("rewrites src and direct strings in image and cross-fade functions", async () => {
  const html = await htmlDoc(
    '<style>p{a:src("a.png");b:image("a.png");c:cross-fade("https://example.com/x", url(a.png));d:-webkit-cross-fade("a.png",red)}</style>',
    { "docs/a.png": png },
  ).result;
  expect(html.match(/data:image\/png/g)).toHaveLength(4);
  expect(html).not.toContain("https://example.com");
});

test.each(["markdown", "html"])("omits a %s input nested 2000 deep before building a HAST tree", async (kind) => {
  const source = `${"<div>".repeat(2000)}Deep content${"</div>".repeat(2000)}`;
  const html =
    kind === "html"
      ? await htmlDoc(source).result
      : await buildDocDownload({
          title: "Deep",
          details,
          resolveMedia: async () => null,
          content: { kind: "markdown", blocks: [block(source)] },
        });
  expectHead(html);
  expect(html).toContain("Some content was left out");
  expect(html).not.toContain("Deep content");
  if (kind === "html") {
    const body = parsed(html).find((el) => el.tagName === "body");
    expect(body?.children).toHaveLength(1);
    expect(parsed(html).some((el) => el.tagName === "style")).toBe(true);
  }
});

test("stops HTML parsing at the element limit", async () => {
  const html = await htmlDoc("<b>x</b>".repeat(200_001)).result;
  expect(html).toContain("Some content was left out");
  expect(html).not.toContain("<b>");
});

test("retains content nested 500 deep within the HTML nesting limit", async () => {
  const html = await htmlDoc(`${"<div>".repeat(500)}Retained content${"</div>".repeat(500)}`).result;
  expect(html).toContain("Retained content");
  expect(html).not.toContain("Some content was left out");
});

test.each(["html", "markdown", "writeup"])(
  "yields after every thousand visited %s elements without references",
  async (kind) => {
    const source = "<p>Text</p>".repeat(2000);
    const pause = vi.fn(async () => {});
    const input = { title: "Elements", details, resolveMedia: async () => null, pause };
    const html =
      kind === "html"
        ? await buildHtmlDocDownload({
            html: source,
            title: "Elements",
            docPath: "doc.html",
            resolveAsset: async () => null,
            pause,
          })
        : kind === "markdown"
          ? await buildDocDownload({ ...input, content: { kind: "markdown", blocks: [block(source)] } })
          : await buildWriteupDownload({ ...input, writeup: writeup([block(source)]), topics: [] });
    expect(html.match(/<p>Text<\/p>/g)).toHaveLength(2000);
    expect(pause).toHaveBeenCalledTimes(2);
  },
);

test("yields between three-MiB base64 chunks without changing the encoded bytes", async () => {
  const bytes = new Uint8Array(6 * 1024 * 1024 + 1).fill(251);
  const pause = vi.fn(async () => {});
  const html = await buildHtmlDocDownload({
    html: '<img src="a.png">',
    title: "Large asset",
    docPath: "doc.html",
    resolveAsset: async () => ({ mediaType: "image/png", bytes }),
    pause,
  });
  expect(pause).toHaveBeenCalledTimes(2);
  const uri = String(parsed(html).find((el) => el.tagName === "img")?.properties.src);
  expect(uri).toBe(`data:image/png;base64,${"+/v7".repeat(2 * 1024 * 1024)}+w==`);
});

test("keeps internal commas in srcset paths and consumes descriptors outside parentheses", async () => {
  const html = await htmlDoc('<img srcset="a,b.png 1x, missing.png invalid(a,b), a,b.png, a,b.png 2x">', {
    "docs/a,b.png": png,
  }).result;
  expect(parsed(html).find((el) => el.tagName === "img")?.properties.srcSet).toBe(
    "data:image/png;base64,AQID 1x, data:image/png;base64,AQID, data:image/png;base64,AQID 2x",
  );
});

test("leaves alternate and disabled stylesheets out while inlining a normal sheet", async () => {
  const { result, resolveAsset } = htmlDoc(
    '<link rel="stylesheet" href="normal.css"><link rel="alternate stylesheet" href="alt.css"><link rel="stylesheet" disabled href="disabled.css">',
    {
      "docs/normal.css": css("p{color:green}"),
      "docs/alt.css": css("p{color:red}"),
      "docs/disabled.css": css("p{color:blue}"),
    },
  );
  const html = await result;
  expect(html).toContain("p{color:green}");
  expect(html).not.toContain("color:red");
  expect(html).not.toContain("color:blue");
  expect(resolveAsset).toHaveBeenCalledExactlyOnceWith("docs/normal.css");
});

test("never inlines listed HTML assets in resource attributes or non-image hrefs", async () => {
  const html = await htmlDoc(
    '<math href="page.html"><mi xlink:href="page.html">x</mi></math><img src="page.html"><svg><image href="page.html"/><feImage href="page.html"/></svg>',
    {
      "docs/page.html": {
        mediaType: "text/html",
        bytes: new TextEncoder().encode("<a href='https://example.com'>Link</a>"),
      },
    },
  ).result;
  for (const el of parsed(html).filter((el) => ["math", "mi", "img", "image", "feImage"].includes(el.tagName))) {
    expect(el.properties).not.toHaveProperty("href");
    expect(el.properties).not.toHaveProperty("xLinkHref");
    expect(el.properties).not.toHaveProperty("src");
  }
  expect(html).not.toContain("data:text/html");
});

test("starts every download with a UTF-8 byte order mark", async () => {
  const outputs = [
    await render([]),
    await buildDocDownload({
      title: "Doc",
      details,
      resolveMedia: async () => null,
      content: { kind: "source", lines: [] },
    }),
    await htmlDoc("<p>HTML</p>").result,
  ];
  for (const html of outputs) {
    expect(html.startsWith("\uFEFF<!doctype html>")).toBe(true);
    expect([...new TextEncoder().encode(html).slice(0, 3)]).toEqual([239, 187, 191]);
  }
});

test("applies image href rules by tag name including MathML integration points", async () => {
  const html = await htmlDoc(
    '<math><image href="a.png"/><mi href="a.png">x</mi><annotation-xml><svg><image href="a.png"/><feImage href="a.png"/></svg></annotation-xml></math>',
    { "docs/a.png": png },
  ).result;
  expect(
    parsed(html)
      .filter((el) => el.tagName === "image")
      .map((el) => el.properties.href),
  ).toEqual(["data:image/png;base64,AQID", "data:image/png;base64,AQID"]);
  expect(parsed(html).find((el) => el.tagName === "feImage")?.properties.href).toBe("data:image/png;base64,AQID");
});

test("counts astral CSS characters as four UTF-8 bytes", async () => {
  for (const inlineBudget of [7, 8]) {
    const html = await buildHtmlDocDownload({
      html: "<style>/*😀*/</style>",
      title: "UTF-8 budget",
      docPath: "doc.html",
      inlineBudget,
      resolveAsset: async () => null,
    });
    expect(html.includes("/*😀*/")).toBe(inlineBudget === 8);
    expect(html.includes("Some content was left out")).toBe(inlineBudget === 7);
  }
});

test.each([
  { placement: "linked sheet", character: ";", mib: 24 },
  { placement: "style", character: "(", mib: 8 },
  { placement: "style", character: "<", mib: 8 },
])(
  "streams $mib MiB of $character in a $placement and pauses in all three CSS passes",
  async ({ placement, character, mib }) => {
    const source = character.repeat(mib * 1024 * 1024);
    const pause = vi.fn(async () => {});
    const html = await buildHtmlDocDownload({
      html: `${placement === "linked sheet" ? '<link rel="stylesheet" href="large.css">' : `<style>${source}</style>`}<p>Kept page text</p>`,
      title: "Token-dense CSS",
      docPath: "doc.html",
      resolveAsset: async (path) => (path === "large.css" ? css(source) : null),
      pause,
    });
    expect(html).toContain("<p>Kept page text</p>");
    expect(html).toContain(`<style>${source}</style>`);
    expect(pause).toHaveBeenCalledTimes(mib * 3);
  },
  60_000,
);

test("drops imports whose preludes exceed 64 tokens without losing following CSS", async () => {
  const { result, resolveAsset } = htmlDoc(`<style>@import "a.css" ${"x ".repeat(2500)};p{color:green}</style>`, {
    "docs/a.css": css("p{color:red}"),
  });
  const html = await result;
  expect(html).toContain("<style>/**//**/p{color:green}</style>");
  expect(html).toContain("Some content was left out");
  expect(resolveAsset).not.toHaveBeenCalled();
});

test("drops imports whose preludes exceed four KiB even with few tokens", async () => {
  const { result, resolveAsset } = htmlDoc(`<style>@import "a.css" /*${"x".repeat(4096)}*/;p{color:green}</style>`, {
    "docs/a.css": css("p{color:red}"),
  });
  const html = await result;
  expect(html).toContain("<style>/**//**/p{color:green}</style>");
  expect(html).toContain("Some content was left out");
  expect(resolveAsset).not.toHaveBeenCalled();
});

test("drops invalid import rules with their entire block and keeps the following rule", async () => {
  const { result, resolveAsset } = htmlDoc('<style>@import "a.css" {x{color:red}} p{color:green}</style>', {
    "docs/a.css": css("p{color:blue}"),
  });
  const html = await result;
  expect(html).toContain("<style>/**//**/ p{color:green}</style>");
  expect(html).not.toContain("color:red");
  expect(html).not.toContain("color:blue");
  expect(resolveAsset).not.toHaveBeenCalled();
});

test("uses image tag names without inferring namespaces for resource hrefs", async () => {
  const { result, resolveAsset } = htmlDoc(
    '<image href="a.png"><feimage href="a.png"></feimage><svg><image href="a.png"/><feImage href="a.png"/><use href="a.png"/></svg><math><mi href="a.png">x</mi><mi href="#local">y</mi></math>',
    { "docs/a.png": png },
  );
  const nodes = parsed(await result);
  expect(nodes.find((el) => el.tagName === "img")?.properties).not.toHaveProperty("href");
  for (const el of nodes.filter((el) => ["image", "feimage", "feImage"].includes(el.tagName)))
    expect(el.properties.href).toBe("data:image/png;base64,AQID");
  expect(nodes.find((el) => el.tagName === "use")?.properties).not.toHaveProperty("href");
  expect(nodes.filter((el) => el.tagName === "mi").map((el) => el.properties.href)).toEqual([undefined, "#local"]);
  expect(resolveAsset).toHaveBeenCalledExactlyOnceWith("docs/a.png");
});

const cssSplices = [
  String.raw`p{background:\75r@import "missing.css"{}l(https://probe.invalid/a.png)}`,
  String.raw`p{background:\75r@charset "x";l(https://probe.invalid/b.png)}`,
  'a{color:red}/@import "m.css"{}*"*/ p{background:url(https://probe.invalid/c.png)} /*"',
];

const securitySheets = {
  "docs/str.css": css('x{y:z} "unterminated'),
  "docs/com.css": css("x{y:z} /* unterminated"),
  "docs/bs.css": css("x{y:z} \\"),
  "docs/ok.css": css("x{y:z}"),
};
const securityCssProbes = [
  {
    name: "escaped less-than in a function name",
    source: String.raw`li{list-style:\<url(https://probe.invalid/a.png)}`,
  },
  { name: "a nested namespace", source: "li{ i{ @namespace } list-style:url(https://probe.invalid/b.png); }" },
  {
    name: "a namespace ending at a closing brace",
    source: "@namespace } background:url(https://probe.invalid/s.png);",
  },
  {
    name: "an import between identifier fragments",
    source: 'li.t{list-style:u@import "missing.css";rl(https://probe.invalid/g-import.png)}',
  },
  {
    name: "a charset between identifier fragments",
    source: 'li.t{list-style:u@charset "x";rl(https://probe.invalid/g-charset.png)}',
  },
  {
    name: "an imported unterminated string",
    source: '@import "str.css";"{} li.t{list-style:url(https://probe.invalid/d-string.png)} x{a:"',
  },
  {
    name: "an imported unterminated comment",
    source: '@import "com.css";"*/ li.t{list-style:url(https://probe.invalid/d-comment.png)} x{a:"',
  },
  {
    name: "an imported final backslash",
    source: '@import "bs.css";"; li.t{list-style:url(https://probe.invalid/d-backslash.png)} x{a:"',
  },
  {
    name: "a bad string in import conditions",
    source: '@import "ok.css" "x\n;"; li.t{list-style:url(https://probe.invalid/d-badstring.png)} x{a:"',
  },
  {
    name: "an image-set variable",
    source: ':root{--c:"https://probe.invalid/c.png"} p{background-image:image-set(var(--c) 1x)}',
  },
];

/** Inspect the tokens of the written CSS independently of the production backstop. */
function expectOfflineCss(source: string, attribute = false) {
  const tokens = [...cssTokenize(source)];
  const contexts: string[] = [];
  const imageFunctions = ["image-set", "-webkit-image-set", "image", "cross-fade", "-webkit-cross-fade"];
  const safe = (value: string) => expect(value).toMatch(/^(?:data:|#[^\s]*$)/i);
  for (const token of tokens) expect(token.unterminated).toBe(false);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token) break;
    const name = token.value.toLowerCase();
    if (token.kind === "at" && name === "namespace" && !attribute && !contexts.length) {
      let depth = 0;
      for (index++; index < tokens.length; index++) {
        const part = tokens[index];
        if (!part) break;
        if (!depth && part.kind === "punct" && ";{}".includes(part.value)) {
          if (part.value === "{") contexts.push("{");
          break;
        }
        if (part.kind === "function" || (part.kind === "punct" && "([{".includes(part.value))) depth++;
        else if (part.kind === "punct" && ")]}".includes(part.value)) depth = Math.max(0, depth - 1);
      }
      continue;
    }
    expect(token.kind).not.toBe("bad-url");
    if (token.kind === "at") expect(name).not.toBe("import");
    if (token.kind === "url") safe(token.value);
    if (token.kind === "function") {
      if (contexts.some((name) => imageFunctions.includes(name))) expect(["var", "env", "attr"]).not.toContain(name);
      if (name === "url" || name === "src") {
        const argumentsFound = [];
        for (index++; index < tokens.length; index++) {
          const argument = tokens[index];
          if (!argument || (argument.kind === "punct" && argument.value === ")")) break;
          if (argument.kind !== "space" && argument.kind !== "comment") argumentsFound.push(argument);
        }
        expect(argumentsFound).toHaveLength(1);
        expect(argumentsFound[0]?.kind).toBe("string");
        safe(argumentsFound[0]?.value ?? "");
      } else contexts.push(name);
    } else if (token.kind === "punct") {
      if ("([{".includes(token.value)) contexts.push(token.value);
      else if (")]}".includes(token.value)) contexts.pop();
    } else if (token.kind === "string" && imageFunctions.includes(contexts.at(-1) ?? "")) safe(token.value);
  }
}

test("keeps rewritten stylesheets and style attributes free of active remote references across the hostile corpus", async () => {
  const corpus = [
    ...hostileCssCorpus,
    ...cssSplices,
    ...securityCssProbes.map(({ source }) => source),
    String.raw`p{a:u\72l(https://probe.invalid/a);b:image-s\65t("https://probe.invalid/b" 1x)}`,
    'p{a:src("https://probe.invalid/a");b:image("https://probe.invalid/b");c:cross-fade("https://probe.invalid/c",red)}',
    'p{background:image-set(/*image-set(*/ "a.png" 1x type("image/png"))}',
    '.bad{content:"oops\n}.ok{background:url(https://probe.invalid/a)}',
    '@import "a.css" supports(font-family:"a/*b");',
    "@namespace svg url(http://www.w3.org/2000/svg);svg|rect{fill:red}",
  ];
  for (const source of corpus) {
    const escaped = source.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
    const { result } = htmlDoc(
      `<svg><style>${escaped}</style></svg><p style="${escaped}">Text</p><link rel="stylesheet" href="hostile.css">`,
      {
        "docs/hostile.css": css(source),
        "docs/a.css": css('p{background:url("https://probe.invalid/imported")}'),
        "docs/a.png": png,
        ...securitySheets,
      },
    );
    const html = await result;
    for (const node of parsed(html)) {
      if (node.tagName === "style") expectOfflineCss(hastText(node));
      if (typeof node.properties.style === "string") expectOfflineCss(node.properties.style, true);
    }
  }
});

test.each([
  "p{background:url(https://probe.invalid/a.png)}",
  'p{background:url("https://probe.invalid/a.png")}',
  'p{background:src("https://probe.invalid/a.png")}',
  'p{background:url("data:image/png,x" extra)}',
  'p{background:url("data:image/png,x" "data:image/png,y")}',
  'p{background:url(bad"url)}',
  '@import "data:text/css,p{}";',
  'p{background:image-set("https://probe.invalid/a.png" 1x)}',
  'p{background:-webkit-image-set("https://probe.invalid/a.png" 1x)}',
  'p{background:image("https://probe.invalid/a.png")}',
  'p{background:cross-fade("https://probe.invalid/a.png",red)}',
  'p{background:-webkit-cross-fade("https://probe.invalid/a.png",red)}',
  "p{background:image-set(var(--c) 1x)}",
  "p{background:IMAGE-SET(type(v\\61r(--c)) 1x)}",
  "p{background:image(env(--c))}",
  "p{background:cross-fade(attr(data-image))}",
  'p{background:src("data:image/png,x" var(--c))}',
  'p{content:"unterminated',
  'p{content:"unterminated\\',
  "/* unterminated",
  "li{ i{ @namespace } list-style:url(https://probe.invalid/b.png); }",
  "@namespace } background:url(https://probe.invalid/s.png);",
])("rejects synthetic unsafe CSS output in the backstop: %s", async (source) => {
  expect(await checkDownloadCss(source)).toBeNull();
});

test("exempts namespace preludes while checking the CSS after them", async () => {
  const namespace = '@namespace svg url("http://www.w3.org/2000/svg");';
  const source = `${namespace}p{background:src(/**/"data:image/png,x"/**/);filter:url(#local)}`;
  expect(await checkDownloadCss(source)).toBe(source);
  expect(await checkDownloadCss(`${namespace}p{background:url(https://probe.invalid/a.png)}`)).toBeNull();
});

test.each([
  String.raw`p::before{content:"\<"}`,
  String.raw`[data-x="\<"]{color:red}`,
  'p{content:"\\<\n}.ok{color:green}',
  String.raw`p{content:"\\< \3c  \00003C \< <"}`,
])("preserves decoded string values while escaping less-than in %s", async (source) => {
  const before = [...cssTokenize(source)].filter((token) => token.kind === "string" || token.kind === "bad-string");
  const html = await htmlDoc(`<style>${source}</style>`).result;
  const stylesheet = parsed(html).find((node) => node.tagName === "style");
  expect(stylesheet).toBeDefined();
  const written = stylesheet ? hastText(stylesheet) : "";
  const after = [...cssTokenize(written)].filter((token) => token.kind === "string" || token.kind === "bad-string");
  expect(after.map(({ kind, value }) => ({ kind, value }))).toEqual(before.map(({ kind, value }) => ({ kind, value })));
  expect(written).toContain("\\3c ");
  if (source.includes(".ok")) expect(written).toContain("\n}.ok{color:green}");
});

test("charges separators around replacements and drops and separates them from less-than", async () => {
  const source = '<url(#x)@import "missing.css";';
  const { result } = htmlDoc(`<style>${source}</style>`);
  const html = await result;
  const written = hastText(parsed(html).find((node) => node.tagName === "style") as Element);
  expect(written).toBe('< /**/url("#x")/**//**//**/');
  const limited = await buildHtmlDocDownload({
    html: `<style>${source}</style>`,
    title: "Budget",
    docPath: "doc.html",
    inlineBudget: new TextEncoder().encode(written).byteLength - 1,
    resolveAsset: async () => null,
  });
  expect(parsed(limited).some((node) => node.tagName === "style")).toBe(false);
  expect(limited).toContain("Some content was left out");
});

test.each(cssSplices)(
  "separates removed CSS constructs without creating reference or comment tokens: %s",
  async (source) => {
    const { result, resolveAsset } = htmlDoc(`<style>${source}</style>`);
    const html = await result;
    const stylesheet = parsed(html).find((node) => node.tagName === "style");
    expect(stylesheet).toBeDefined();
    const written = stylesheet ? hastText(stylesheet) : "";
    expectOfflineCss(written);
    expect(written).toContain("/**//**/");
    if (source.startsWith("a{")) {
      expect(written).toContain("a{color:red}");
      const strings = (value: string) =>
        [...cssTokenize(value)].filter((token) => token.kind === "string").map((token) => token.value);
      expect(strings(written)).toEqual(strings(source).slice(1));
    } else {
      expect(written).toContain(String.raw`\75r/**//**/l(`);
      expect(
        [...cssTokenize(written)].some(
          (token) => token.kind === "url" || (token.kind === "function" && token.value === "url"),
        ),
      ).toBe(false);
    }
    expect(resolveAsset).not.toHaveBeenCalled();
  },
);

test.each(securityCssProbes)("preserves safe surrounding rules while neutralizing $name", async ({ source, name }) => {
  const before = "a{color:red}";
  const after = "p{color:green}";
  const html = await htmlDoc(`<style>${before}${source}${after}</style>`, securitySheets).result;
  const stylesheet = parsed(html).find((node) => node.tagName === "style");
  expect(stylesheet).toBeDefined();
  const written = stylesheet ? hastText(stylesheet) : "";
  expectOfflineCss(written);
  expect(written.startsWith(before)).toBe(true);
  expect(written.endsWith(after)).toBe(true);
  // Neither surrounding rule may have become part of a string or comment.
  const tokens = [...cssTokenize(written)];
  expect(tokens.find((token) => token.start === 0)?.value).toBe("a");
  expect(tokens.find((token) => token.start === written.length - after.length)?.value).toBe("p");
  if (name.startsWith("an imported")) expect(written).toContain("x{y:z}");
  if (name === "a bad string in import conditions") expect(written).not.toContain("x{y:z}");
  if (name === "escaped less-than in a function name") {
    expect(tokens.filter((token) => token.kind === "function").map((token) => token.value)).toEqual(["<url"]);
    expect(tokens.some((token) => token.kind === "url" || token.kind === "bad-url")).toBe(false);
  }
  if (name === "an image-set variable") {
    expect(written).toContain(':root{--c:"https://probe.invalid/c.png"}');
    expect(written).toContain("background-image:/**/none/**/");
  }
});

test("preserves decoded escaped less-than in names, functions, at-keywords, hashes and dimensions", async () => {
  const source = String.raw`li.\<name#\<hash{--\<ident:1\<unit;value:\<function(1);content:"\<"}@\<rule x;`;
  const html = await htmlDoc(`<style>${source}</style>`).result;
  const sheet = parsed(html).find((node) => node.tagName === "style");
  expect(sheet).toBeDefined();
  const written = sheet ? hastText(sheet) : "";
  const decoded = (value: string) => [...cssTokenize(value)].map(({ kind, value }) => ({ kind, value }));
  expect(decoded(written)).toEqual(decoded(source));
  expect(written).toContain("\\3c ");
  expect(written.replace(/<(?=[a-z/!?])/gi, "\\3c ")).toBe(written);
  expectOfflineCss(written);
});

test("rewrites namespace references in attributes and blocks but preserves top-level stylesheet namespaces", async () => {
  const namespace = "@namespace svg url(http://www.w3.org/2000/svg);";
  const input = `<style>${namespace} svg|rect{fill:red}@media screen{${namespace}p{color:green}}</style><p style="${namespace}color:red">Text</p>`;
  const html = await htmlDoc(input).result;
  const nodes = parsed(html);
  const sheet = nodes.find((node) => node.tagName === "style");
  const written = sheet ? hastText(sheet) : "";
  expect(written.startsWith(namespace)).toBe(true);
  expect(written.match(/http:\/\/www.w3.org\/2000\/svg/g)).toHaveLength(1);
  expect(written).toContain('svg|rect{fill:red}@media screen{@namespace svg /**/url("data:,")/**/;p{color:green}}');
  const attribute = nodes.find((node) => node.tagName === "p")?.properties.style;
  expect(attribute).toBe('@namespace svg /**/url("data:,")/**/;color:red');
  expectOfflineCss(written);
  if (typeof attribute === "string") expectOfflineCss(attribute, true);
});

test("limits the namespace backstop exemption to a stylesheet prelude at depth zero", async () => {
  const namespace = "@namespace svg url(http://www.w3.org/2000/svg);";
  expect(await checkDownloadCss(namespace)).toBe(namespace);
  expect(await checkDownloadCss(namespace, undefined, "attribute")).toBeNull();
  expect(await checkDownloadCss(`p{${namespace}}`)).toBeNull();
  expect(
    await checkDownloadCss(
      "@namespace svg url(http://www.w3.org/2000/svg){p{background:url(https://probe.invalid/x)}}",
    ),
  ).toBeNull();
});

test.each(['"unterminated', "/* unterminated", '"bad\nstring', 'url(bad"url)'])(
  "drops an import whose prelude contains %s without reading its sheet",
  async (condition) => {
    const { result, resolveAsset } = htmlDoc(
      `<style>a{color:red}@import "ok.css" ${condition}</style>`,
      securitySheets,
    );
    const html = await result;
    const written = hastText(parsed(html).find((node) => node.tagName === "style") as Element);
    expect(written).toBe("a{color:red}/**//**/");
    expectOfflineCss(written);
    expect(resolveAsset).not.toHaveBeenCalled();
  },
);

test.each(["image-set", "-webkit-image-set", "image", "cross-fade", "-webkit-cross-fade"])(
  "replaces %s containing indirect references at any depth without resolving them",
  async (name) => {
    for (const indirect of ["var(--c)", "env(--c)", "attr(data-image)", String.raw`v\61r(--c)`]) {
      const source = `p{a:${name}(${indirect});b:${name}(type(${indirect}));c:${name}(type(image(${indirect})));d:src(${indirect});color:green}`;
      const { result, resolveAsset } = htmlDoc(`<style>${source}</style>`);
      const html = await result;
      const written = hastText(parsed(html).find((node) => node.tagName === "style") as Element);
      expect(written).toBe('p{a:/**/none/**/;b:/**/none/**/;c:/**/none/**/;d:/**/url("data:,")/**/;color:green}');
      expectOfflineCss(written);
      expect(resolveAsset).not.toHaveBeenCalled();
    }
  },
);

test("detects indirect references in image functions that end at EOF", async () => {
  const html = await htmlDoc("<style>p{color:green;background:image(type(var(--c)</style>").result;
  const written = hastText(parsed(html).find((node) => node.tagName === "style") as Element);
  expect(written).toBe("p{color:green;background:/**/none/**/");
  expectOfflineCss(written);
});

test("does not mistake strings or comments for indirect image references", async () => {
  const html = await htmlDoc('<style>p{background:image-set(/*var(*/ "var(--c).png" 1x type("env(--c)"))}</style>', {
    "docs/var(--c).png": png,
  }).result;
  const written = hastText(parsed(html).find((node) => node.tagName === "style") as Element);
  expect(written).not.toContain("none");
  expect(written).toContain('type("env(--c)")');
  expect(written).toContain("data:image/png;base64,AQID");
  expectOfflineCss(written);
});

test("charges the final CSS validation scan to the never-refunded work budget", async () => {
  const mib = 1024 * 1024;
  const source = `/*${"x".repeat(mib - 4)}*/`;
  const pause = vi.fn(async () => {});
  const work = createDownloadWork();
  const html = await buildHtmlDocDownload({
    html: '<link rel="stylesheet" href="a.css">'.repeat(33),
    docPath: "doc.html",
    title: "Work budget",
    resolveAsset: async () => css(source),
    pause,
    work,
  });
  expect(html.match(/<style>/g)).toHaveLength(32);
  expect(html).toContain("Some content was left out");
  expect(pause).toHaveBeenCalledTimes(96);
  const next = {
    html: '<style>.late{color:green}</style><p style="color:red">Next doc</p>',
    title: "Next doc",
    docPath: "next.html",
    resolveAsset: async () => null,
  };
  const shared = await buildHtmlDocDownload({ ...next, work });
  expect(shared).not.toContain(".late");
  expect(shared).not.toContain('style="color:red"');
  expect(shared).toContain("Next doc");
  expect(shared.match(/Some content was left out/g)).toHaveLength(1);
  const independent = await buildHtmlDocDownload(next);
  expect(independent).toContain(".late{color:green}");
  expect(independent).toContain('style="color:red"');
  expect(independent).not.toContain("Some content was left out");
}, 15_000);

test.each(["element", "attribute"])(
  "rewrites references after a namespace closing brace in a style %s",
  async (kind) => {
    for (const prelude of ["", "fn([;{}]) "]) {
      const source = `@namespace ${prelude}} background:url(https://probe.invalid/s.png);p{color:green}`;
      const input = kind === "element" ? `<style>${source}</style>` : `<p style='${source}'>Text</p>`;
      const nodes = parsed(await htmlDoc(input).result);
      const written =
        kind === "element"
          ? hastText(nodes.find((node) => node.tagName === "style") as Element)
          : String(nodes.find((node) => node.tagName === "p")?.properties.style);
      expect(written).toBe(`@namespace ${prelude}} background:/**/url("data:,")/**/;p{color:green}`);
      expectOfflineCss(written, kind === "attribute");
      expect(await checkDownloadCss(source, undefined, kind === "attribute" ? "attribute" : "stylesheet")).toBeNull();
    }
  },
);

test.each(["element", "attribute", "linked sheet"])(
  "checks an entire import chain once in the final %s text",
  async (kind) => {
    const mib = 1024 * 1024;
    const rule = "p{color:green}";
    const leaf = `/*${"x".repeat(mib - 4 - rule.length)}*/${rule}`;
    const sheets: Record<string, ResolveResult> = {
      "docs/a.css": css('@import "b.css";'),
      "docs/b.css": css('@import "leaf.css";'),
      "docs/leaf.css": css(leaf),
    };
    const pause = vi.fn(async () => {});
    const input =
      kind === "element"
        ? '<style>@import "a.css";</style>'
        : kind === "attribute"
          ? "<p style='@import \"a.css\";'>Text</p>"
          : '<link rel="stylesheet" href="a.css">';
    const html = await buildHtmlDocDownload({
      html: input,
      docPath: "docs/index.html",
      title: "Import chain",
      resolveAsset: async (path) => sheets[path] ?? null,
      pause,
    });
    const nodes = parsed(html);
    const written =
      kind === "attribute"
        ? String(nodes.find((node) => node.tagName === "p")?.properties.style)
        : hastText(nodes.find((node) => node.tagName === "style") as Element);
    expect(written).toContain(leaf);
    expectOfflineCss(written, kind === "attribute");
    // Two source passes over the leaf, then one check of the fully joined output.
    expect(pause).toHaveBeenCalledTimes(3);
    expect(html).not.toContain("Some content was left out");
  },
);

test.each(["&#114;", "&#114", "&#x72;", "&#x72", "&not;", "&not"])(
  "prevents a second character-reference decode of %s in SVG style text",
  async (reference) => {
    const source = `p{background:u${reference}l(https://probe.invalid/a.png)}.kept{color:green}`;
    const html = await htmlDoc(`<svg><style>${source.replaceAll("&", "&amp;")}</style></svg>`).result;
    const written = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
    expect(written).not.toMatch(/&[a-z0-9#]/i);
    expect(written).toContain("&/**/");
    // fromHtml performs the same foreign-content character-reference decode as a browser.
    const reparsed = hastText(parsed(html).find((node) => node.tagName === "style") as Element);
    expect(reparsed).toBe(written);
    expectOfflineCss(reparsed);
    expect(reparsed).toContain(".kept{color:green}");
    expect([...cssTokenize(reparsed)].some((token) => token.kind === "url")).toBe(false);
  },
);

test("keeps nesting selectors unchanged when separating their ampersands from character references", async () => {
  const source = "a{&.b{color:red} &:hover{color:blue}}";
  const html = await htmlDoc(`<style>${source}</style>`).result;
  const written = hastText(parsed(html).find((node) => node.tagName === "style") as Element);
  expect(written).toBe("a{&/**/.b{color:red} &/**/:hover{color:blue}}");
  const tokens = (value: string) =>
    [...cssTokenize(value)].filter((token) => token.kind !== "comment").map(({ kind, value }) => ({ kind, value }));
  expect(tokens(written)).toEqual(tokens(source));
});

test.each([
  'p{content:"a&b"}',
  String.raw`p{content:"a\&b"}`,
  String.raw`p{content:"a\\&b"}`,
  'p{content:"a&b\n}.kept{color:green}',
  String.raw`.a\&b#x\&y{--a\&b:1a\&b;x:f\&g(1)}@a\&b x;`,
  "@namespace svg url(https://example.com/a&b);",
])("preserves decoded ampersands while escaping character references in %s", async (source) => {
  for (const svg of [false, true]) {
    const html = await htmlDoc(
      svg ? `<svg><style>${source.replaceAll("&", "&amp;")}</style></svg>` : `<style>${source}</style>`,
    ).result;
    const written = hastText(parsed(html).find((node) => node.tagName === "style") as Element);
    const tokens = (value: string) => [...cssTokenize(value)].map(({ kind, value }) => ({ kind, value }));
    expect(tokens(written)).toEqual(tokens(source));
    expect(written).toContain("\\26 ");
    expect(written).not.toMatch(/&[a-z0-9#]/i);
  }
});

test("escapes ampersands in comments and rewritten references without changing their decoded URLs", async () => {
  const source = '/*&not &#114*/p{background:url("data:image/png,a&b");filter:url(#a&b)}';
  const html = await htmlDoc(`<svg><style>${source.replaceAll("&", "&amp;")}</style></svg>`).result;
  const written = hastText(parsed(html).find((node) => node.tagName === "style") as Element);
  expect(written).toContain("/*\\26 not \\26 #114*/");
  expect(written).not.toMatch(/&[a-z0-9#]/i);
  expect([...cssTokenize(written)].filter((token) => token.kind === "string").map((token) => token.value)).toEqual([
    "data:image/png,a&b",
    "#a&b",
  ]);
  expectOfflineCss(written);
});

test.each([
  "a{&not{color:red}}",
  'p{content:"a&b"}',
  "/*&#114*/",
  "a{&1{color:red}}",
  "@namespace svg url(https://example.com/a&b);",
])("refuses character-reference openers in final CSS: %s", async (source) => {
  expect(await checkDownloadCss(source)).toBeNull();
});

test.each(["a{&b{color:red}}", 'p{content:"a&b"}'])(
  "charges the final bytes of ampersand escaping in %s",
  async (source) => {
    const original = await htmlDoc(`<style>${source}</style>`).result;
    const written = hastText(parsed(original).find((node) => node.tagName === "style") as Element);
    const length = new TextEncoder().encode(written).byteLength;
    expect(length).toBeGreaterThan(new TextEncoder().encode(source).byteLength);
    for (const budget of [length, length - 1]) {
      const html = await buildHtmlDocDownload({
        html: `<style>${source}</style>`,
        title: "Budget",
        docPath: "doc.html",
        resolveAsset: async () => null,
        inlineBudget: budget,
      });
      expect(parsed(html).some((node) => node.tagName === "style")).toBe(budget === length);
      expect(html.includes("Some content was left out")).toBe(budget !== length);
    }
  },
);

const presentationAttributes = [
  ["fill", "fill"],
  ["stroke", "stroke"],
  ["filter", "filter"],
  ["clip-path", "clipPath"],
  ["mask", "mask"],
  ["marker-start", "markerStart"],
  ["marker-mid", "markerMid"],
  ["marker-end", "markerEnd"],
  ["cursor", "cursor"],
  ["values", "values"],
  ["from", "from"],
  ["to", "to"],
  ["by", "by"],
  ["marker", "marker"],
];

test.each(presentationAttributes)("removes unlisted CSS references from %s attributes", async (attribute, property) => {
  for (const value of ["url(https://probe.invalid/a.png)", String.raw`u\72l(https://probe.invalid/a.png)`]) {
    const { result, resolveAsset } = htmlDoc(
      `<svg><path ${attribute}="${value}"></path></svg><div ${attribute}="${value}">Text</div>`,
    );
    const nodes = parsed(await result).filter((node) => node.tagName === "path" || node.tagName === "div");
    expect(nodes).toHaveLength(2);
    for (const node of nodes) {
      expect(node.properties).not.toHaveProperty(property);
      expect(Object.values(node.properties).join(" ")).not.toContain("probe.invalid");
    }
    expect(resolveAsset).not.toHaveBeenCalled();
  }
});

test.each(presentationAttributes)(
  "keeps local fragments and plain values in %s attributes",
  async (attribute, property) => {
    for (const value of ["url(#grad)", "none", "red"]) {
      const html = await htmlDoc(`<svg><path ${attribute}="${value}"></path></svg>`).result;
      expect(parsed(html).find((node) => node.tagName === "path")?.properties[property]).toBe(value);
    }
  },
);

test("removes remote paint references from SMIL values while preserving the animation element", async () => {
  const html = await htmlDoc(
    '<svg><animate attributeName="fill" values="red;url(https://probe.invalid/x.png)"></animate></svg>',
  ).result;
  const animation = parsed(html).find((node) => node.tagName === "animate");
  expect(animation?.properties.attributeName).toBe("fill");
  expect(animation?.properties).not.toHaveProperty("values");
});

test("separates nesting ampersands in import conditions before writing their wrappers", async () => {
  const html = await htmlDoc('<style>@import "a.css" supports(selector(&.b));</style>', {
    "docs/a.css": css("p{color:green}"),
  }).result;
  const written = hastText(parsed(html).find((node) => node.tagName === "style") as Element);
  expect(written).toContain("@supports (selector(&/**/.b)) { p{color:green} }");
  expect(await checkDownloadCss(written)).toBe(written);
});

test("permits data references in styles but keeps only fragments in presentation attributes", async () => {
  const value = "url(data:image/png;base64,AQID)";
  const html = await htmlDoc(`<svg><path fill="${value}" style="fill:${value}"></path></svg>`).result;
  const path = parsed(html).find((node) => node.tagName === "path");
  expect(path?.properties).not.toHaveProperty("fill");
  expect(path?.properties.style).toContain("data:image/png;base64,AQID");
});

test("yields while checking a large presentation attribute", async () => {
  const value = `/*${"x".repeat(1024 * 1024)}*/red`;
  const pause = vi.fn(async () => {});
  const html = await buildHtmlDocDownload({
    html: `<svg><path fill="${value}"></path></svg>`,
    title: "Paint",
    docPath: "doc.html",
    resolveAsset: async () => null,
    pause,
  });
  expect(parsed(html).find((node) => node.tagName === "path")?.properties.fill).toBe(value);
  expect(pause).toHaveBeenCalledTimes(1);
});

test("an unrendered source doc shows the reading view's fallback instead of a code block", async () => {
  const html = await buildDocDownload({
    title: "Unavailable source",
    details,
    resolveMedia: async () => null,
    content: { kind: "source", lines: [[{ text: "hidden source" }]], unrendered: true },
  });
  expectHead(html);
  expect(html).toContain("<p>This file could not be shown.</p>");
  expect(html).not.toContain("<pre");
  expect(html).not.toContain("hidden source");
});

test("the stylesheet occurrence limit remains per file when CSS work is shared", async () => {
  const work = createDownloadWork();
  for (let index = 0; index < 2; index++) {
    const html = await buildHtmlDocDownload({
      html: '<link rel="stylesheet" href="a.css">'.repeat(65),
      docPath: "doc.html",
      title: "Stylesheets",
      resolveAsset: async () => css("p{color:green}"),
      work,
    });
    expect(html.match(/<style>/g)).toHaveLength(64);
    expect(html.match(/Some content was left out/g)).toHaveLength(1);
  }
});

test("omitted downloads are exactly the safe page returned for an over-limit HTML doc", async () => {
  const title = "Doc <script>";
  const html = buildOmittedDownload({ title });
  const resolveAsset = vi.fn(async () => null);
  expect(
    await buildHtmlDocDownload({
      title,
      docPath: "doc.html",
      html: "<div>".repeat(600),
      resolveAsset,
    }),
  ).toBe(html);
  expect(resolveAsset).not.toHaveBeenCalled();
  expectHead(html);
  expect(html).not.toContain("<script>");
  const nodes = parsed(html);
  expect(hastText(nodes.find((node) => node.tagName === "title") as Element)).toBe(title);
  expect(nodes.find((node) => node.tagName === "body")?.children).toMatchObject([
    { tagName: "p", properties: { className: ["em-download-note"] } },
  ]);
  expect(nodes.find((node) => node.tagName === "body")?.children).toHaveLength(1);
  expect(nodes.some((node) => node.tagName === "style")).toBe(true);
});
