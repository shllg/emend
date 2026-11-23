import { expect, test } from "vitest";
import type { HtmlElement, HtmlRoot } from "./blocks.ts";
import { generator } from "./doc-terms.cases.ts";
import {
  certainBoundary,
  DOC_TERM_LOOKUP_STEPS,
  DOC_TERM_SEGMENT_STEPS,
  docTermMatcher,
  foldCodePoint,
  isSpaceUnit,
} from "./doc-terms.ts";
import { DOC_TERM_MATCH_STEP_BUDGET, markTerms } from "./terms.ts";

type Entry = { term: string; aliases?: string[] };
const escapePattern = (text: string) => text.replace(/[\^$\\.*+?()[\]{}|/]/g, "\\$&");
const single = (text: string) => ((text.codePointAt(0) ?? 0) > 0xffff ? text.length === 2 : text.length === 1);

test("the fold equals /x/iu on every BMP code point", () => {
  const failures: string[] = [];
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
    if (around.length) {
      const own = new RegExp(`^${escapePattern(char)}$`, "iu");
      for (const other of around) {
        if (own.test(other) && foldCodePoint(other.codePointAt(0) ?? 0) !== folded)
          failures.push(`${code}: ${other.codePointAt(0)} split`);
      }
    }
  }
  expect(failures).toEqual([]);
});

test("every pair of cased BMP characters falls in one class exactly when the regex says so", () => {
  const failures: string[] = [];
  const cased: number[] = [];
  for (let code = 0; code <= 0xffff; code++) {
    if (code >= 0xd800 && code <= 0xdfff) continue;
    const char = String.fromCodePoint(code);
    if (char.toLowerCase() !== char || char.toUpperCase() !== char) cased.push(code);
  }
  const folds = cased.map((code) => foldCodePoint(code));
  // One string of every cased character; each pattern is one literal code point and each member of the
  // string is one code point, so a global scan finds exactly the members the pattern matches as a whole.
  const all = String.fromCodePoint(...cased);
  for (const [index, code] of cased.entries()) {
    const found = Array.from(all.matchAll(new RegExp(escapePattern(String.fromCodePoint(code)), "giu")), (match) =>
      match[0].codePointAt(0),
    );
    const expected = cased.filter((_, other) => folds[other] === folds[index]);
    if (found.length !== expected.length || found.some((value, at) => value !== expected[at]))
      failures.push(`${code}: regex ${found.join(",")} fold ${expected.join(",")}`);
  }
  expect(cased.length).toBeGreaterThan(2000);
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
  // The second node reads characters the first one already looked up, so the total is its own measurement.
  const total = run(entries, both()).steps;
  expect(total).toBeLessThan(first.steps + second.steps);
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

const chars = (...codes: number[]) => String.fromCodePoint(...codes);

test("certainBoundary holds only where a grapheme boundary really is", () => {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const parts = [
    "a",
    "Z",
    "7",
    " ",
    "\t",
    "\r",
    "\n",
    "\r\n",
    ".",
    chars(0x65, 0x301),
    chars(0x301),
    chars(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467),
    chars(0x1f44d, 0x1f3fd),
    chars(0x1f1e9, 0x1f1ea),
    chars(0x1f1eb),
    chars(0x1f1f7, 0x1f1fa, 0x1f1fa),
    chars(0x1100, 0x1161, 0x11a8),
    chars(0xd55c),
    chars(0x6f22),
    chars(0xfc),
    chars(0x200d),
    chars(0xfe0f),
    chars(0x31, 0xfe0f, 0x20e3),
    chars(0x3002),
  ];
  const failures: string[] = [];
  let certain = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const next = generator(seed);
    const view = Array.from({ length: 1 + next(30) }, () => parts[next(parts.length)]).join("");
    const boundaries = new Set<number>([view.length]);
    for (const { index } of segmenter.segment(view)) boundaries.add(index);
    for (let index = 0; index <= view.length; index++)
      if (certainBoundary(view, index)) {
        certain++;
        if (!boundaries.has(index)) failures.push(`seed ${seed} index ${index}`);
      }
  }
  expect(failures).toEqual([]);
  // The fast path is real, not vacuous.
  expect(certain).toBeGreaterThan(1000);
  expect(certainBoundary("a\r\nb", 1)).toBe(true);
  expect(certainBoundary("a\r\nb", 2)).toBe(false);
  expect(certainBoundary("a\r\nb", 3)).toBe(true);
  expect(certainBoundary(`e${chars(0x301)}`, 1)).toBe(false);
  expect(certainBoundary(`${chars(0x1f600)}a`, 1)).toBe(false);
  expect(certainBoundary("", 0)).toBe(true);
});

test("certainBoundary holds at every index of plain ASCII prose, which therefore needs no segmentation", () => {
  const prose = "Plain words fill this paragraph with ordinary prose, numbers like 42 and (punctuation)! ".repeat(20);
  for (let index = 0; index <= prose.length; index++) if (!certainBoundary(prose, index)) throw new Error(`${index}`);
  expect(prose.length).toBeGreaterThan(1000);
});

// Charges, one at a time. Each test spends the budget on one charge alone: the budget is what the doc costs
// without that charge, by a hand count, so removing the charge from the matcher makes the doc fit and the
// test fails. L is DOC_TERM_LOOKUP_STEPS and S is DOC_TERM_SEGMENT_STEPS.
const L = DOC_TERM_LOOKUP_STEPS;
const S = DOC_TERM_SEGMENT_STEPS;
const HUGE = Number.MAX_SAFE_INTEGER;

test("the charge for each form that ends on the way: 450 forms on one tree node", () => {
  // 9-letter forms of s and long s: all fold to the same node, and the glossary's dedupe keeps all 450.
  const forms = Array.from({ length: 450 }, (_, index) =>
    Array.from({ length: 9 }, (_, bit) => ((index >> bit) & 1 ? chars(0x17f) : "s")).join(""),
  );
  const entries: Entry[] = Array.from({ length: 50 }, (_, entry) => ({
    term: forms[entry * 9] as string,
    aliases: forms.slice(entry * 9 + 1, entry * 9 + 9),
  }));
  entries.push({ term: "zebra" });
  const probe = docTermMatcher(entries, 1);
  expect(probe.forms).toHaveLength(450 + 1);
  let node = probe.root;
  for (let depth = 0; depth < 9; depth++) node = node.next.get(probe.fold(115)) ?? node;
  expect(node.forms).toHaveLength(450);
  // One filler unit: 9 s then x. At its first position the walk takes 9 lookups and a failing one, the 450
  // forms that end there cost 450, and each fails the suffix check for 1 step; 11 positions are tried.
  const unit = 11 + 10 + 450 + 450;
  const filler = (units: number) => paragraphs("sssssssssx ".repeat(units), "zebra");
  // First-seen lookups: word(s), word(x), fold(x), word(space), then word(a) at the end of zebra.
  const fixed = 5 * L + 7;
  expect(run(entries, filler(100), HUGE).steps).toBe(unit * 100 + fixed);
  // Without the form-end charge the doc costs 450 steps fewer per unit, and fits.
  const budget = (unit - 450) * 100 + fixed;
  const spent = run(entries, filler(100), budget);
  expect(spent.matcher.remaining).toBe(0);
  expect(spent.marks).toEqual([]);
  // The same budget with half the filler is enough, and the real term after it is marked.
  const half = run(entries, filler(50), budget);
  expect(half.matcher.remaining).toBeGreaterThan(0);
  expect(half.marks).toEqual([["50", "zebra"]]);
});

test("the charge for a first-seen character: 2,000 distinct CJK characters", () => {
  const entries = [{ term: "zebra" }];
  const count = 2000;
  const cjk = Array.from({ length: count }, (_, index) => chars(0x4e00 + index)).join(" ");
  const doc = () => paragraphs(cjk, "zebra");
  // Per character: its position, its failing tree lookup, a fold and a word lookup; per space: its position.
  // word(space) is looked up once, and zebra costs 1 + 5 + 1 steps and one word lookup (a).
  expect(run(entries, doc(), HUGE).steps).toBe(count * (2 + 2 * L) + (count - 1) + L + 7 + L);
  // Without lookups the doc costs the positions and tree lookups only, and fits.
  const budget = count * 2 + (count - 1) + 7;
  const spent = run(entries, doc(), budget);
  expect(spent.matcher.remaining).toBe(0);
  expect(spent.marks).toEqual([]);
  // A doc of one repeated character looks it up once, and fits the same budget.
  const same = run(entries, paragraphs(chars(0x4e00).repeat(count), "zebra"), budget);
  expect(same.marks).toEqual([["0", "zebra"]]);
});

test("the charge for segmenting a text node: non-ASCII candidates in 1,000-character paragraphs", () => {
  const entries = [{ term: "abc" }, { term: "zebra" }];
  const paragraphCount = 50;
  const cjk = `abc${chars(0x3002)}${chars(0x6f22).repeat(996)}`;
  const ascii = `abc ${"x".repeat(996)}`;
  const doc = (paragraph: string) => paragraphs(...Array(paragraphCount).fill(paragraph), "zebra");
  // Per paragraph: 998 positions, 5 tree lookups, 1 form end and 1 suffix step. The first one looks up
  // 5 characters, and zebra costs 7 steps and one lookup (a). The CJK paragraphs also pay S per unit, each.
  const base = paragraphCount * 1005 + 6 * L + 7;
  expect(run(entries, doc(cjk), HUGE).steps).toBe(base + paragraphCount * S * 1000);
  // The budget of the same doc without segmentation, plus a little, is spent by the segmentation alone.
  const budget = base + 100;
  const spent = run(entries, doc(cjk), budget);
  expect(spent.matcher.remaining).toBe(0);
  expect(spent.marks).toEqual([["0", "abc"]]);
  // The same doc in ASCII has certain edges and needs no segmentation: the real term is marked.
  const fast = run(entries, doc(ascii), budget);
  expect(fast.marks).toEqual([
    ["0", "abc"],
    ["1", "zebra"],
  ]);
  expect(fast.matcher.remaining).toBeGreaterThan(0);
});

test("a text node that is not NFC was split into graphemes up front, so the scan charges it first", () => {
  const view = `cafe${chars(0x301)}${" x".repeat(50)}`.normalize("NFC");
  const entries = [{ term: "zebra" }];
  const text = () => paragraphs(`cafe${chars(0x301)}${" x".repeat(50)}`);
  const spent = run(entries, text(), S * view.length - 1);
  expect(spent.matcher.remaining).toBe(0);
  expect(run(entries, text(), HUGE).steps).toBeGreaterThanOrEqual(S * view.length);
  // The same text already in NFC pays nothing for it.
  expect(run(entries, paragraphs(view), HUGE).steps).toBeLessThan(S * view.length);
});

test("coverage with non-ASCII prose: 50 terms with 3 aliases each, paragraphs of about 1,000 characters", () => {
  const letters = "bcdfghjklmnpqrstvwxz";
  const lead = [chars(0xdc), chars(0xd6), chars(0xc4), chars(0xdf)];
  const name = (index: number, variant: number) =>
    `${lead[variant]}${index}${Array.from({ length: 9 }, (_, at) => letters[(index + at * 3 + variant) % letters.length]).join("")}`;
  const entries: Entry[] = Array.from({ length: 50 }, (_, index) => ({
    term: name(index, 0),
    aliases: [name(index, 1), name(index, 2), name(index, 3)],
  }));
  const words =
    `Die Gr${chars(0xf6, 0xdf)}e der ${chars(0xc4)}nderungen ${chars(0xe4)}ndert sich f${chars(0xfc)}r gr${chars(0xf6, 0xdf)}ere ${chars(0xdc)}bungen w${chars(0xe4)}hrend wir sprechen`.split(
      " ",
    );
  const next = generator(5);
  const prose = (length: number) => {
    let text = "";
    while (text.length < length) text += `${words[next(words.length)]}${next(10) === 0 ? ". " : " "}`;
    return text.slice(0, length);
  };
  // Each paragraph holds the first use of one entry, a candidate with a non-ASCII edge.
  const used: string[] = [];
  const values = Array.from({ length: 50 }, (_, paragraph) => {
    const entry = entries[paragraph] as Required<Entry>;
    const form = [entry.term, ...entry.aliases][paragraph % 4] as string;
    used.push(form);
    return `${prose(980)} ${form} ${prose(5)}`;
  });
  const { marks, steps } = run(entries, paragraphs(...values));
  expect(marks.map(([entry]) => Number(entry))).toEqual(Array.from({ length: 50 }, (_, index) => index));
  expect(marks.map(([, text]) => text)).toEqual(used);
  // The segmentation path ran: each paragraph was split into graphemes and charged for it, and all fit.
  expect(steps).toBeGreaterThan(50 * S * 900);
  expect(steps).toBeLessThan(DOC_TERM_MATCH_STEP_BUDGET);
});
