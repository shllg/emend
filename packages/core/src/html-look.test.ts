import { defaultTreeAdapter, html } from "parse5";
import { expect, test } from "vitest";
import { htmlHeadings, htmlHeadingsFromTree } from "./doc-headings.ts";
import { HTML_STRUCTURE, htmlLook, htmlLookFromTree } from "./html-look.ts";
import { HTML_NESTING_LIMIT, parseDocHtml } from "./place/html.ts";

test.each([
  ["<main><h1>Plan</h1><section><p>Seeds</p></section></main>", "emend", "structure"],
  ["<style>p { color: red }</style>", "custom", "own-styles"],
  ['<link rel="Stylesheet preload" href="a.css">', "custom", "own-styles"],
  ['<link rel="icon">', "emend", "structure"],
  ["<svg><style>body { color: red }</style></svg>", "custom", "own-styles"],
  ['<p style="color:#222">Seeds</p>', "custom", "own-styles"],
  ['<body bgcolor="#000">Seeds</body>', "custom", "own-styles"],
  ['<svg style="color:red"><path style="fill:red"/></svg>', "emend", "structure"],
  ['<svg><foreignObject><p style="color:red">Seeds</p></foreignObject></svg>', "emend", "structure"],
  ['<math><mtext><span style="color:red">Seeds</span></mtext></math>', "emend", "structure"],
  ['<meta name="emend-look" content="custom">', "custom", "marked-custom"],
  ['<meta name="emend-look" content="emend"><style>p{}</style>', "emend", "marked-emend"],
  ['<meta name="  EMEND-Look " content=" Custom ">', "custom", "marked-custom"],
  ['<meta name="emend-look" content="other">', "emend", "structure"],
  ['<body><p>Body</p><meta name="emend-look" content="custom">', "custom", "marked-custom"],
  ['<meta name="emend-look" content="other"><meta name="emend-look" content="custom">', "custom", "marked-custom"],
  ['<meta name="emend-look" content="custom"><meta name="emend-look" content="emend">', "custom", "marked-custom"],
  ['<meta name="emend-look" content="emend"><meta name="emend-look" content="custom">', "emend", "marked-emend"],
  ['<svg><foreignObject><meta name="emend-look" content="custom"></foreignObject></svg>', "custom", "marked-custom"],
  ['<link rel="preload\tSTYLESHEET\nicon">', "custom", "own-styles"],
  ['<link rel="preload\u00a0stylesheet">', "emend", "structure"],
])("classifies %s", (source, look, reason) => {
  expect(htmlLook(source)).toEqual({ look, reason, outside: [], otherOutside: false });
});

test.each(["style", "bgcolor", "color", "text", "link", "vlink", "alink"])(
  "HTML %s attributes count as own styles even when empty",
  (attribute) => {
    expect(htmlLook(`<div ${attribute}>Seeds</div>`)).toMatchObject({ look: "custom", reason: "own-styles" });
  },
);

test.each([
  ['<template><meta name="emend-look" content="custom"></template>', "emend", "structure"],
  ["<template><style>p{color:red}</style></template>", "emend", "structure"],
  ['<template><link rel="stylesheet" href="a.css"></template>', "emend", "structure"],
  [
    '<template><meta name="emend-look" content="custom"></template><meta name="emend-look" content="emend">',
    "emend",
    "marked-emend",
  ],
])("template contents are inert: %s", (source, look, reason) => {
  expect(htmlLook(source)).toEqual({ look, reason, outside: ["template"], otherOutside: false });
});

test.each(["open", "closed", "Open", "CLOSED"])("declarative shadow root %s contributes own styles", (mode) => {
  for (const content of [
    "<style>:host{font-family:Georgia}</style><p>x</p>",
    '<p style="font-family:Georgia">x</p>',
    '<link rel="Stylesheet preload" href="a.css"><p>x</p>',
    '<p color="red">x</p>',
  ])
    expect(htmlLook(`<div><template shadowrootmode="${mode}">${content}</template></div>`)).toEqual({
      look: "custom",
      reason: "own-styles",
      outside: ["template"],
      otherOutside: false,
    });
});

test.each([" open ", "open ", "\topen", "closed\n"])(
  "padded shadowrootmode %j keeps template contents inert",
  (mode) => {
    expect(htmlLook(`<div><template shadowrootmode="${mode}"><style>p{color:red}</style></template></div>`)).toEqual({
      look: "emend",
      reason: "structure",
      outside: ["template"],
      otherOutside: false,
    });
  },
);

test("declarative shadow roots ignore marks and outside names", () => {
  const names = Array.from({ length: 21 }, (_, i) => `<x-${i}></x-${i}>`).join("");
  const source =
    '<div><template shadowrootmode="open"><meta name="emend-look" content="custom">' +
    `<form></form><x-\u00a0></x-\u00a0>${names}</template></div>`;
  expect(htmlLook(source)).toEqual({ look: "emend", reason: "structure", outside: ["template"], otherOutside: false });
  expect(htmlLook(`${source}<meta name="emend-look" content="emend">`)).toMatchObject({
    look: "emend",
    reason: "marked-emend",
  });
  expect(
    htmlLook(
      '<div><template shadowrootmode="open"><meta name="emend-look" content="emend"><style>p{}</style></template></div>',
    ),
  ).toMatchObject({ look: "custom", reason: "own-styles" });
});

test("declarative shadow roots traverse nested roots but leave other templates inert", () => {
  const inner = '<div><template shadowrootmode="closed"><style>p{}</style></template></div>';
  expect(htmlLook(`<div><template shadowrootmode="open">${inner}</template></div>`)).toEqual({
    look: "custom",
    reason: "own-styles",
    outside: ["template"],
    otherOutside: false,
  });
  for (const source of [
    '<div><template shadowrootmode="other"><style>p{}</style></template></div>',
    `<div><template shadowrootmode="other">${inner}</template></div>`,
    `<div><template shadowrootmode="open"><template>${inner}</template></template></div>`,
  ])
    expect(htmlLook(source)).toEqual({
      look: "emend",
      reason: "structure",
      outside: ["template"],
      otherOutside: false,
    });
});

test("a document emend mark wins over declarative shadow styles", () => {
  expect(
    htmlLook(
      '<meta name="emend-look" content="emend"><div><template shadowrootmode="open"><style>:host{font-family:Georgia}</style></template></div>',
    ),
  ).toMatchObject({ look: "emend", reason: "marked-emend" });
});

test("outside names are HTML-only, distinct, sorted and limited to the first twenty", () => {
  const source =
    "<script></script><iframe></iframe><form></form><x-widget></x-widget><form></form>" +
    "<svg><g/><foreignObject><button>Skip</button></foreignObject></svg>" +
    "<math><mtext><input></mtext></math>";
  expect(htmlLook(source)).toEqual({
    look: "emend",
    reason: "structure",
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
  expect(htmlLookFromTree(tree)).toEqual({
    look: "emend",
    reason: "structure",
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
  ["<script>alert(1)</script>", "emend", ["script"]],
  ["<img src=x onerror=alert(1)>", "emend", []],
  ['<a href="javascript:alert(1)">Link</a>', "emend", []],
  ['<style>@import url("https://evil.example/x.css")</style>', "custom", []],
  ['<link rel=stylesheet href="https://evil.example/x.css">', "custom", []],
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
  expect(htmlLook(deep)).toEqual({ look: "custom", reason: "unreadable", outside: [], otherOutside: false });
  expect(htmlLookFromTree(null)).toEqual({ look: "custom", reason: "unreadable", outside: [], otherOutside: false });
  expect(htmlHeadingsFromTree(null)).toEqual([]);
});
