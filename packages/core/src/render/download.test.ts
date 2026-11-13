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
    nodes
      .filter((el) => ["img", "use", "image"].includes(el.tagName))
      .every((el) => !el.properties.src && !el.properties.href),
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
  expect(html).toContain("<\\/style>");
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

test("removes active noscript contents even when the offline browser disables scripting", async () => {
  const { result } = htmlDoc(
    '<noscript><meta http-equiv="refresh" content="0;url=https://example.com"><img src="https://example.com/a.png"></noscript>',
  );
  // fromHtml parses with scripting disabled, so noscript contents are inspected too.
  const nodes = elements(fromHtml(await result));
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
