import { expect, test } from "vitest";
import type { HtmlElement, HtmlRoot } from "./blocks.ts";
import { docTermMatcher } from "./doc-terms.ts";
import { markTerms, termMatcher } from "./terms.ts";

// The regex matcher of the writeup is the reference: the doc matcher must mark exactly what it marks.
type Entry = { term: string; aliases?: string[] };
type Child = HtmlElement["children"][number];

const text = (value: string): Child => ({ type: "text", value });
const element = (tagName: string, ...children: Child[]): HtmlElement => ({
  type: "element",
  tagName,
  properties: {},
  children,
});
const paragraphs = (...values: string[]): HtmlRoot => ({
  type: "root",
  children: values.map((value) => element("p", text(value))),
});

const apply = (tree: HtmlRoot, terms: unknown) => {
  const copy = structuredClone(tree);
  markTerms()(copy, { data: { terms } });
  return copy;
};
const reference = (entries: Entry[], tree: HtmlRoot) => apply(tree, termMatcher(entries, Number.MAX_SAFE_INTEGER));
const doc = (entries: Entry[], tree: HtmlRoot) => apply(tree, docTermMatcher(entries, Number.MAX_SAFE_INTEGER));
const same = (entries: Entry[], tree: HtmlRoot) => expect(doc(entries, tree)).toEqual(reference(entries, tree));
const markCount = (tree: HtmlRoot) => JSON.stringify(tree).split('"emend-term"').length - 1;

const budget: Entry[] = [{ term: "budget", aliases: ["budget item", "allowance"] }, { term: "hub node" }];
test.each([
  ["case variants", budget, ["Budget BUDGET budget bUdGeT", "an ALLOWANCE, then Allowance"]],
  ["s and es suffixes", budget, ["budgets", "budgetes", "budgetS", "budgetES", "budgetEs", "budgetSs", "budgetesx"]],
  ["longest form first", budget, ["budget item", "the budget items, then budget", "budget ite", "budget  \t item!"]],
  ["whitespace runs", budget, ["hub node", "hub\tnode", "hub\nnode", "hub node", "hub　node", "hub      node"]],
  ["whitespace that is not a space", budget, ["hub​node", "hubnode", "hub᠎node", "hub﻿node"]],
  ["entry seen twice", budget, ["budget budget budget item allowance allowance", "budgets"]],
  ["word boundaries", budget, ["xbudget budgetx 1budget budget1 _budget budget_ budget-budget", "budget́ ́budget"]],
  ["astral neighbours", budget, ["\u{1D49C}budget budget\u{1D49C}", "😀budget", "budget😀", "budget😀 budget"]],
  ["text that is not NFC", [{ term: "Café", aliases: ["résumé"] }], ["café Cafés café", "résumé résumé"]],
  ["forms that are not NFC", [{ term: "Café" }, { term: "reś" }], ["Café café resś"]],
  [
    "regex metacharacters",
    [{ term: "C++", aliases: ["a.b", "(x)", "[y]", "a|b", "$z^", "\\w+"] }],
    ["C++ a.b (x) [y] a|b $z^ \\w+ aab", "C++s"],
  ],
  ["acronyms", [{ term: "API" }], ["API", "api", "APIs", "APIS", "APIes", "APIES", "Api", "an API", "apis"]],
  ["acronym and plain form", [{ term: "API" }, { term: "api key" }], ["api key", "API key", "API KEY", "apis"]],
  ["acronym with a space", [{ term: "AB CD" }], ["AB CD", "ab cd", "AB  CD", "AB\tCDs", "AB cd"]],
  [
    "overlapping forms",
    [{ term: "ab" }, { term: "abc" }, { term: "bcd" }, { term: "a b c d" }],
    ["abcd a b c d abc bcd ab"],
  ],
  ["ties keep the entry order", [{ term: "alpha" }, { term: "ALPHA", aliases: ["Alpha"] }], ["alpha Alpha ALPHA"]],
  ["empty forms", [{ term: "  " }, { term: "hub", aliases: ["", " \t "] }], ["a hub"]],
])("doc matcher equals the reference: %s", (_name, entries, texts) => {
  const tree = paragraphs(...texts);
  same(entries, tree);
  // The comparison is only worth something when the group marks something.
  expect(markCount(doc(entries, tree))).toBeGreaterThan(0);
});

test("doc matcher equals the reference next to inline elements", () => {
  const tree: HtmlRoot = {
    type: "root",
    children: [
      element("p", text("budget"), element("em", text("s")), text(" and a "), element("b", text("budget")), text("ed")),
      element("p", element("em", text("hub")), text(" node"), text(" budget"), element("code", text(" budget"))),
      element("p", text("hub "), element("span", text("node")), text(" budget"), element("strong", text("x"))),
      element("p", text("x"), element("span", text("budget")), text("s")),
      element("p", text("budget"), element("br"), text("budget")),
    ],
  };
  same(budget, tree);
  expect(markCount(doc(budget, tree))).toBeGreaterThan(0);
});

// Characters whose case folding crosses scripts and lengths.
const foldGroups = [
  ["s", "S", "ſ"],
  ["ς", "σ", "Σ"],
  ["K", "k", "K"],
  ["µ", "μ", "Μ"],
  ["ß", "ẞ"],
  ["İ", "ı", "i", "I"],
  ["ꭰ", "Ꭰ"],
  ["\u{10428}", "\u{10400}"],
  ["ΐ", "ΐ"],
  ["ΰ", "ΰ"],
  ["ﬅ", "ﬆ"],
];
test.each(foldGroups)("doc matcher equals the reference for the fold group %s", (...group) => {
  for (const form of group) {
    const entries: Entry[] = [{ term: `x${form}y` }, { term: `${form}${form}` }, { term: form }];
    const tree = paragraphs(...group.map((other) => `x${other}y ${other}${other} ${other}s ${other}es ${other}ES`));
    same(entries, tree);
  }
});

// A small seeded generator, so a failure repeats.
function generator(seed: number) {
  let state = seed;
  return (limit: number) => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * limit);
  };
}
const pieces = [
  "budget",
  "Budget",
  "BUDGET",
  "hub",
  "API",
  "api",
  "APIs",
  "C++",
  "a.b",
  "(x)",
  "ſ",
  "ς",
  "σ",
  "Σ",
  "K",
  "k",
  "K",
  "µ",
  "μ",
  "ß",
  "ẞ",
  "İ",
  "ı",
  "i",
  "I",
  "ꭰ",
  "Ꭰ",
  "\u{10428}",
  "\u{10400}",
  "\u{1D49C}",
  "😀",
  "é",
  "é",
  "́",
  "漢",
  "x",
  "s",
  "es",
  "ES",
  "S",
  "item",
  "Zoé",
  "1",
  "_",
  "-",
  ".",
  "ΐ",
  "ΐ",
  "ﬅ",
  "ab",
  "AB",
  "CD",
];
const gaps = ["", "", " ", " ", "  ", "\t", "\n", " ", "　", "   ", "-", "_", "1", "́", "​"];

// Seeds 1 to 400 in 8 chunks, so no single test nears the default timeout under load.
test.each(Array.from({ length: 8 }, (_, chunk) => chunk * 50 + 1))(
  "doc matcher equals the reference on seeded random glossaries and texts, seeds %i and the next 49",
  (first) => {
    for (let seed = first; seed < first + 50; seed++) {
      const next = generator(seed);
      const pick = <T>(list: T[]) => list[next(list.length)] as T;
      const form = () => Array.from({ length: 1 + next(3) }, () => pick(pieces)).join(pick([" ", " ", "  ", ""]));
      const entries: Entry[] = Array.from({ length: 1 + next(6) }, () => ({
        term: form(),
        aliases: Array.from({ length: next(3) }, form),
      }));
      // Texts reuse the forms so that matches are common, with random gaps and suffixes around them.
      const forms = entries.flatMap((entry) => [entry.term, ...(entry.aliases ?? [])]);
      const piece = () => (next(3) === 0 ? pick(forms).replace(/ /g, pick(gaps)) : pick(pieces));
      const values = Array.from({ length: 1 + next(3) }, () =>
        Array.from(
          { length: 2 + next(14) },
          () => `${piece()}${next(4) === 0 ? pick(["s", "es", "S", "ES"]) : ""}`,
        ).reduce((joined, part) => `${joined}${pick(gaps)}${part}`),
      );
      const tree = paragraphs(...values);
      try {
        same(entries, tree);
      } catch (error) {
        throw new Error(`seed ${seed}: ${JSON.stringify({ entries, values })}\n${String(error)}`);
      }
    }
  },
);
