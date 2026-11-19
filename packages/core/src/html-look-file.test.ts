import { expect, test } from "vitest";
import {
  applyHtmlLook,
  HTML_LOOK_FILE_LAYER,
  type HtmlLookTheme,
  htmlLookInsertAt,
  htmlLookThemeRules,
  htmlLookThemeVars,
  stripHtmlLook,
} from "./html-look-file.ts";

const css =
  '@layer emend-file,emend;@font-face{font-family:Example;src:url("data:font/woff2;base64,AA==")}@layer emend{body{color:CanvasText}}';
const input = { css, lightOnly: false };
const marker = '<meta charset="utf-8"><style data-emend-look>';

test.each([
  "",
  "<!doctype html>",
  "<!-- leading -->\n<!doctype html>\n",
  "\uFEFF \n<!-- leading -->\n<!DOCTYPE html>\n",
])("inserts the exact chunk after preamble %j and strips it losslessly", (preamble) => {
  const page = `${preamble}<html lang="en"><head><title>Plan</title></head><body>Seeds</body></html>`;
  expect(HTML_LOOK_FILE_LAYER).toBe("emend-file");
  expect(htmlLookInsertAt(page)).toBe(preamble.length);
  const styled = applyHtmlLook(page, input);
  expect(styled).toBe(`${preamble}${marker}@layer emend-file{${css}}</style>\n${page.slice(preamble.length)}`);
  expect(applyHtmlLook(styled, input)).toBe(styled);
  expect(stripHtmlLook(styled)).toBe(page);
});

test.each([
  "<p>Unstyled</p>",
  "<style data-emend-look>body{}</style><p>No charset marker</p>",
  `${marker}body{}`,
  `<p>Not at the insertion point</p>${marker}body{}</style>`,
])("leaves a page without a complete leading chunk unchanged: %s", (page) => {
  expect(stripHtmlLook(page)).toBe(page);
});

test("strips only one directly following newline", () => {
  expect(stripHtmlLook(`${marker}body{}</style>\n\n<p>Seeds</p>`)).toBe("\n<p>Seeds</p>");
  expect(stripHtmlLook(`${marker}body{}</style><p>Seeds</p>`)).toBe("<p>Seeds</p>");
});

test("light-only pages get a removable light root before the charset and style", () => {
  const page = '<!doctype html><html lang="en"><style>p{color:#222}</style><p>Seeds</p></html>';
  const styled = applyHtmlLook(page, { ...input, lightOnly: true });
  expect(styled).toContain(`<!doctype html><html data-theme="light">${marker}`);
  expect(applyHtmlLook(styled, { ...input, lightOnly: true })).toBe(styled);
  expect(stripHtmlLook(styled)).toBe(page);
  expect(applyHtmlLook(styled, input)).not.toContain('<html data-theme="light">');
});

test.each(["dark", "light"] as const)("%s theme colours respect the reader and explicit root mode", (base) => {
  const theme: HtmlLookTheme = { base, scales: {}, tokens: { "border-1": "#123456" } };
  const vars = "--border-1:#123456;";
  const expected =
    base === "dark"
      ? `@media (prefers-color-scheme:dark){:root:not([data-theme=light]){${vars}}}:root[data-theme=dark]{${vars}}`
      : `@media not all and (prefers-color-scheme:dark){:root:not([data-theme=dark]){${vars}}}:root[data-theme=light]{${vars}}`;
  expect(htmlLookThemeRules(theme)).toBe(expected);
  expect(applyHtmlLook("<p>Seeds</p>", { ...input, theme })).toContain(`${css}${expected}}</style>`);
});

test("only known names with checked colours or token scale references become variables", () => {
  expect(
    htmlLookThemeVars({
      base: "dark",
      scales: { "n-0": "#123456", "n-25": "red", "n-50": "n-0", unknown: "#123456" },
      tokens: {
        "bg-app": "n-0",
        "border-1": "#abcdef",
        "fg-1": "bg-app",
        "fg-2": "url(https://example.com/a)",
        "fg-3": "</style><script>bad()</script>",
        unknown: "#123456",
      },
    }),
  ).toBe("--n-0:#123456;--bg-app:var(--n-0);--border-1:#abcdef;");
});

test.each([
  "</style><script>bad()</script>",
  "body{background:url(https://example.com/a)}",
  '@import "other.css";',
  String.raw`body{background:u\72l(other.png)}`,
])("refuses unsafe stylesheet %s", (css) => {
  expect(() => applyHtmlLook("<p>Seeds</p>", { css, lightOnly: false })).toThrow("Unsafe pub stylesheet");
});

test("the generated chunk has no script and only data URLs", () => {
  const chunk = applyHtmlLook("", input);
  expect(chunk).not.toMatch(/<script/i);
  const urls = [...chunk.matchAll(/url\(["']?([^)'" ]+)/gi)].map((match) => match[1]);
  expect(urls).toEqual(["data:font/woff2;base64,AA=="]);
});
