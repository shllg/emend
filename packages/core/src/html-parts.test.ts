import { BlockId, LIMITS } from "@recense/contract";
import { defaultTreeAdapter } from "parse5";
import { expect, test } from "vitest";
import { htmlPartHashes, htmlPartTexts } from "./html-parts.ts";
import { docNodes, parseDocHtml } from "./place/html.ts";
import { blockHash } from "./render/hash.ts";

test.each([
  ["<ul><li><p>Nested paragraph</p></li></ul>", ["Nested paragraph"]],
  ["<ul><li>Own <ul><li>Nested item</li></ul> tail</li></ul>", ["Own tail", "Nested item"]],
  ["<div>Before <b>bold <i>italic</i></b> after</div>", ["Before bold italic after"]],
  ["Body text <span>inline body text</span><p>Part</p>", ["Part"]],
  ["<section><p>First</p>Own text after the child</section>", ["Own text after the child", "First"]],
  ["<div>\n\t \u0085\u00a0\u2003</div><p>Cafe\u0301\n seed</p>", ["Café seed"]],
  ["<p>&#xfeff;</p><p>Changed</p>", ["Changed"]],
  ["<p> &#xfeff; </p><p>&#xfeff;Lead</p>", ["Lead"]],
  ["<table><caption>Caption</caption><tr><th>Head</th><td>Cell</td></tr></table>", ["Caption", "Head", "Cell"]],
] as const)("HTML parts use normalized own text in element start order: %s", (source, expected) => {
  expect(htmlPartTexts(parseDocHtml(source))).toEqual(expected);
});

test("omitted subtrees contribute no text, in HTML or foreign namespaces", () => {
  const source =
    "<div>Before" +
    ["script", "style", "template", "noscript"].map((tag) => `<${tag}>omitted</${tag}>`).join("") +
    "<svg><script>omitted</script><style>omitted</style><text> SVG</text></svg> after</div>";
  expect(htmlPartTexts(parseDocHtml(source))).toEqual(["Before SVG after"]);
});

test("duplicate hashes get occurrence suffixes and full IDs match BlockId", async () => {
  const tree = parseDocHtml("<p>Same</p><div>Other</div><p>Same</p><section>Same</section>");
  const same = await blockHash("Same");
  const hashes = await htmlPartHashes(tree);
  expect(hashes).toEqual([same, await blockHash("Other"), `${same}-2`, `${same}-3`]);
  const prefix = `doc-${await blockHash("docs/seed.html")}-`;
  for (const hash of hashes) expect(BlockId.safeParse(`${prefix}${hash}`).success).toBe(true);
});

test("empty parts do not spend the cap and only the first nonempty parts survive", () => {
  const source = Array.from({ length: LIMITS.htmlPartsPerDoc + 2 }, (_, i) => `<div> </div><p>Part ${i}</p>`).join("");
  const texts = htmlPartTexts(parseDocHtml(source));
  expect(texts).toHaveLength(LIMITS.htmlPartsPerDoc);
  expect(texts[0]).toBe("Part 0");
  expect(texts.at(-1)).toBe(`Part ${LIMITS.htmlPartsPerDoc - 1}`);
});

test("null trees and trees without body have no parts", async () => {
  expect(htmlPartTexts(null)).toEqual([]);
  expect(await htmlPartHashes(null)).toEqual([]);
  expect(htmlPartTexts(defaultTreeAdapter.createDocument())).toEqual([]);
  expect(htmlPartTexts(parseDocHtml("<body></body>"))).toEqual([]);
});

test("hostile markup is parsed as data, never executed or treated as HTML part text", async () => {
  const tree = parseDocHtml(
    '<p>Safe<script>throw new Error("executed")</script><img src="x" onerror="throw 1">' +
      '<a href="javascript:throw 2"> link</a><svg onload="throw 3"><text> SVG</text></svg></p>',
  );
  expect(htmlPartTexts(tree)).toEqual(["Safe link SVG"]);
  expect(await htmlPartHashes(tree)).toEqual([await blockHash("Safe link SVG")]);
  if (!tree) throw new Error("missing tree");
  const body = tree.childNodes.find((node) => defaultTreeAdapter.isElementNode(node) && node.tagName === "html");
  if (!body) throw new Error("missing html");
  const link = [...docNodes(body)].find((node) => defaultTreeAdapter.isElementNode(node) && node.tagName === "a");
  expect(link && defaultTreeAdapter.isElementNode(link) && link.attrs).toContainEqual({
    name: "href",
    value: "javascript:throw 2",
  });
});
