import { expect, test } from "vitest";
import type { HtmlElement, HtmlRoot } from "./blocks.ts";
import { randomTermCase } from "./doc-terms.cases.ts";
import { docTermMatcher } from "./doc-terms.ts";
import { markTerms, termMatcher } from "./terms.ts";

// The regex matcher of the writeup is the reference: the doc matcher must mark exactly what it marks.
type Entry = { term: string; aliases?: string[] };
type Child = HtmlElement["children"][number];

const c = (...codes: number[]) => String.fromCodePoint(...codes);
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
  [
    "whitespace runs",
    budget,
    ["hub node", "hub\tnode", "hub\nnode", `hub${c(0xa0)}node`, `hub${c(0x3000)}node`, `hub    ${c(0x2003)} node`],
  ],
  [
    "whitespace that is not a space",
    budget,
    [`hub${c(0x200b)}node`, "hubnode", `hub${c(0x180e)}node`, `hub${c(0xfeff)}node`],
  ],
  ["entry seen twice", budget, ["budget budget budget item allowance allowance", "budgets"]],
  [
    "word boundaries",
    budget,
    ["xbudget budgetx 1budget budget1 _budget budget_ budget-budget", `budget${c(0x301)} ${c(0x301)}budget`],
  ],
  [
    "astral neighbours",
    budget,
    [
      `${c(0x1d49c)}budget budget${c(0x1d49c)}`,
      `${c(0x1f600)}budget`,
      `budget${c(0x1f600)}`,
      `budget${c(0x1f600)} budget`,
    ],
  ],
  [
    "text that is not NFC",
    [{ term: `Caf${c(0xe9)}`, aliases: [`r${c(0xe9)}sum${c(0xe9)}`] }],
    [`cafe${c(0x301)} Cafe${c(0x301)}s caf${c(0xe9)}`, `re${c(0x301)}sume${c(0x301)} r${c(0xe9)}sum${c(0xe9)}`],
  ],
  [
    "forms that are not NFC",
    [{ term: `Cafe${c(0x301)}` }, { term: `res${c(0x301)}` }],
    [`Caf${c(0xe9)} cafe${c(0x301)} ress${c(0x301)}`],
  ],
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
  ["s", "S", c(0x17f)],
  [c(0x3c2), c(0x3c3), c(0x3a3)],
  [c(0x212a), "k", "K"],
  [c(0xb5), c(0x3bc), c(0x39c)],
  [c(0xdf), c(0x1e9e)],
  [c(0x130), c(0x131), "i", "I"],
  [c(0xab70), c(0x13a0)],
  [c(0x10428), c(0x10400)],
  [c(0x390), c(0x1fd3)],
  [c(0x3b0), c(0x1fe3)],
  [c(0xfb05), c(0xfb06)],
];
test.each(foldGroups)("doc matcher equals the reference for the fold group %s", (...group) => {
  for (const form of group) {
    const entries: Entry[] = [{ term: `x${form}y` }, { term: `${form}${form}` }, { term: form }];
    const tree = paragraphs(...group.map((other) => `x${other}y ${other}${other} ${other}s ${other}es ${other}ES`));
    same(entries, tree);
  }
});

// Seeds 1 to 400 in 8 chunks, so no single test nears the default timeout under load. The generator, the
// pieces and the gaps live in doc-terms.cases.ts, which the bridge's step-parity test shares.
test.each(Array.from({ length: 8 }, (_, chunk) => chunk * 50 + 1))(
  "doc matcher equals the reference on seeded random glossaries and texts, seeds %i and the next 49",
  (first) => {
    for (let seed = first; seed < first + 50; seed++) {
      const { entries, values } = randomTermCase(seed);
      const tree = paragraphs(...values);
      try {
        same(entries, tree);
      } catch (error) {
        throw new Error(`seed ${seed}: ${JSON.stringify({ entries, values })}\n${String(error)}`);
      }
    }
  },
);
