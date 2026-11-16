import { defaultTreeAdapter } from "parse5";
import { afterEach, expect, test, vi } from "vitest";
import { docText, HTML_NESTING_LIMIT, placeHtmlSpan } from "./html.ts";

afterEach(() => vi.restoreAllMocks());

function expectNestingCap(input: string) {
  const create = vi.spyOn(defaultTreeAdapter, "createElement");
  expect(docText(input)).toBeNull();
  expect(create.mock.calls.length).toBeGreaterThan(HTML_NESTING_LIMIT);
  // These recoveries can create one implied element per nested div, plus html/head/body.
  expect(create.mock.calls.length).toBeLessThanOrEqual(2 * HTML_NESTING_LIMIT + 3);
}

test.each([
  ["malformed attribute name", '<div a">', '">seed'],
  ["SVG title", "<svg><title>", "</title></svg>seed"],
  ["MathML style", "<math><style>", "</style></math>seed"],
  ["MathML title", "<math><title>", "</title></math>seed"],
  ["quoted mixed attribute", `<div a='x"'>`, "</div>seed"],
  ["table foster parenting", "<table>", "</table>seed"],
])("parser-stack cap handles %s with 50000 inner tags", (_, before, after) => {
  const input = before + "<div>".repeat(50000) + after;
  expectNestingCap(input);
});

test("malformed attributes cannot hide nesting from the parser-stack cap", () => {
  expect(docText(`<div a">${"<div>".repeat(600)}">seed`)).toBeNull();
});

test("mixed quotes inside a real quoted attribute preserve the document text", () => {
  expect(docText(`<div a='x"'>seed</div>`)).toBe("seed");
});

test("parser stack decreases on closes and implied end tags", () => {
  expect(docText("<div><span>seed</span></div>".repeat(600))).toBe("seed".repeat(600));
  expect(docText("<p>seed<p>soil".repeat(600))).toBe("seedsoil".repeat(600));
});

test("iterative traversal keeps foster-parented text in document order", () => {
  expect(docText("<body>before<table><div>fostered</div><tr><td>cell</td></tr></table>after")).toBe(
    "beforefosteredcellafter",
  );
});

test("caps the full parser stack at 512 entries including html and body", () => {
  expect(docText(`${"<div>".repeat(513)}seed${"</div>".repeat(513)}`)).toBeNull();
  expect(docText(`${"<div>".repeat(512)}seed${"</div>".repeat(512)}`)).toBeNull();
  expect(docText(`${"<div>".repeat(511)}seed${"</div>".repeat(511)}`)).toBeNull();
  expect(docText(`${"<div>".repeat(510)}seed${"</div>".repeat(510)}`)).toBe("seed");
  const chunk = `${"<div>".repeat(510)}seed${"</div>".repeat(510)}`;
  expect(docText(chunk.repeat(3))).toBe("seedseedseed");
});

test.each([10000, 50000])("rejects %s nested elements without throwing", (depth) => {
  const html = `${"<div>".repeat(depth)}seed${"</div>".repeat(depth)}`;
  expectNestingCap(html);
});

test.each(["li", "p"])("keeps text from 600 unclosed optional-end %s elements", (tag) => {
  expect(docText(`<${tag}>seed`.repeat(600))).toBe("seed".repeat(600));
});

test("ignores apparent tags in comments, attributes and script raw text", () => {
  const tags = "<div>".repeat(1000);
  expect(docText(`<body><!--${tags}--><script>const text = '${tags}';</script><p title='${tags}'>seed</p>`)).toBe(
    "seed",
  );
});

test("raw-text end tags are case-insensitive and plaintext ends scanning", () => {
  const tags = "<div>".repeat(1000);
  expect(docText(`<ScRiPt>${tags}</sCrIpT><p>seed</p>`)).toBe("seed");
  expect(docText(`<textarea>${tags}</textarea>`)).toBe(tags);
  expect(docText(`<plaintext>${tags}`)).toBe(tags);
});

test.each(["<div/>", "<div></p>", "<div></span>"])("parser recovery cannot bypass the cap with %s", (tag) => {
  expectNestingCap(`${tag.repeat(50000)}seed`);
});

test("scripting-enabled parsing keeps noscript text raw and out of the body", () => {
  const nested = `${"<div>".repeat(50000)}seed${"</div>".repeat(50000)}`;
  const create = vi.spyOn(defaultTreeAdapter, "createElement");
  expect(docText(`<noscript>${nested}</noscript><p>visible</p>`)).toBe("visible");
  expect(create).toHaveBeenCalledTimes(5);
  create.mockClear();
  expect(docText(`<body>visible<noscript>${nested}`)).toBe("visible");
  expect(create).toHaveBeenCalledTimes(4);
});

test("keeps text around several noscript subtrees", () => {
  expect(docText("<body>one<noscript>hidden</noscript>two<noscript>hidden</noscript>three")).toBe("onetwothree");
});

test("unparseable HTML text makes every HTML quote unplaced", () => {
  expect(
    placeHtmlSpan(null, { kind: "html-span", path: "docs/seed.html", quote: "seed", prefix: "", suffix: "" }),
  ).toEqual({ status: "unplaced", reason: "block-gone" });
});

test("extracts only body text, decodes entities, and normalizes NFC and whitespace", () => {
  expect(
    docText("<!doctype html><title>Not body</title><body><p> Cafe\u0301 &amp; <b>seeds</b></p>\n<p>grow.</p></body>"),
  ).toBe("Café & seeds grow.");
});

test("uses textContent without inventing separators for block or break elements", () => {
  expect(docText("<p>one</p><p>two<br>three</p>")).toBe("onetwothree");
});

test.each(["script", "style", "template", "noscript"])("drops the entire %s subtree", (tag) => {
  expect(docText(`<body>start <${tag}>hidden <b>seeds</b></${tag}> end</body>`)).toBe("start end");
});

test("does not execute scripts or count comments or attributes as document text", () => {
  expect(docText('<body><div title="seeds"></div><!-- seeds --><script>document.write("seeds")</script></body>')).toBe(
    "",
  );
});

test("drops nested template/noscript content under HTML parser recovery", () => {
  expect(
    docText("<body>visible<template><template>hidden</template></template><noscript><p>hidden</p></noscript>tail"),
  ).toBe("visibletail");
});

test("HTML placement requires exact context even for a unique quote", () => {
  expect(
    placeHtmlSpan("blue seeds grow", {
      kind: "html-span",
      path: "docs/garden.html",
      quote: "seeds",
      prefix: "red ",
      suffix: " grow",
    }),
  ).toEqual({ status: "unplaced", reason: "block-gone" });
});

test("HTML placement detects overlapping ambiguity", () => {
  expect(
    placeHtmlSpan("aaa", {
      kind: "html-span",
      path: "docs/garden.html",
      quote: "aa",
      prefix: "",
      suffix: "",
    }),
  ).toEqual({ status: "unplaced", reason: "ambiguous" });
});
