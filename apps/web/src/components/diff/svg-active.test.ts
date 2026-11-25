import { expect, test } from "vitest";
import { svgActiveKinds } from "./svg-active.ts";

test("recognises active SVG tags, attributes and URLs regardless of case or quoting", () => {
  expect(
    svgActiveKinds(
      '<SVG><ScRiPt/><g title="a > b" OnLoAd = "run()"/><FOREIGNobject/><use XLINK:HREF=external.svg /></SVG>',
    ),
  ).toEqual(["a script", "an event handler", "embedded HTML", "an outside link"]);
  expect(svgActiveKinds('<a href=" JaVaScRiPt:void(0)"/>')).toEqual(["a script", "an outside link"]);
  expect(svgActiveKinds("<style>g {fill: URL( '../paint.svg#g' )}</style>")).toEqual(["an outside link"]);
  expect(svgActiveKinds("<image src='//example.test/pic'/>")).toEqual(["an outside link"]);
});

test("local references, data URLs and attribute-like prose are clean", () => {
  expect(
    svgActiveKinds(
      '<svg><use href="#leaf"/><g style="fill:url( #paint )" title=" onload=example"/><image src="DATA:image/png;base64,AA=="/><text> onload=example</text></svg>',
    ),
  ).toEqual([]);
});
