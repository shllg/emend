import { expect, test } from "vitest";
import type { HtmlElement, HtmlRoot } from "./blocks.ts";
import { docTermMatcher, foldCodePoint, isSpaceUnit } from "./doc-terms.ts";
import { DOC_TERM_MATCH_STEP_BUDGET, markTerms } from "./terms.ts";

type Entry = { term: string; aliases?: string[] };
const escapePattern = (text: string) => text.replace(/[\^$\\.*+?()[\]{}|/]/g, "\\$&");
const single = (text: string) => ((text.codePointAt(0) ?? 0) > 0xffff ? text.length === 2 : text.length === 1);

test("the fold equals /x/iu on the whole BMP and on the cased pairs", () => {
  const failures: string[] = [];
  const cased: number[] = [];
  for (let code = 0; code <= 0xffff; code++) {
    if (code >= 0xd800 && code <= 0xdfff) continue;
    const char = String.fromCodePoint(code);
    const folded = foldCodePoint(code);
    if (!new RegExp(`^${escapePattern(String.fromCodePoint(folded))}$`, "iu").test(char))
      failures.push(`${code}: k not equal`);
    if (foldCodePoint(folded) !== folded) failures.push(`${code}: not idempotent`);
    const lower = char.toLowerCase();
    const upper = char.toUpperCase();
    const around = [lower, upper, upper.toLowerCase(), lower.toUpperCase()].filter(single);
    for (const other of around) {
      if (
        new RegExp(`^${escapePattern(char)}$`, "iu").test(other) &&
        foldCodePoint(other.codePointAt(0) ?? 0) !== folded
      )
        failures.push(`${code}: ${other.codePointAt(0)} split`);
    }
    if (lower !== char || upper !== char) cased.push(code);
  }
  // Every pair of cased BMP characters falls in one class exactly when the regex says so.
  for (const code of cased) {
    const pattern = new RegExp(`^${escapePattern(String.fromCodePoint(code))}$`, "iu");
    for (const other of cased)
      if (pattern.test(String.fromCodePoint(other)) !== (foldCodePoint(code) === foldCodePoint(other)))
        failures.push(`${code} vs ${other}`);
  }
  expect(failures).toEqual([]);
});

test("the fold keeps astral case pairs together and the exceptions apart", () => {
  const same = [
    ["\u{10428}", "\u{10400}"],
    ["\u{1D49C}", "\u{1D49C}"],
    ["\u{104d8}", "\u{104b0}"],
    ["\u{1e922}", "\u{1e900}"],
    ["ꭰ", "Ꭰ"],
  ] as const;
  for (const [a, b] of same) {
    expect(foldCodePoint(a.codePointAt(0) ?? 0)).toBe(foldCodePoint(b.codePointAt(0) ?? 0));
    expect(new RegExp(`^${a}$`, "iu").test(b)).toBe(true);
  }
  // Dotless i is not an i, and the two upper-case sharp s forms meet.
  expect(foldCodePoint(0x131)).not.toBe(foldCodePoint(0x69));
  expect(foldCodePoint(0x1e9e)).toBe(foldCodePoint(0xdf));
  expect(foldCodePoint(0x212a)).toBe(foldCodePoint(0x6b));
  expect(foldCodePoint(0x17f)).toBe(foldCodePoint(0x73));
});

test("isSpaceUnit is JavaScript's \\s on every code unit", () => {
  const failures: number[] = [];
  for (let unit = 0; unit <= 0xffff; unit++)
    if (isSpaceUnit(unit) !== /\s/.test(String.fromCharCode(unit))) failures.push(unit);
  expect(failures).toEqual([]);
});

const element = (tagName: string, ...children: HtmlElement["children"]): HtmlElement => ({
  type: "element",
  tagName,
  properties: {},
  children,
});
const paragraphs = (...values: string[]): HtmlRoot => ({
  type: "root",
  children: values.map((value) => element("p", { type: "text", value })),
});
const marked = (tree: HtmlRoot) => {
  const found: [string, string][] = [];
  const visit = (node: HtmlRoot | HtmlElement) => {
    for (const child of node.children) {
      if (child.type !== "element") continue;
      const className = child.properties.className;
      if (Array.isArray(className) && className.includes("emend-term"))
        found.push([
          String(child.properties.dataEmendTerm),
          child.children.map((c) => (c.type === "text" ? c.value : "")).join(""),
        ]);
      visit(child);
    }
  };
  visit(tree);
  return found;
};
const run = (entries: Entry[], tree: HtmlRoot, budget = DOC_TERM_MATCH_STEP_BUDGET) => {
  const matcher = docTermMatcher(entries, budget);
  markTerms()(tree, { data: { terms: matcher } });
  return { matcher, marks: marked(tree), steps: budget - matcher.remaining };
};

test("coverage: 50 terms with 3 aliases each are all marked in a 60,000-character doc", () => {
  const letters = "bcdfghjklmnpqrstvwxz";
  const forms = Array.from({ length: 50 }, (_, index) => {
    const name = (prefix: string, length: number) =>
      `${prefix}${index}${Array.from({ length }, (_, at) => letters[(index + at * 3) % letters.length]).join("")}`.slice(
        0,
        length,
      );
    return {
      term: name("term", 10 + (index % 11)),
      aliases: [name("alias", 10), name("other", 15), name("third", 20)],
    };
  });
  const filler = "Plain words fill this paragraph with ordinary prose. ";
  let prose = "";
  for (let index = 0; index < 50; index++) {
    const forms3 = forms[index] as Required<Entry>;
    const use = [forms3.term, ...forms3.aliases][index % 4] as string;
    while (prose.length < index * 1200) prose += filler;
    prose += `Here ${use} appears. `;
  }
  while (prose.length < 60_000) prose += filler;
  const { marks, steps } = run(forms, paragraphs(prose));
  expect(prose.length).toBeGreaterThanOrEqual(60_000);
  expect(marks.map(([entry]) => Number(entry))).toEqual(Array.from({ length: 50 }, (_, index) => index));
  // Ordinary prose costs about one or two steps per character; the doc budget is nowhere near spent.
  expect(steps).toBeLessThan(prose.length * 3);
});

// The 450-form shape: 50 entries with 9 forms, each 48 one-letter words and a 3-digit index.
const hostileEntries = (word: string): Entry[] =>
  Array.from({ length: 50 }, (_, term) => {
    const form = (alias: number) => `${Array(48).fill(word).join(" ")} ${String(term * 9 + alias).padStart(3, "0")}`;
    return { term: form(0), aliases: Array.from({ length: 8 }, (_, alias) => form(alias + 1)) };
  });

// No wall-clock assertions: each case finishes inside Vitest's default timeout, and the step counts below
// were measured when this test was written (they are comments, not assertions).
test("hostile: one paragraph of 4,400 words marks nothing (about 640,000 steps)", () => {
  const { marks, steps } = run(hostileEntries("a"), paragraphs("a ".repeat(4400)));
  expect(marks).toEqual([]);
  expect(steps).toBeGreaterThan(0);
  expect(steps).toBeLessThan(DOC_TERM_MATCH_STEP_BUDGET);
});

test("hostile: 200 paragraphs of 440 characters mark nothing (about 5,800,000 steps)", () => {
  const { marks, matcher } = run(hostileEntries("a"), paragraphs(...Array(200).fill("a ".repeat(220))));
  expect(marks).toEqual([]);
  expect(matcher.remaining).toBeGreaterThan(0);
});

test("hostile: the same with U+3000 between the words", () => {
  const { marks, matcher } = run(hostileEntries("a"), paragraphs(...Array(200).fill("a　".repeat(220))));
  expect(marks).toEqual([]);
  expect(matcher.remaining).toBeGreaterThan(0);
});

test("hostile: a doc far beyond the budget stops at the budget and marks nothing", () => {
  const { marks, matcher } = run(hostileEntries("a"), paragraphs(...Array(400).fill("a ".repeat(2500))));
  expect(marks).toEqual([]);
  expect(matcher.remaining).toBe(0);
});

test("hostile: acronym forms against lowercase text refuse every position", () => {
  const text = `${"a ".repeat(48)}000 `.repeat(10);
  const { marks, steps } = run(hostileEntries("A"), paragraphs(...Array(200).fill(text)));
  expect(marks).toEqual([]);
  expect(steps).toBeGreaterThan(0);
  // The same text marks the first form when its letters are right.
  const exact = run(hostileEntries("a"), paragraphs(text));
  expect(exact.marks).toEqual([["0", `${"a ".repeat(48)}000`]]);
});

test("a form with a mark that is already placed costs steps but marks no second time", () => {
  const { marks } = run([{ term: "hub" }], paragraphs("hub hub hub", "hubs"));
  expect(marks).toEqual([["0", "hub"]]);
});

test("budget accounting: marking stops at a deterministic step and keeps the earlier text nodes", () => {
  const entries = [{ term: "hub" }, { term: "lease" }];
  const first = run(entries, paragraphs("a hub"));
  const second = run(entries, paragraphs("the lease"));
  expect(first.marks).toEqual([["0", "hub"]]);
  expect(second.marks).toEqual([["1", "lease"]]);
  expect(first.steps).toBeGreaterThan(0);
  expect(second.steps).toBeGreaterThan(0);
  const both = () => paragraphs("a hub", "the lease");
  const total = first.steps + second.steps;
  const exact = run(entries, both(), total);
  expect(exact.marks).toEqual([
    ["0", "hub"],
    ["1", "lease"],
  ]);
  expect(exact.matcher.remaining).toBe(0);
  // One step fewer: the second node does not fit, so only the first node keeps its mark.
  const short = run(entries, both(), total - 1);
  expect(short.marks).toEqual([["0", "hub"]]);
  expect(short.matcher.remaining).toBe(0);
  // Exactly the first node's steps: the second node gets nothing.
  const onlyFirst = run(entries, both(), first.steps);
  expect(onlyFirst.marks).toEqual([["0", "hub"]]);
  expect(onlyFirst.matcher.remaining).toBe(0);
  // A matcher with no steps left marks nothing.
  expect(run(entries, both(), 0).marks).toEqual([]);
});

test("budget accounting: a budget that is spent stays spent for the next doc node and never goes negative", () => {
  const entries = [{ term: "hub" }];
  const { matcher, marks } = run(entries, paragraphs("x".repeat(100), "hub"), 50);
  expect(marks).toEqual([]);
  expect(matcher.remaining).toBe(0);
});
