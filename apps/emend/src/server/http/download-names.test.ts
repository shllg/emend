import { expect, test } from "vitest";
import { downloadDocNames } from "./download-names.ts";

test("doc entry names keep safe path segments and add the HTML extension", () => {
  expect(
    downloadDocNames(["plan.md", "folder/Page.HTML", ".hidden/..draft...md.-", "a /b+c.md", "../../", "\\x/é?", ""]),
  ).toEqual([
    "docs/plan.md.html",
    "docs/folder/Page.HTML",
    "docs/hidden/draft...md.html",
    "docs/a/b-c.md.html",
    "docs/_/_/_.html",
    "docs/-x/_.html",
    "docs/_.html",
  ]);
});

test("truncates segments before trimming trailing punctuation again", () => {
  expect(downloadDocNames([`${"x".repeat(79)}.-long/${"y".repeat(90)}.md`])).toEqual([
    `docs/${"x".repeat(79)}/${"y".repeat(80)}.html`,
  ]);
});

test("disambiguates names without case and allows ordinary shared folders", () => {
  expect(downloadDocNames(["a/b.md", "a/B.md", "a/b.md", "a/b.md-2.html", "a/c.md"])).toEqual([
    "docs/a/b.md.html",
    "docs/a/B.md-2.html",
    "docs/a/b.md-3.html",
    "docs/a/b.md-2-2.html",
    "docs/a/c.md.html",
  ]);
});

test("resolves file versus folder conflicts in either order", () => {
  expect(downloadDocNames(["a.html", "A.html/b.md", "a.html", "a-2.html"])).toEqual([
    "docs/a.html",
    "docs/A-2.html/b.md.html",
    "docs/a-3.html",
    "docs/a-2-2.html",
  ]);
  expect(downloadDocNames(["a.html/b.md", "A.html"])).toEqual(["docs/a.html/b.md.html", "docs/A-2.html"]);
});
