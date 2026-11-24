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

test.each([
  "CON",
  "prn",
  "AuX",
  "nul",
  ...Array.from({ length: 10 }, (_, n) => `cOm${n}`),
  ...Array.from({ length: 10 }, (_, n) => `LpT${n}`),
])("escapes reserved Windows stem %s in folder and file segments", (stem) => {
  expect(downloadDocNames([`${stem}/${stem}.md`, `${stem}.folder/${stem}.HTML`, stem])).toEqual([
    `docs/${stem}_/${stem}_.md.html`,
    `docs/${stem}_.folder/${stem}_.HTML`,
    `docs/${stem}_.html`,
  ]);
});

test("reserved Windows stems are escaped after cleaning and before disambiguation", () => {
  expect(downloadDocNames([".aux.-", "aux_", "CON.md", "con_.md", "com10/lpt10.md", "auxiliary/con-man.md"])).toEqual([
    "docs/aux_.html",
    "docs/aux_-2.html",
    "docs/CON_.md.html",
    "docs/con_.md-2.html",
    "docs/com10/lpt10.md.html",
    "docs/auxiliary/con-man.md.html",
  ]);
});
