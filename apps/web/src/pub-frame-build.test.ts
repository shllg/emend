// @vitest-environment node
import { LIMITS } from "@emend/contract";
import { expect, test } from "vitest";
import { checkPubStylesheet, pickPubStylesheet } from "../build/pub-frame.ts";

test("the pub sub-build must produce exactly one CSS asset", () => {
  const sheet = { type: "asset" as const, fileName: "assets/pub.css", source: "body{}" };
  expect(() => pickPubStylesheet([])).toThrow("Expected one pub stylesheet");
  expect(() => pickPubStylesheet([sheet, { ...sheet, fileName: "other.css" }])).toThrow("Expected one pub stylesheet");
  expect(
    pickPubStylesheet([
      { type: "chunk", fileName: "entry.js" },
      { type: "asset", fileName: "font.woff2", source: new Uint8Array() },
      sheet,
    ]),
  ).toBe(sheet.source);
  expect(pickPubStylesheet([{ ...sheet, source: new TextEncoder().encode(sheet.source) }])).toBe(sheet.source);
});

test.each([
  "body{background:url(https://evil.example/a.png)}",
  "body{background:url(./a.png)}",
  '@import "data:text/css,body{}";',
  'body{background:image-set("data:image/png;base64,AA==" 1x)}',
  'body{background:-webkit-image-set("a.png" 1x)}',
  String.raw`body{background:u\72l(https://evil.example/a.png)}`,
  String.raw`@\69mport "a.css";`,
  '@font-face{src:src("data:font/woff2;base64,AA==")}',
  "body{content:'</style'}",
  "</STYLE>",
  "x".repeat(LIMITS.pubStylesheetBytes + 1),
  "é".repeat(LIMITS.pubStylesheetBytes / 2 + 1),
])("rejects unsafe pub CSS %#", (css) => {
  expect(() => checkPubStylesheet(css)).toThrow();
});

test("accepts inline data fonts, minified media comparisons and the exact byte limit", () => {
  const css =
    '@layer emend{@font-face{font-family:Test;src:url("data:font/woff2;base64,AA==")}' +
    "@media (width<=767px){body{max-width:none}}}";
  expect(() => checkPubStylesheet(css)).not.toThrow();
  expect(() => checkPubStylesheet("é".repeat(LIMITS.pubStylesheetBytes / 2))).not.toThrow();
});
