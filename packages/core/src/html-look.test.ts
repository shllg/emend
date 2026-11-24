import { defaultTreeAdapter, html } from "parse5";
import { expect, test } from "vitest";
import { htmlHeadings, htmlHeadingsFromTree } from "./doc-headings.ts";
import { HTML_STRUCTURE, htmlLook, htmlLookFromTree } from "./html-look.ts";
import { applyHtmlLook } from "./html-look-file.ts";
import { HTML_NESTING_LIMIT, parseDocHtml } from "./place/html.ts";

test.each([
  ["<main><h1>Plan</h1><section><p>Seeds</p></section></main>", "recense", "default"],
  ["<style>p { color: red }</style>", "recense", "default"],
  ['<link rel="Stylesheet preload" href="a.css">', "recense", "default"],
  ['<link rel="icon">', "recense", "default"],
  ["<svg><style>body { color: red }</style></svg>", "recense", "default"],
  ['<p style="color:#222">Seeds</p>', "recense", "default"],
  ['<body bgcolor="#000">Seeds</body>', "recense", "default"],
  ['<svg style="color:red"><path style="fill:red"/></svg>', "recense", "default"],
  ['<svg><foreignObject><p style="color:red">Seeds</p></foreignObject></svg>', "recense", "default"],
  ['<math><mtext><span style="color:red">Seeds</span></mtext></math>', "recense", "default"],
  ['<meta name="recense-look" content="custom">', "custom", "marked-custom"],
  ['<meta name="recense-look" content="recense"><style>p{}</style>', "recense", "marked-recense"],
  ['<meta name="  RECENSE-Look " content=" Custom ">', "custom", "marked-custom"],
  ['<meta name="recense-look" content="other">', "recense", "default"],
  ['<body><p>Body</p><meta name="recense-look" content="custom">', "custom", "marked-custom"],
  ['<meta name="recense-look" content="other"><meta name="recense-look" content="custom">', "custom", "marked-custom"],
  [
    '<meta name="recense-look" content="custom"><meta name="recense-look" content="recense">',
    "custom",
    "marked-custom",
  ],
  [
    '<meta name="recense-look" content="recense"><meta name="recense-look" content="custom">',
    "recense",
    "marked-recense",
  ],
  ['<svg><foreignObject><meta name="recense-look" content="custom"></foreignObject></svg>', "custom", "marked-custom"],
  ['<link rel="preload\tSTYLESHEET\nicon">', "recense", "default"],
  ['<link rel="preload\u00a0stylesheet">', "recense", "default"],
])("classifies %s", (source, look, reason) => {
  expect(htmlLook(source)).toMatchObject({ look, reason, outside: [], otherOutside: false });
});

test.each(["style", "bgcolor", "color", "text", "link", "vlink", "alink"])(
  "HTML %s attributes count as own styles even when empty",
  (attribute) => {
    expect(htmlLook(`<div ${attribute}>Seeds</div>`)).toMatchObject({
      look: "recense",
      reason: "default",
      ownStyles: true,
    });
  },
);

test.each([
  ['<template><meta name="recense-look" content="custom"></template>', "recense", "default"],
  ["<template><style>p{color:red}</style></template>", "recense", "default"],
  ['<template><link rel="stylesheet" href="a.css"></template>', "recense", "default"],
  [
    '<template><meta name="recense-look" content="custom"></template><meta name="recense-look" content="recense">',
    "recense",
    "marked-recense",
  ],
])("template contents are inert: %s", (source, look, reason) => {
  expect(htmlLook(source)).toMatchObject({ look, reason, outside: ["template"], otherOutside: false });
});

test.each(["open", "closed", "Open", "CLOSED"])("declarative shadow root %s contributes own styles", (mode) => {
  for (const content of [
    "<style>:host{font-family:Georgia}</style><p>x</p>",
    '<p style="font-family:Georgia">x</p>',
    '<link rel="Stylesheet preload" href="a.css"><p>x</p>',
    '<p color="red">x</p>',
  ])
    expect(htmlLook(`<div><template shadowrootmode="${mode}">${content}</template></div>`)).toMatchObject({
      look: "recense",
      reason: "default",
      ownStyles: true,
      outside: ["template"],
      otherOutside: false,
    });
});

test.each([" open ", "open ", "\topen", "closed\n"])(
  "padded shadowrootmode %j keeps template contents inert",
  (mode) => {
    expect(
      htmlLook(`<div><template shadowrootmode="${mode}"><style>p{color:red}</style></template></div>`),
    ).toMatchObject({
      look: "recense",
      reason: "default",
      outside: ["template"],
      otherOutside: false,
    });
  },
);

test("declarative shadow roots ignore marks and outside names", () => {
  const names = Array.from({ length: 21 }, (_, i) => `<x-${i}></x-${i}>`).join("");
  const source =
    '<div><template shadowrootmode="open"><meta name="recense-look" content="custom">' +
    `<form></form><x-\u00a0></x-\u00a0>${names}</template></div>`;
  expect(htmlLook(source)).toMatchObject({
    look: "recense",
    reason: "default",
    outside: ["template"],
    otherOutside: false,
  });
  expect(htmlLook(`${source}<meta name="recense-look" content="recense">`)).toMatchObject({
    look: "recense",
    reason: "marked-recense",
  });
  expect(
    htmlLook(
      '<div><template shadowrootmode="open"><meta name="recense-look" content="recense"><style>p{}</style></template></div>',
    ),
  ).toMatchObject({ look: "recense", reason: "default", ownStyles: true });
});

test("declarative shadow roots traverse nested roots but leave other templates inert", () => {
  const inner = '<div><template shadowrootmode="closed"><style>p{}</style></template></div>';
  expect(htmlLook(`<div><template shadowrootmode="open">${inner}</template></div>`)).toMatchObject({
    look: "recense",
    reason: "default",
    ownStyles: true,
    outside: ["template"],
    otherOutside: false,
  });
  for (const source of [
    '<div><template shadowrootmode="other"><style>p{}</style></template></div>',
    `<div><template shadowrootmode="other">${inner}</template></div>`,
    `<div><template shadowrootmode="open"><template>${inner}</template></template></div>`,
  ])
    expect(htmlLook(source)).toMatchObject({
      look: "recense",
      reason: "default",
      outside: ["template"],
      otherOutside: false,
    });
});

test("a document recense mark wins over declarative shadow styles", () => {
  expect(
    htmlLook(
      '<meta name="recense-look" content="recense"><div><template shadowrootmode="open"><style>:host{font-family:Georgia}</style></template></div>',
    ),
  ).toMatchObject({ look: "recense", reason: "marked-recense" });
});

test("outside names are HTML-only, distinct, sorted and limited to the first twenty", () => {
  const source =
    "<script></script><iframe></iframe><form></form><x-widget></x-widget><form></form>" +
    "<svg><g/><foreignObject><button>Skip</button></foreignObject></svg>" +
    "<math><mtext><input></mtext></math>";
  expect(htmlLook(source)).toMatchObject({
    look: "recense",
    reason: "default",
    outside: ["form", "iframe", "script", "x-widget"],
    otherOutside: false,
  });
  const names = Array.from({ length: 30 }, (_, i) => `x-${String(i).padStart(2, "0")}`);
  expect(
    htmlLook(
      names
        .toReversed()
        .map((name) => `<${name}></${name}>`)
        .join(""),
    ),
  ).toMatchObject({ outside: names.slice(0, 20), otherOutside: true });
  for (const name of ["html", "meta", "style", "figure", "details", "svg", "math"])
    expect(HTML_STRUCTURE.has(name)).toBe(true);
  for (const name of ["script", "iframe", "template", "button", "x-widget"])
    expect(HTML_STRUCTURE.has(name)).toBe(false);
});

test.each(["x unsafe", "x-\u00a0", `x-${"a".repeat(31)}`])("outside names omit unsafe %s", (name) => {
  const tree = defaultTreeAdapter.createDocument();
  defaultTreeAdapter.appendChild(tree, defaultTreeAdapter.createElement(name, html.NS.HTML, []));
  defaultTreeAdapter.appendChild(tree, defaultTreeAdapter.createElement("x-safe", html.NS.HTML, []));
  expect(htmlLookFromTree(tree)).toMatchObject({
    look: "recense",
    reason: "default",
    outside: ["x-safe"],
    otherOutside: true,
  });
});

test("unsafe names from parsed HTML never enter the outside list", () => {
  expect(htmlLook(`<x-\u00a0></x-\u00a0><x-${"a".repeat(31)}></x-${"a".repeat(31)}>`)).toMatchObject({
    outside: [],
    otherOutside: true,
  });
});

test.each([
  ["<script>alert(1)</script>", "recense", ["script"]],
  ["<img src=x onerror=alert(1)>", "recense", []],
  ['<a href="javascript:alert(1)">Link</a>', "recense", []],
  ['<style>@import url("https://evil.example/x.css")</style>', "recense", []],
  ['<link rel=stylesheet href="https://evil.example/x.css">', "recense", []],
] as const)("hostile markup is classified without changing content isolation: %s", (source, look, outside) => {
  expect(htmlLook(source)).toMatchObject({ look, outside });
});

test("a shared parse preserves headings and deep documents fail closed without recursion", () => {
  const source = "<title>Plan</title><h1>Title</h1><h2>Part <em>one</em></h2><h3>Child</h3>";
  const tree = parseDocHtml(source);
  expect(htmlHeadingsFromTree(tree)).toEqual(htmlHeadings(source));
  expect(htmlLookFromTree(tree)).toEqual(htmlLook(source));
  const deep = `${"<div>".repeat(HTML_NESTING_LIMIT * 4)}<p>Deep</p>`;
  expect(() => htmlLook(deep)).not.toThrow();
  expect(htmlLook(deep)).toMatchObject({ look: "custom", reason: "unreadable", outside: [], otherOutside: false });
  expect(htmlLookFromTree(null)).toMatchObject({
    look: "custom",
    reason: "unreadable",
    outside: [],
    otherOutside: false,
  });
  expect(htmlHeadingsFromTree(null)).toEqual([]);
});

test.each([
  "<style>p { color: #222 }</style>",
  '<p style="color:#222">Plan</p>',
  '<body bgcolor="#fff">Plan</body>',
  '<svg fill="#000"><path/></svg>',
  '<svg><path stroke="#000"/></svg>',
  "<svg><style>path { fill:#000 }</style></svg>",
  '<svg><path style="stroke:#000"/></svg>',
  '<math><mi style="color:#222">x</mi></math>',
  '<link rel="preload STYLESHEET" href="page.css">',
  '<style>@import "page.css";</style>',
  "<style>p{margin:0;BACKGROUND:#fff !IMPORTANT;}</style>",
  "<style>p{border-color:#222}</style>",
  "<style>p{color:/* note */#222}</style>",
  "<style>/* prefers-color-scheme: dark; light-dark(white, black) */p{color:#222}</style>",
  '<p style="/* light-dark(white, black) */color:#222">Plan</p>',
  "<style>p{color:#222}/* unclosed prefers-color-scheme: dark</style>",
  '<div><template shadowrootmode="open"><style>p{color:#222}</style></template></div>',
])("colours without a dark rule use light mode: %s", (source) => {
  expect(htmlLook(source)).toMatchObject({ look: "recense", reason: "default", colorScheme: "light" });
});

test.each([
  "<style>p{color:#222}@media (prefers-color-scheme: dark){p{color:white}}</style>",
  "<style>p{color:LIGHT-DARK(#222,white)}</style>",
  '<p style="color:light-dark(#222,white)">Plan</p>',
  '<link rel="stylesheet" media="(PREFERS-COLOR-SCHEME: dark)">',
  '<style media="(prefers-color-scheme: dark)">p{color:white}</style>',
  "<style>p{color:#222}</style><style>@media (prefers-color-scheme:dark){}</style>",
  "<style>p{margin:1px;font-family:serif}</style>",
  '<p style="margin:1px">Plan</p>',
  "<style>:root{--fg:#222}</style>",
  '<style>/* @import "page.css"; p{color:#222} */</style>',
  "<style>/* unclosed p{color:#222}</style>",
  "<template><style>p{color:#222}</style></template>",
  '<div><template shadowrootmode="closed"><style>p{color:light-dark(#222,white)}</style></template></div>',
  "<p>Plan</p>",
])("pages without fixed colours or with dark rules follow the mode: %s", (source) => {
  expect(htmlLook(source)).toMatchObject({ look: "recense", colorScheme: "auto" });
});

test.each(["", "inherit", "initial", "unset", "revert", "revert-layer", "currentColor", "transparent", "none"])(
  "colour keyword %j does not force light mode",
  (value) => {
    for (const source of [
      `<style>p{color: ${value} !important; background: ${value}}</style>`,
      `<p style="color:${value};border-color:${value}">Plan</p>`,
      `<svg fill="${value}"><path stroke="${value}"/></svg>`,
    ])
      expect(htmlLook(source).colorScheme).toBe("auto");
  },
);

test.each(["bgcolor", "color", "text", "link", "vlink", "alink"])(
  "HTML %s sets colours outside foreign content",
  (name) => {
    expect(htmlLook(`<p ${name}="#222">Plan</p>`)).toMatchObject({ ownStyles: true, colorScheme: "light" });
    expect(htmlLook(`<svg><foreignObject><p ${name}="#222">Plan</p></foreignObject></svg>`)).toMatchObject({
      ownStyles: false,
      colorScheme: "auto",
    });
  },
);

test.each(["fill", "stroke", "color", "stop-color", "flood-color", "lighting-color"])("SVG %s sets colours", (name) => {
  expect(htmlLook(`<svg><path ${name}="#222"/></svg>`)).toMatchObject({ ownStyles: false, colorScheme: "light" });
  for (const value of ["light-dark(#222, white)", "LIGHT-DARK(#222, white)"])
    expect(htmlLook(`<svg><path ${name}="${value}"/></svg>`)).toMatchObject({
      ownStyles: false,
      colorScheme: "auto",
    });
});

test.each([
  ['p::before{content:"/*"}p{color:#222}', "light"],
  ['p{color:#222}p::after{content:"prefers-color-scheme: dark"}', "light"],
  ['p{color:#222}p::after{content:"light-dark("}', "light"],
  ['p::before{content:";color:red"}', "auto"],
  ["div{background:url(prefers-color-scheme.png)}", "light"],
  ['p::before{content:"/*"}p{color:#222}@media (prefers-color-scheme: dark){p{color:#eee}}', "auto"],
  ["p::before{content:'/*'}p{color:#222}", "light"],
  [String.raw`p::before{content:"escaped \";color:red"}`, "auto"],
  [String.raw`p::before{content:'escaped \';color:red'}`, "auto"],
  ['p::before{content:"bad\n;color:#222}', "light"],
  ['p::before{content:"bad\n;content:"light-dark("}p{color:#222}', "light"],
  ['p::before{content:"escaped\\\n;light-dark("}p{color:#222}', "light"],
  ['p::before{content:"@import page.css"}', "auto"],
  ["p::before{content:url(data:;color:red;@import)}", "auto"],
  ["div{background:URL( \t\nprefers-color-scheme.png)}", "light"],
  ['div{background:url( "prefers-color-scheme.png")}', "light"],
  ["div{background:url('light-dark(.png')}", "light"],
  ["div{background:url(prefers-color-scheme.png", "light"],
  ["div{background:url(page.png)}@media(prefers-color-scheme:dark){div{color:white}}", "auto"],
  ['@import url("page.css");', "light"],
  ["p{co/**/lor:red}", "auto"],
  [String.raw`.quote\"{color:#222}`, "light"],
  [String.raw`.a\/*b{color:#222}`, "light"],
  [String.raw`div{background:url(icon\)prefers-color-scheme.png)}p{color:#222}`, "light"],
  [String.raw`p{color:#222}div{background:\75 rl(prefers-color-scheme.png)}`, "light"],
  [String.raw`p{color:#222}div{background:u\72 l(light-dark\(.png)}`, "light"],
  [String.raw`p{color:#222;--value:\url(prefers-color-scheme)}`, "light"],
  [String.raw`.quote\"{color:#222}@media (prefers-color-scheme: dark){p{color:#eee}}`, "auto"],
  [String.raw`p{color:#222;--value:url\(prefers-color-scheme)}`, "auto"],
  [".a\\\n{color:#222}", "light"],
  ["p{color:#222}\\", "light"],
])("CSS data does not become a colour declaration or dark rule: %s", (css, colorScheme) => {
  expect(htmlLook(`<style>${css}</style>`)).toMatchObject({ look: "recense", colorScheme });
});

test.each(["a", "Z", "0", "_", "-", "é"])("URL scanning respects a preceding %j", (prefix) => {
  expect(htmlLook(`<style>p{color:#222;--value:${prefix}url(prefers-color-scheme)}</style>`)).toMatchObject({
    colorScheme: "auto",
  });
});

test.each([
  String.raw`\000075rl`,
  String.raw`\000075 rl`,
  String.raw`\55\52\4c`,
  String.raw`u\72\l`,
  "\\75\trl",
  "\\75\nrl",
  "\\75\rrl",
  "\\75\frl",
])("escaped URL identifier %j keeps its value as data", (name) => {
  for (const value of ["prefers-color-scheme.png", '"light-dark(.png"', "'light-dark(.png'"])
    expect(htmlLook(`<style>p{color:#222}div{background:${name}(${value})}</style>`)).toMatchObject({
      colorScheme: "light",
    });
});

test.each([String.raw`\0rl`, String.raw`\d875rl`, String.raw`\110075rl`, String.raw`\0000750rl`])(
  "non-URL escaped identifier %j keeps its arguments as code",
  (name) => {
    expect(htmlLook(`<style>p{color:#222;--value:${name}(prefers-color-scheme)}</style>`)).toMatchObject({
      colorScheme: "auto",
    });
  },
);

test.each([
  'p::before{content:"escaped\\\r\n;light-dark("}p{color:#222}',
  "p{color:#222}div{background:\\75\r\nrl(prefers-color-scheme.png)}",
])("CSS escapes consume CRLF together: %j", (css) => {
  // Pass raw CSS to the scanner: the HTML parser would normalize CRLF to LF first.
  for (const inline of [false, true]) {
    const tree = defaultTreeAdapter.createDocument();
    const element = defaultTreeAdapter.createElement(
      inline ? "p" : "style",
      html.NS.HTML,
      inline ? [{ name: "style", value: css }] : [],
    );
    if (!inline) defaultTreeAdapter.insertText(element, css);
    defaultTreeAdapter.appendChild(tree, element);
    expect(htmlLookFromTree(tree)).toMatchObject({ look: "recense", colorScheme: "light" });
  }
});

test.each([
  ['content:"light-dark(";color:#222', "light"],
  ['content:";color:red"', "auto"],
  ['content:"/*";color:#222', "light"],
  ["background:url(prefers-color-scheme.png)", "light"],
  ['content:"light-dark(";color:light-dark(#222,white)', "auto"],
])("style attribute strings and URLs remain data: %s", (css, colorScheme) => {
  expect(htmlLook(`<p style='${css}'>Plan</p>`)).toMatchObject({ look: "recense", colorScheme });
});

test.each([
  ["unclosed comment", "/*", "", "auto", "x"],
  ["closed comment", "/*", "*/color:#222", "light", "x"],
  ["unclosed string", 'content:"', "", "auto", "x"],
  ["long declaration value", "color:", "", "light", "x"],
  ["repeated backslash escapes", "", "\n;color:#222", "light", String.raw`\";`],
  ["long escaped identifier", "--", "\n;color:#222", "light", String.raw`\78`],
])(
  "near-limit %s scans without throwing in a style element and attribute",
  (_name, prefix, suffix, colorScheme, fill) => {
    const length = 8_380_000 - prefix.length - suffix.length;
    const css = prefix + fill.repeat(Math.ceil(length / fill.length)).slice(0, length) + suffix;
    // Exercise both classifier paths with the same large input, without repeatedly parsing 8 MiB of HTML.
    for (const inline of [false, true]) {
      const tree = defaultTreeAdapter.createDocument();
      const element = defaultTreeAdapter.createElement(
        inline ? "p" : "style",
        html.NS.HTML,
        inline ? [{ name: "style", value: css }] : [],
      );
      if (!inline) defaultTreeAdapter.insertText(element, `p{${css}}`);
      defaultTreeAdapter.appendChild(tree, element);
      expect(htmlLookFromTree(tree)).toMatchObject({ look: "recense", ownStyles: true, colorScheme });
    }
  },
);

test("own styles are independent of the selected look and colour scheme", () => {
  for (const source of ["<style>p{}</style>", '<p style="">Plan</p>', '<link rel="stylesheet">', '<body bgcolor="">'])
    expect(htmlLook(source)).toMatchObject({ look: "recense", reason: "default", ownStyles: true });
  expect(htmlLook('<meta name="recense-look" content="custom"><style>p{color:#222}</style>')).toMatchObject({
    look: "custom",
    reason: "marked-custom",
    ownStyles: true,
    colorScheme: "auto",
  });
  expect(htmlLook('<meta name="recense-look" content="recense"><style>p{color:#222}</style>')).toMatchObject({
    look: "recense",
    reason: "marked-recense",
    ownStyles: true,
    colorScheme: "light",
  });
  expect(htmlLookFromTree(null)).toMatchObject({ ownStyles: false, colorScheme: "auto" });
});

test("hostile CSS declarations and an unclosed comment scan in linear time", () => {
  const source = `<style>${"{;a:".repeat(50_000)}/*${"*x".repeat(100_000)}</style>`;
  const start = performance.now();
  expect(htmlLook(source)).toMatchObject({ look: "recense", ownStyles: true, colorScheme: "auto" });
  expect(performance.now() - start).toBeLessThan(2000);
});

test.each([
  "<p>Plain page</p>",
  "<style>p{color:#222;background:white}</style><p>Light-only page</p>",
  "<style>p{color:#222}@media(prefers-color-scheme:dark){p{color:white}}</style><p>Both modes</p>",
])("the file look preserves all appearance metadata: %s", (page) => {
  const before = htmlLook(page);
  const styled = applyHtmlLook(page, {
    css: "@layer recense{:root{color:black}@media(prefers-color-scheme:dark){:root{color:white}}}",
    lightOnly: before.colorScheme === "light",
  });
  expect(htmlLook(styled)).toEqual(before);
});

test("the look marker does not exempt styles outside the recognised leading chunk", () => {
  for (const page of [
    "<style data-recense-look>p{color:red}</style><p>Plan</p>",
    '<!doctype html><title>Plan</title><meta charset="utf-8"><style data-recense-look>p{color:red}</style>',
    "<svg><style data-recense-look>text{fill:red}</style></svg>",
    '<div><template shadowrootmode="open"><style data-recense-look>p{color:red}</style></template></div>',
  ])
    expect(htmlLook(page)).toMatchObject({ look: "recense", ownStyles: true, colorScheme: "light" });
});

test("an unrecognised leading chunk retains its styles and the page's custom mark", () => {
  const page =
    '<!doctype html><meta charset="utf-8"><style data-recense-look>p{color:red}</STYLE>' +
    '<meta name="recense-look" content="custom"><p>Kept</p><!-- </style> -->';
  expect(htmlLook(page)).toMatchObject({ look: "custom", reason: "marked-custom", ownStyles: true });
});

test.each([
  ['<meta name="emend-look" content="custom">', "custom", "marked-custom"],
  ['<meta name="EMEND-LOOK" content=" Custom ">', "custom", "marked-custom"],
  ['<meta name="emend-look" content="emend"><style>p{}</style>', "recense", "marked-recense"],
  ['<meta name="recense-look" content="emend"><style>p{}</style>', "recense", "marked-recense"],
  ['<meta name="emend-look" content="other"><meta name="recense-look" content="custom">', "custom", "marked-custom"],
])("pages marked before the rename keep their meaning: %s", (source, look, reason) => {
  expect(htmlLook(source)).toMatchObject({ look, reason });
});
