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
  ['<p style="color: red">Seeds</p>', "emend", "structure"],
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
  expect(htmlLook(source)).toEqual({ look, reason, outside: [] });
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
  });
  const names = Array.from({ length: 30 }, (_, i) => `x-${String(i).padStart(2, "0")}`);
  expect(
    htmlLook(
      names
        .toReversed()
        .map((name) => `<${name}></${name}>`)
        .join(""),
    ).outside,
  ).toEqual(names.slice(0, 20));
  for (const name of ["html", "meta", "style", "figure", "details", "svg", "math"])
    expect(HTML_STRUCTURE.has(name)).toBe(true);
  for (const name of ["script", "iframe", "template", "button", "x-widget"])
    expect(HTML_STRUCTURE.has(name)).toBe(false);
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
  expect(htmlLook(deep)).toEqual({ look: "custom", reason: "unreadable", outside: [] });
  expect(htmlLookFromTree(null)).toEqual({ look: "custom", reason: "unreadable", outside: [] });
  expect(htmlHeadingsFromTree(null)).toEqual([]);
});
