import { expect, test } from "vitest";
import { LIMITS, pubStylesheetSafe } from "./index.ts";

test.each([
  ["closing tag", "body{content:'</style'}"],
  ["uppercase closing tag", "</STYLE>"],
  ["backslash", 'body{content:"\\"}'],
  ["escaped URL", String.raw`body{background:u\72l(https://evil.example/a.png)}`],
  ["escaped import", String.raw`@\69mport "a.css";`],
  ["import", '@IMPORT "data:text/css,body{}";'],
  ["image set", 'body{background:IMAGE-SET("data:image/png;base64,AA==" 1x)}'],
  ["prefixed image set", 'body{background:-webkit-image-set("a.png" 1x)}'],
  ["src function", '@font-face{src:SRC("data:font/woff2;base64,AA==")}'],
  ["remote URL", "body{background:url(https://evil.example/a.png)}"],
  ["relative URL", 'body{background:URL( "a.png")}'],
  ["external URL after a data URL", "body{background:url(data:image/png;base64,AA==),url(//evil.example/a.png)}"],
  ["byte limit", "x".repeat(LIMITS.pubStylesheetBytes + 1)],
  ["UTF-8 byte limit", "é".repeat(LIMITS.pubStylesheetBytes / 2 + 1)],
])("pub stylesheet rejects %s", (_name, css) => {
  expect(pubStylesheetSafe(css)).toBe(false);
});

test("pub stylesheet accepts data fonts, media comparisons and the exact UTF-8 byte limit", () => {
  for (const url of ["data:font/woff2;base64,AA==", ' "data:font/woff2;base64,AA=="', " 'DATA:font/woff2;base64,AA=='"])
    expect(
      pubStylesheetSafe(
        `@layer recense{@font-face{font-family:Test;src:url(${url})}@media(width<=767px){body{max-width:none}}}`,
      ),
    ).toBe(true);
  expect(pubStylesheetSafe('body::before{content:"<"}')).toBe(true);
  expect(pubStylesheetSafe("é".repeat(LIMITS.pubStylesheetBytes / 2))).toBe(true);
});

test("pub stylesheet permits only CSS whitespace before data URLs", () => {
  for (const whitespace of ["\u00a0", "\ufeff"])
    for (const quote of ["", '"', "'"])
      expect(pubStylesheetSafe(`body{background:url(${whitespace}${quote}data:image/png;base64,AA==${quote})}`)).toBe(
        false,
      );
  for (const whitespace of [" ", "\t", "\n", "\r", "\f", "\t\n"])
    for (const quote of ["", '"', "'"])
      expect(pubStylesheetSafe(`body{background:url(${whitespace}${quote}data:image/png;base64,AA==${quote})}`)).toBe(
        true,
      );
});
