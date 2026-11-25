import { expect, test } from "vitest";
import { scanSvg } from "./svg-active.ts";

test("recognises active SVG tags, attributes and URLs regardless of case or quoting", () => {
  expect(
    scanSvg('<SVG><ScRiPt/><g title="a > b" OnLoAd = "run()"/><FOREIGNobject/><use XLINK:HREF=external.svg /></SVG>')
      .kinds,
  ).toEqual(["a script", "an event handler", "embedded HTML", "an outside link"]);
  expect(scanSvg('<a href=" JaVaScRiPt:void(0)"/>').kinds).toEqual(["a script", "an outside link"]);
  expect(scanSvg("<style>g {fill: URL( '../paint.svg#g' )}</style>").kinds).toEqual(["an outside link"]);
  expect(scanSvg("<image src='//example.test/pic'/>").kinds).toEqual(["an outside link"]);
});

test("local references, data URLs and attribute-like prose are clean", () => {
  expect(
    scanSvg(
      '<svg><use href="#leaf"/><g style="fill:url( #paint )" title=" onload=example"/><image src="DATA:image/png;base64,AA=="/><text> onload=example</text></svg>',
    ),
  ).toEqual({ kinds: [], unchecked: false });
});

test.each([
  ["<s:ScRiPt/>", "a script"],
  ["<svg:foreignObject/>", "embedded HTML"],
  ['<g x:OnLoad=""/>', "an event handler"],
  ['<use p:hReF="other.svg"/>', "an outside link"],
  ['<image p:sRc="other.png"/>', "an outside link"],
] as const)("checks the local name in %s", (source, kind) => {
  expect(scanSvg(source).kinds).toEqual([kind]);
});

test.each(["&#106;avascript:", "&#x6A;avascript:", "java&#x9;script:", "J aVa\nScrIpt&#13;:"])(
  "recognises the script scheme in %s",
  (scheme) => {
    expect(scanSvg(`<a href="${scheme}"/>`).kinds).toEqual(["a script", "an outside link"]);
    expect(scanSvg(`<text>${scheme}</text>`).kinds).toEqual(["a script"]);
  },
);

test("ASCII controls between scheme characters are ignored", () => {
  const scheme = [..."javascript:"].join(String.fromCharCode(31, 127));
  expect(scanSvg(scheme).kinds).toEqual(["a script"]);
});

test("decodes URL values without turning escaped quotes or markup into attributes or tags", () => {
  const source =
    '<g title="&lt;script/&gt; &amp; &quot; onload=&apos;x&apos;" fill="url(&quot;#ink&quot;)" stroke="url(&apos;#line&apos;)" href="&#35;local"/>';
  expect(scanSvg(source)).toEqual({ kinds: [], unchecked: false });
});

test.each([
  '<s:set to="other.svg" attributeName="x:href"/>',
  '<animate attributeName="src" from="other.svg"/>',
  '<animateMotion by="other.svg" attributeName="HREF"/>',
  '<animateTransform values="#first; other.svg; #last" attributeName="p:src"/>',
])("checks URLs in animation values in %s", (source) => {
  expect(scanSvg(source).kinds).toEqual(["an outside link"]);
});

test("animation checks distinguish scripts, local links and ordinary values", () => {
  expect(scanSvg('<set attributeName="href" values="#one; java&#9;script:; #two"/>').kinds).toEqual([
    "a script",
    "an outside link",
  ]);
  expect(
    scanSvg('<set attributeName="href" values="&#35;one;#two"/><animate attributeName="x" by="2"/>').kinds,
  ).toEqual([]);
});

test.each([
  '<style>@import "theme.css";</style>',
  "<style>@import url(#theme);</style>",
  '<?xml-stylesheet href="theme.css"?>',
])("reports a stylesheet reference in %s", (source) => {
  expect(scanSvg(source).kinds).toEqual(["an outside link"]);
});

test("an entity declaration makes the source unchecked", () => {
  expect(scanSvg('<!DOCTYPE svg [<!ENTITY label "Leaf">]><svg><script/></svg>')).toEqual({
    kinds: [],
    unchecked: true,
  });
});
