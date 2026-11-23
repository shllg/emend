// @vitest-environment node
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { LIMITS, normalizeGlossaryForm } from "@emend/contract";
import { type Element, type Node, type ShadowRoot, Window } from "happy-dom";
import { afterEach, expect, test, vi } from "vitest";
import type { HtmlRoot } from "../../../packages/core/src/render/blocks.ts";
import { generator, randomTermCase } from "../../../packages/core/src/render/doc-terms.cases.ts";
import {
  certainBoundary,
  DOC_TERM_LOOKUP_STEPS,
  DOC_TERM_SEGMENT_STEPS,
  docTermMatcher,
  foldCodePoint,
  scanDocTerms,
} from "../../../packages/core/src/render/doc-terms.ts";
import { DOC_TERM_MATCH_STEP_BUDGET, markTerms } from "../../../packages/core/src/render/terms.ts";

const bridgeSource = readFileSync(new URL("../../emend/src/server/content/bridge.ts", import.meta.url), "utf8");
const windows: Window[] = [];
afterEach(async () => {
  await Promise.all(windows.splice(0).map((window) => window.happyDOM.close()));
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing fixture value");
  return value;
}

function bridge(html: string, prepare?: (window: Window) => void) {
  vi.useFakeTimers();
  const window = new Window({
    url: `http://127.0.0.1:3636/content/${"k".repeat(43)}${"a".repeat(32)}/docs/seed.html`,
    settings: {
      enableJavaScriptEvaluation: false,
      disableJavaScriptFileLoading: true,
      handleDisabledFileLoadingAsSuccess: true,
    },
  });
  windows.push(window);
  Object.assign(window, { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1000 });
  window.document.write(html);
  if (!Object.getOwnPropertyDescriptor(window.Element.prototype, "assignedSlot"))
    Object.defineProperty(window.Element.prototype, "assignedSlot", { configurable: true, get: () => null });
  const baseURI = required(
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(window.Document.prototype), "baseURI")?.get,
  );
  vi.spyOn(window.Node.prototype, "baseURI", "get").mockImplementation(() => baseURI.call(window.document));
  const shadows: ShadowRoot[] = [];
  const attach = window.Element.prototype.attachShadow;
  vi.spyOn(window.Element.prototype, "attachShadow").mockImplementation(function (this: Element, options) {
    const shadow = attach.call(this, options);
    shadows.push(shadow);
    return shadow;
  });
  const scrolled: unknown[] = [];
  Object.defineProperty(window.Element.prototype, "scrollIntoView", {
    configurable: true,
    value(this: unknown) {
      scrolled.push(this);
    },
  });
  const post = vi.fn();
  const parent = { postMessage: post };
  Object.defineProperty(window, "parent", { value: parent });
  prepare?.(window);
  const script = runInNewContext(`${bridgeSource.replace("export const", "const")}; BRIDGE_SOURCE;`);
  Object.defineProperty(window, "HighlightRegistry", { value: Map });
  runInNewContext(script, {
    window,
    document: window.document,
    Node: window.Node,
    Range: window.Range,
    Intl,
    CSS: { highlights: new Map() },
    Highlight: class {},
    CSSStyleSheet: window.CSSStyleSheet,
  });
  window.document.dispatchEvent(new window.Event("DOMContentLoaded"));
  const message = (data: unknown, source: unknown = parent) =>
    window.dispatchEvent(new window.MessageEvent("message", { data, source: source as Window }));
  const marks = () => [...window.document.querySelectorAll("span[aria-haspopup]")];
  const host = () => window.document.querySelector("emend-term-card");
  const dialog = () => shadows[0]?.querySelector(".card") ?? null;
  const open = () => (host()?.getAttribute("style") ?? "").includes("display: block");
  const fire = (target: Node | Element, type: string, init: Record<string, unknown> = {}) => {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { pointerType: "mouse", relatedTarget: null, ...init });
    target.dispatchEvent(event);
    return event;
  };
  const key = (target: Node | Element, name: string) => {
    const event = new window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  };
  const click = (target: Node | Element) =>
    target.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  return { window, post, message, shadows, scrolled, marks, host, dialog, open, fire, key, click };
}

const entries = (...items: string[]) => `<h2>Glossary</h2><dl>${items.join("")}</dl>`;
const entry = (term: string, definition: string, ...aliases: string[]) =>
  `<dt>${term}</dt>${aliases.map((alias) => `<dt>${alias}</dt>`).join("")}<dd>${definition}</dd>`;
const page = (text: string, glossary: string) => `<body><main><p id="t">${text}</p>${glossary}</main></body>`;

const markTexts = (b: ReturnType<typeof bridge>) => b.marks().map((mark) => mark.textContent);

// The card, read back as text: term, definition and the control.
const cardText = (b: ReturnType<typeof bridge>) => {
  const card = required(b.dialog());
  return {
    term: card.querySelector("strong")?.textContent,
    definition: card.querySelector("p")?.textContent,
    control: card.querySelector("button")?.textContent,
  };
};

test("bridge glossary limits stay in parity with the contract", () => {
  for (const [name, value] of Object.entries({
    GLOSSARY_TERMS_MAX: LIMITS.glossaryTerms,
    GLOSSARY_ALIASES_MAX: LIMITS.glossaryAliases,
    GLOSSARY_FORM_MAX: LIMITS.glossaryTermChars,
    GLOSSARY_DEFINITION_MAX: LIMITS.glossaryDefinitionChars,
  }))
    expect(bridgeSource).toContain(`const ${name} = ${value};`);
});

test("the bridge's marking budget stays in parity with core's doc budget", () => {
  expect(bridgeSource).toContain(`const GLOSSARY_STEP_MAX = ${DOC_TERM_MATCH_STEP_BUDGET};`);
  expect(bridgeSource).toContain(`const GLOSSARY_SEGMENT_STEPS = ${DOC_TERM_SEGMENT_STEPS};`);
  expect(bridgeSource).toContain(`const GLOSSARY_LOOKUP_STEPS = ${DOC_TERM_LOOKUP_STEPS};`);
});

test("a glossary whose forms share a long prefix cannot stall the doc: ready is posted and nothing is marked", () => {
  const prefix = "a ".repeat(48).trim();
  const items = Array.from({ length: 50 }, (_, term) => {
    const form = (alias: number) => `${prefix} ${String(term * 9 + alias).padStart(3, "0")}`;
    return entry(form(0), "Defined.", ...Array.from({ length: 8 }, (_, alias) => form(alias + 1)));
  });
  const b = bridge(page("a ".repeat(4489), entries(...items)));
  expect(b.marks()).toEqual([]);
  expect(b.post.mock.calls.map(([data]) => data.type)).toContain("emend:ready");
});

// The 450-form shape: 50 entries with 9 forms, each 48 one-letter words and a 3-digit index.
const hostileItems = (word: string) =>
  Array.from({ length: 50 }, (_, term) => {
    const form = (alias: number) => `${Array(48).fill(word).join(" ")} ${String(term * 9 + alias).padStart(3, "0")}`;
    return entry(form(0), "Defined.", ...Array.from({ length: 8 }, (_, alias) => form(alias + 1)));
  });
const manyParagraphs = (text: string, count: number, glossary: string) =>
  `<body><main>${`<p>${text}</p>`.repeat(count)}${glossary}</main></body>`;

test("hostile: 200 paragraphs of 440 characters, also with U+3000 between the words, mark nothing", () => {
  for (const gap of [" ", "　"]) {
    const b = bridge(manyParagraphs(`a${gap}`.repeat(220), 200, entries(...hostileItems("a"))));
    expect(b.marks()).toEqual([]);
    expect(b.post.mock.calls.map(([data]) => data.type)).toContain("emend:ready");
  }
});

test("hostile: acronym forms against lowercase text refuse every position, and plain forms still mark", () => {
  const text = `${"a ".repeat(48)}000 `.repeat(10);
  const refused = bridge(manyParagraphs(text, 200, entries(...hostileItems("A"))));
  expect(refused.marks()).toEqual([]);
  const exact = bridge(manyParagraphs(text, 1, entries(...hostileItems("a"))));
  expect(markTexts(exact)).toEqual([`${"a ".repeat(48)}000`]);
});

test("a doc far beyond the step budget stops marking and still posts ready", () => {
  const b = bridge(manyParagraphs("a ".repeat(2500), 400, entries(...hostileItems("a"))));
  expect(b.marks()).toEqual([]);
  expect(b.post.mock.calls.map(([data]) => data.type)).toContain("emend:ready");
});

test("coverage: 50 terms with 3 aliases each are all marked in a 60,000-character doc", () => {
  const letters = "bcdfghjklmnpqrstvwxz";
  const name = (index: number, prefix: string, length: number) =>
    `${prefix}${index}${Array.from({ length }, (_, at) => letters[(index + at * 3) % letters.length]).join("")}`.slice(
      0,
      length,
    );
  const items = Array.from({ length: 50 }, (_, index) => {
    const forms = [
      name(index, "term", 10 + (index % 11)),
      name(index, "alias", 10),
      name(index, "other", 15),
      name(index, "third", 20),
    ];
    return { forms, item: entry(forms[0] as string, "Defined.", ...forms.slice(1)) };
  });
  const filler = "Plain words fill this paragraph with ordinary prose. ";
  let prose = "";
  const used: string[] = [];
  for (const [index, { forms }] of items.entries()) {
    while (prose.length < index * 1200) prose += filler;
    const use = forms[index % 4] as string;
    used.push(use);
    prose += `Here ${use} appears. `;
  }
  while (prose.length < 60_000) prose += filler;
  const b = bridge(page(prose, entries(...items.map(({ item }) => item))));
  expect(prose.length).toBeGreaterThanOrEqual(60_000);
  expect(markTexts(b)).toEqual(used);
});

test("a doc whose filler spends the whole step budget leaves a later real term unmarked and still posts ready", () => {
  // 49 hostile entries (441 forms) and a real one. Each filler paragraph costs about 29,000 steps.
  const items = [...hostileItems("a").slice(0, 49), entry("Zebra", "Defined.")];
  const doc = (filler: number) =>
    `<body><main>${`<p>${"a ".repeat(220)}</p>`.repeat(filler)}<p>A zebra here.</p>${entries(...items)}</main></body>`;
  const spent = bridge(doc(400));
  expect(spent.marks()).toEqual([]);
  expect(spent.post.mock.calls.map(([data]) => data.type)).toContain("emend:ready");
  // With less filler the same real term is marked.
  const less = bridge(doc(100));
  expect(markTexts(less)).toEqual(["zebra"]);
  expect(less.post.mock.calls.map(([data]) => data.type)).toContain("emend:ready");
});

// The bridge's matcher, taken from BRIDGE_SOURCE between its two marker comments and run beside core's, so
// that every charge is compared: the same marks, the same return value and the same steps left.
type Mark = [entry: number, start: number, finish: number];
type Scan = { marks: Mark[]; done: boolean; remaining: number; segments: number };
type ScanEntry = { term: string; aliases: string[] };
const bridgeTerms = (
  runInNewContext(
    `(glossaryForm, GLOSSARY_STEP_MAX, GLOSSARY_SEGMENT_STEPS, GLOSSARY_LOOKUP_STEPS) => {\n${bridgeSource.slice(
      bridgeSource.indexOf("// term matcher: start"),
      bridgeSource.indexOf("// term matcher: end"),
    )}\nreturn { termMatcher, scanTerms, certainBoundary };\n}`,
  ) as (...args: unknown[]) => {
    termMatcher: (entries: ScanEntry[]) => { remaining: number };
    scanTerms: (
      matcher: { remaining: number },
      value: string,
      accept: (start: number, length: number) => boolean,
      seen: Set<number>,
      mark: (entry: number, start: number, length: number) => boolean,
      segment: () => void,
    ) => boolean;
    certainBoundary: (value: string, index: number) => boolean;
  }
)(normalizeGlossaryForm, DOC_TERM_MATCH_STEP_BUDGET, DOC_TERM_SEGMENT_STEPS, DOC_TERM_LOOKUP_STEPS);

type Refuse = (start: number, length: number) => boolean;
function scanInCore(entries: ScanEntry[], view: string, budget: number, refuse: Refuse, seenAtStart: number[]): Scan {
  const matcher = docTermMatcher(entries, budget);
  const seen = new Set(seenAtStart);
  const marks: Mark[] = [];
  let segments = 0;
  const done = scanDocTerms(
    matcher,
    view,
    (start, length) => (refuse(start, length) ? undefined : { start, finish: start + length }),
    seen,
    (entry, { start, finish }) => {
      marks.push([entry, start, finish]);
      seen.add(entry);
      return seen.size === entries.length;
    },
    () => {
      segments++;
    },
    false,
  );
  return { marks, done, remaining: matcher.remaining, segments };
}
function scanInBridge(entries: ScanEntry[], view: string, budget: number, refuse: Refuse, seenAtStart: number[]): Scan {
  const matcher = bridgeTerms.termMatcher(entries);
  matcher.remaining = budget;
  const seen = new Set(seenAtStart);
  const marks: Mark[] = [];
  let segments = 0;
  const done = bridgeTerms.scanTerms(
    matcher,
    view,
    (start, length) => !refuse(start, length),
    seen,
    (entry, start, length) => {
      marks.push([entry, start, start + length]);
      seen.add(entry);
      return seen.size === entries.length;
    },
    () => {
      segments++;
    },
  );
  return { marks, done, remaining: matcher.remaining, segments };
}
const refuseSome: Refuse = (start, length) => (start * 7 + length * 3) % 5 === 0;
const refuseNone: Refuse = () => false;
function sameScan(entries: ScanEntry[], view: string, budget: number, refuse: Refuse, seenAtStart: number[] = []) {
  const core = scanInCore(entries, view, budget, refuse, seenAtStart);
  expect(scanInBridge(entries, view, budget, refuse, seenAtStart)).toEqual(core);
  return core;
}

test("the bridge's step accounting equals core's on the seeded random cases, with small budgets", () => {
  let spent = 0;
  let marked = 0;
  let segmented = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const { entries, values } = randomTermCase(seed);
    const next = generator(seed + 1000);
    for (const view of values) {
      for (const budget of [Number.MAX_SAFE_INTEGER, next(3000), next(9000), next(30000)]) {
        const seenAtStart = entries.flatMap((_, index) => (next(4) === 0 ? [index] : []));
        const result = sameScan(entries, view, budget, next(2) === 0 ? refuseSome : refuseNone, seenAtStart);
        if (!result.done) spent++;
        if (result.marks.length) marked++;
        if (result.segments) segmented++;
      }
    }
  }
  // The comparison is only worth something when the cases cover the budget running out, marks and segmentation.
  expect(spent).toBeGreaterThan(30);
  expect(marked).toBeGreaterThan(100);
  expect(segmented).toBeGreaterThan(30);
});

test("the bridge's grapheme fast path equals core's on the seeded random texts", () => {
  for (let seed = 1; seed <= 60; seed++)
    for (const view of randomTermCase(seed).values)
      for (let index = 0; index <= view.length; index++)
        expect(bridgeTerms.certainBoundary(view, index)).toBe(certainBoundary(view, index));
});

test("the bridge's step accounting equals core's on the hostile shapes, with budgets that run out on each charge", () => {
  const hostile = (word: string): ScanEntry[] =>
    Array.from({ length: 50 }, (_, term) => {
      const form = (alias: number) => `${Array(48).fill(word).join(" ")} ${String(term * 9 + alias).padStart(3, "0")}`;
      return { term: form(0), aliases: Array.from({ length: 8 }, (_, alias) => form(alias + 1)) };
    });
  const longS = String.fromCodePoint(0x17f);
  const sForms = Array.from({ length: 450 }, (_, index) =>
    Array.from({ length: 9 }, (_, bit) => ((index >> bit) & 1 ? longS : "s")).join(""),
  );
  const onNode: ScanEntry[] = Array.from({ length: 50 }, (_, entry) => ({
    term: sForms[entry * 9] as string,
    aliases: sForms.slice(entry * 9 + 1, entry * 9 + 9),
  }));
  const zebra: ScanEntry = { term: "zebra", aliases: [] };
  const candidate = `abc${String.fromCodePoint(0x3002)}${String.fromCodePoint(0x6f22).repeat(996)}`;
  const shapes: [string, ScanEntry[], string][] = [
    ["one-byte words", hostile("a"), "a ".repeat(500)],
    ["U+3000 words", hostile("a"), `a${String.fromCodePoint(0x3000)}`.repeat(500)],
    ["refused acronyms", hostile("A"), `${"a ".repeat(48)}000 `.repeat(8)],
    ["450 forms on one node", [...onNode, zebra], `${"sssssssssx ".repeat(40)}zebra`],
    [
      "distinct characters",
      [zebra],
      `${Array.from({ length: 600 }, (_, index) => String.fromCodePoint(0x4e00 + index)).join(" ")} zebra`,
    ],
    ["segmentation", [{ term: "abc", aliases: [] }, zebra], `${candidate}${candidate}${candidate} zebra`],
  ];
  const results = new Set<string>();
  for (const [name, entries, view] of shapes) {
    for (const budget of [Number.MAX_SAFE_INTEGER, 200_000, 50_000, 20_000, 5000, 1000, 100, 0]) {
      const result = sameScan(entries, view, budget, budget % 2 === 0 ? refuseNone : refuseSome);
      results.add(`${name} ${result.done}`);
    }
  }
  // Every shape both finishes and runs out of budget somewhere in the list.
  for (const [name] of shapes) expect(results.has(`${name} true`) && results.has(`${name} false`)).toBe(true);
});

test("a doc without a glossary does not change at all", () => {
  const html = "<body><p>Budget and hub in text.</p><h2>Notes</h2><dl><dt>Budget</dt><dd>Money.</dd></dl></body>";
  const plain = new Window({ settings: { enableJavaScriptEvaluation: false } });
  windows.push(plain);
  plain.document.write(html);
  const b = bridge(html);
  expect(b.window.document.body.querySelectorAll("*")).toHaveLength(plain.document.body.querySelectorAll("*").length);
  expect(b.window.document.body.textContent).toBe(plain.document.body.textContent);
  expect(b.marks()).toEqual([]);
  expect(b.host()).toBeNull();
});

test("more than 1,024 headings before the Glossary heading leave the doc without a glossary", () => {
  const headings = "<h3>Section</h3>".repeat(1030);
  const b = bridge(`<body><p id="t">A budget.</p>${headings}${entries(entry("Budget", "Money."))}</body>`);
  expect(b.marks()).toEqual([]);
  expect(b.host()).toBeNull();
  expect(b.post.mock.calls.map(([data]) => data.type)).toContain("emend:ready");
});

test("a pretty-printed Glossary heading with an indented svg icon and much whitespace still counts", () => {
  const space = " ".repeat(120);
  const heading = `<h2>\n${space}<svg width="1" height="1">\n${space}<path d="M0 0"/>\n${space}</svg>\n${space}Glossary\n${space}</h2>`;
  const b = bridge(
    `<body><main><p id="t">A budget.</p>${heading}<dl><dt>Budget</dt><dd>Money.</dd></dl></main></body>`,
  );
  expect(markTexts(b)).toEqual(["budget"]);
});

test("a div-grouped list is cut at 10,000 items", () => {
  const group = (count: number) =>
    `<h2>Glossary</h2><dl><div>${"<dd>x</dd>".repeat(count)}<dt>Late</dt><dd>Defined.</dd></div></dl>`;
  const within = bridge(page("A late word.", group(9990)));
  expect(markTexts(within)).toEqual(["late"]);
  const beyond = bridge(page("A late word.", group(10010)));
  expect(beyond.marks()).toEqual([]);
  expect(beyond.post.mock.calls.map(([data]) => data.type)).toContain("emend:ready");
});

test("a line break inside a term reads as one space, as in core", () => {
  const b = bridge(page("A hub node.", entries(entry("Hub\nnode", "Machine.", "edge\nbox"))));
  expect(markTexts(b)).toEqual(["hub node"]);
  b.click(required(b.marks()[0]));
  expect(cardText(b).term).toBe("Hub node");
});

test("a Glossary heading without a dl marks nothing", () => {
  const b = bridge("<body><p>Budget here.</p><h2>Glossary</h2><p>Budget: money.</p><ul><li>Budget</li></ul></body>");
  expect(b.marks()).toEqual([]);
});

test("the first dl after the heading counts, heading levels and case do not matter", () => {
  const b = bridge(
    `<body><p id="t">A budget and a hub.</p><H3> glossary </H3><p>Intro.</p>${"<dl><dt>Budget</dt><dd>Money.</dd></dl>"}
    <dl><dt>Hub</dt><dd>The machine.</dd></dl></body>`,
  );
  expect(markTexts(b)).toEqual(["budget"]);
});

test("dt runs, aliases, several dd and div groups form entries", () => {
  const b = bridge(
    page(
      "The allowance, the Hub, the quota and a worker.",
      `<h2>Glossary</h2><dl>
        <dt>Budget</dt><dt>allowance</dt><dt>quota</dt><dd>Attempts a worker</dd><dd>may <em>spend</em>.</dd>
        <div><dt>Hub</dt><dd><p>The machine.</p><p>The phone reaches it.</p></dd></div>
        <dt>Orphan</dt>
        <dd>Belongs to Orphan.</dd>
        <dd>Orphan too.</dd>
      </dl>`,
    ),
  );
  // Budget, allowance and quota are one entry: only its first use is marked.
  expect(markTexts(b)).toEqual(["allowance", "Hub"]);
  const [allowance, hub] = b.marks();
  b.click(required(allowance));
  expect(cardText(b)).toEqual({
    term: "Budget",
    definition: "Attempts a worker may spend.",
    control: "Glossary",
  });
  b.click(required(hub));
  expect(cardText(b).term).toBe("Hub");
  expect(cardText(b).definition).toBe("The machine. The phone reaches it.");
});

test("the last alias of a run is marked, the ninth alias is not", () => {
  const aliases = Array.from({ length: LIMITS.glossaryAliases + 1 }, (_, index) => `alias${index}x`);
  const last = bridge(page(`${aliases[LIMITS.glossaryAliases - 1]}`, entries(entry("main", "Defined.", ...aliases))));
  expect(markTexts(last)).toEqual([aliases[LIMITS.glossaryAliases - 1]]);
  const over = bridge(page(`${aliases[LIMITS.glossaryAliases]}`, entries(entry("main", "Defined.", ...aliases))));
  expect(markTexts(over)).toEqual([]);
});

test("a dd before any dt, a dt without dd and an invalid or repeated entry are skipped", () => {
  const long = "x".repeat(LIMITS.glossaryTermChars + 1);
  const b = bridge(
    page(
      `Orphan alpha beta delta gamma ${long} Control${String.fromCharCode(1)}x`,
      `<h2>Glossary</h2><dl>
        <dd>Stray definition.</dd>
        <dt>Orphan</dt>
        <dt>Alpha</dt><dd>   </dd>
        <dt>Beta</dt><dd>One.</dd>
        <dt>beta</dt><dd>Repeated.</dd>
        <dt>Gamma</dt><dt>BETA</dt><dt>   </dt><dt>delta</dt><dd>Two.</dd>
        <dt>${long}</dt><dd>Too long.</dd>
        <dt>Control${String.fromCharCode(1)}x</dt><dd>Control.</dd>
      </dl>`,
    ),
  );
  // Orphan has no dd, Alpha a blank one; Gamma and its alias delta are one entry, marked at the first use.
  expect(markTexts(b)).toEqual(["beta", "delta"]);
  b.click(required(b.marks()[1]));
  expect(cardText(b).term).toBe("Gamma");
  expect(cardText(b).definition).toBe("Two.");
});

test("entries stop at the limit", () => {
  const many = Array.from({ length: LIMITS.glossaryTerms + 1 }, (_, index) => `term${index}x`);
  const b = bridge(page(many.join(" "), entries(...many.map((term) => entry(term, "Defined.")))));
  expect(markTexts(b)).toEqual(many.slice(0, LIMITS.glossaryTerms));
});

const longDefinitions = [
  { name: "plain text", text: "y".repeat(LIMITS.glossaryDefinitionChars + 500) },
  { name: "a surrogate pair at the cut", text: `${"y".repeat(LIMITS.glossaryDefinitionChars - 2)}\u{1F600}tail` },
];

test.each(longDefinitions)("a long definition is cut with an ellipsis and never splits a pair: $name", ({ text }) => {
  const b = bridge(page("Term", entries(entry("Term", text))));
  b.click(required(b.marks()[0]));
  const cut = required(cardText(b).definition);
  expect(cut.isWellFormed()).toBe(true);
  expect(cut.endsWith("\u2026")).toBe(true);
  expect(cut.length).toBeLessThanOrEqual(LIMITS.glossaryDefinitionChars);
  expect(cut.length).toBeGreaterThanOrEqual(LIMITS.glossaryDefinitionChars - 1);
});

test("only the first use of each entry is marked, and never inside the skipped elements or the glossary", () => {
  const skipped = [
    "a",
    "code",
    "pre",
    "kbd",
    "samp",
    "textarea",
    "title",
    "button",
    "select",
    "option",
    "h1",
    "h2",
    "h3",
  ];
  const html = `<body><p>Budget first. Budget again. Hubs and the hub.</p>
    ${skipped.map((tag) => `<${tag}>Budget Hub</${tag}>`).join("")}
    <script>Budget</script><style>Budget</style><template>Budget</template><noscript>Budget</noscript>
    <h2>Glossary</h2><dl><dt>Budget</dt><dd>Budget is money.</dd><dt>Hub</dt><dd>A hub.</dd></dl>
    <p>Budget last.</p></body>`;
  const b = bridge(html);
  expect(markTexts(b)).toEqual(["Budget", "Hubs"]);
  const dl = required(b.window.document.querySelector("dl"));
  expect(dl.querySelector("span")).toBeNull();
  for (const tag of skipped) expect(b.window.document.querySelector(tag)?.querySelector("span")).toBeNull();
});

test("a term is not marked inside SVG, other non-HTML elements or the glossary term itself", () => {
  const b = bridge(
    `<body><svg><text>Budget</text></svg><p>Plain budget.</p>${entries(entry("Budget", "Money."))}</body>`,
  );
  expect(markTexts(b)).toEqual(["budget"]);
  expect(required(b.window.document.querySelector("svg")).querySelector("span")).toBeNull();
});

test("marks carry button semantics, and the text of the doc is unchanged", () => {
  const html = page("A budget, not the other.", entries(entry("Budget", "Money.")));
  const reference = bridge(html).window.document.body.textContent;
  const b = bridge(html);
  const mark = required(b.marks()[0]);
  expect(mark.getAttribute("tabindex")).toBe("0");
  expect(mark.getAttribute("role")).toBe("button");
  expect(mark.getAttribute("aria-haspopup")).toBe("dialog");
  expect(mark.getAttribute("aria-expanded")).toBe("false");
  expect(mark.getAttribute("style")).toContain("cursor: help");
  expect(mark.getAttribute("style")).toContain("dotted");
  expect(b.window.document.body.textContent).toBe(reference);
  expect(b.post.mock.calls.map(([data]) => data.type)).toContain("emend:ready");
});

test("a doc's own attributes never pick a term index", () => {
  const b = bridge(
    page(
      `<span role="button" aria-haspopup="dialog" data-emend-term="0" class="emend-term" tabindex="0">Fake</span> budget`,
      entries(entry("Budget", "Money.")),
    ),
  );
  const fake = required(b.window.document.querySelector("span.emend-term"));
  b.click(fake);
  expect(b.open()).toBe(false);
  b.click(required(b.marks().find((mark) => mark !== fake)));
  expect(b.open()).toBe(true);
});

test("hover opens after 500 ms and leaving closes after 300 ms unless the pointer returns", () => {
  const b = bridge(page("A budget.", entries(entry("Budget", "Money."))));
  const mark = required(b.marks()[0]);
  b.fire(mark, "pointerover");
  vi.advanceTimersByTime(499);
  expect(b.open()).toBe(false);
  vi.advanceTimersByTime(1);
  expect(b.open()).toBe(true);
  expect(mark.getAttribute("aria-expanded")).toBe("true");
  expect(cardText(b)).toEqual({ term: "Budget", definition: "Money.", control: "Glossary" });
  b.fire(mark, "pointerout", { relatedTarget: b.window.document.body });
  b.fire(b.window.document.body, "pointerover");
  vi.advanceTimersByTime(300);
  expect(b.open()).toBe(false);
  expect(mark.getAttribute("aria-expanded")).toBe("false");
  // The pointer moves onto the card in time: the card stays.
  b.fire(mark, "pointerover");
  vi.advanceTimersByTime(500);
  expect(b.open()).toBe(true);
  b.fire(mark, "pointerout", { relatedTarget: b.window.document.body });
  vi.advanceTimersByTime(200);
  b.fire(required(b.host()), "pointerover");
  vi.advanceTimersByTime(1000);
  expect(b.open()).toBe(true);
  b.fire(required(b.host()), "pointerout", { relatedTarget: b.window.document.body });
  b.fire(b.window.document.body, "pointerover");
  vi.advanceTimersByTime(300);
  expect(b.open()).toBe(false);
});

test("touch pointers do not hover-open, and a hover that ends before 500 ms opens nothing", () => {
  const b = bridge(page("A budget.", entries(entry("Budget", "Money."))));
  const mark = required(b.marks()[0]);
  b.fire(mark, "pointerover", { pointerType: "touch" });
  vi.advanceTimersByTime(1000);
  expect(b.open()).toBe(false);
  b.fire(mark, "pointerover");
  vi.advanceTimersByTime(300);
  b.fire(mark, "pointerout", { relatedTarget: b.window.document.body });
  vi.advanceTimersByTime(1000);
  expect(b.open()).toBe(false);
});

test("a click or tap opens now, a click over a selection does not", () => {
  const b = bridge(page("A budget and some more text.", entries(entry("Budget", "Money."))));
  const mark = required(b.marks()[0]);
  const selection = required(b.window.getSelection());
  const range = b.window.document.createRange();
  range.selectNodeContents(required(b.window.document.querySelector("#t")));
  selection.removeAllRanges();
  selection.addRange(range);
  b.click(mark);
  expect(b.open()).toBe(false);
  selection.removeAllRanges();
  b.click(mark);
  expect(b.open()).toBe(true);
});

test("focus opens after 500 ms, Enter and Space open now and focus the Glossary control", () => {
  const b = bridge(page("A budget.", entries(entry("Budget", "Money."))));
  const mark = required(b.marks()[0]);
  b.fire(mark, "focusin");
  vi.advanceTimersByTime(500);
  expect(b.open()).toBe(true);
  b.fire(mark, "focusout", { relatedTarget: null });
  expect(b.open()).toBe(false);
  const enter = b.key(mark, "Enter");
  expect(enter.defaultPrevented).toBe(true);
  expect(b.open()).toBe(true);
  b.key(mark, "Escape");
  expect(b.open()).toBe(false);
  b.key(mark, " ");
  expect(b.open()).toBe(true);
  b.key(mark, "x");
});

test("Escape closes and gives focus back to the mark when focus was in the card", () => {
  const b = bridge(page("A budget.", entries(entry("Budget", "Money."))));
  const mark = required(b.marks()[0]);
  const focus = vi.spyOn(b.window.HTMLElement.prototype, "focus");
  b.key(mark, "Enter");
  expect(b.open()).toBe(true);
  // Focus sits on the card's control; the document sees the host as the active element.
  Object.defineProperty(b.window.document, "activeElement", { configurable: true, get: () => b.host() });
  const pressed = b.key(b.window.document.body, "Escape");
  expect(pressed.defaultPrevented).toBe(true);
  expect(b.open()).toBe(false);
  expect(focus.mock.contexts.at(-1)).toBe(mark);
});

test("Escape from elsewhere closes without moving focus", () => {
  const b = bridge(page("A budget.", entries(entry("Budget", "Money."))));
  const mark = required(b.marks()[0]);
  b.click(mark);
  const focus = vi.spyOn(b.window.HTMLElement.prototype, "focus");
  const pressed = b.key(b.window.document.body, "Escape");
  expect(pressed.defaultPrevented).toBe(false);
  expect(b.open()).toBe(false);
  expect(focus).not.toHaveBeenCalled();
});

test("a pointerdown outside closes the card, inside the card or on the mark does not", () => {
  const b = bridge(page("A budget and a hub.", entries(entry("Budget", "Money."), entry("Hub", "Machine."))));
  const [budget] = b.marks();
  b.click(required(budget));
  b.fire(required(budget), "pointerdown");
  b.fire(required(b.host()), "pointerdown");
  expect(b.open()).toBe(true);
  b.fire(required(b.window.document.querySelector("#t")), "pointerdown");
  expect(b.open()).toBe(false);
});

test("opening another term swaps the card and its aria-expanded state", () => {
  const b = bridge(page("A budget and a hub.", entries(entry("Budget", "Money."), entry("Hub", "Machine."))));
  const budget = required(b.marks()[0]);
  const hub = required(b.marks()[1]);
  b.click(budget);
  b.click(hub);
  expect(budget.getAttribute("aria-expanded")).toBe("false");
  expect(hub.getAttribute("aria-expanded")).toBe("true");
  expect(cardText(b).term).toBe("Hub");
  expect(b.shadows).toHaveLength(1);
});

test("the card sits below the mark with a 6 px gap, above it without room, and stays 8 px from the edges", () => {
  const b = bridge(page("A budget.", entries(entry("Budget", "Money."))));
  const mark = required(b.marks()[0]);
  let anchor = { left: 50, top: 100, bottom: 120 };
  const size = { width: 320, height: 100 };
  vi.spyOn(b.window.Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return (this === mark ? anchor : size) as unknown as ReturnType<Element["getBoundingClientRect"]>;
  });
  b.click(mark);
  const style = required(b.dialog()).getAttribute("style") ?? "";
  expect(style).toContain("left: 50px");
  expect(style).toContain("top: 126px");
  anchor = { left: 900, top: 550, bottom: 570 };
  b.window.dispatchEvent(new b.window.Event("resize"));
  const moved = required(b.dialog()).getAttribute("style") ?? "";
  expect(moved).toContain("left: 672px");
  expect(moved).toContain("top: 444px");
  anchor = { left: -30, top: -5, bottom: 5 };
  b.window.dispatchEvent(new b.window.Event("scroll"));
  const clamped = required(b.dialog()).getAttribute("style") ?? "";
  expect(clamped).toContain("left: 8px");
  expect(clamped).toContain("top: 11px");
});

test("the Glossary control scrolls to the entry's first dt and closes the card", () => {
  const b = bridge(page("A budget.", entries(entry("Budget", "Money.", "allowance"))));
  const mark = required(b.marks()[0]);
  b.click(mark);
  const control = required(required(b.dialog()).querySelector("button"));
  control.dispatchEvent(new b.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  expect(b.scrolled).toEqual([required(b.window.document.querySelector("dt"))]);
  expect(b.open()).toBe(false);
});

test("the card host is not a part tag, has no light children and sends no frame message", () => {
  const b = bridge(page("A budget.", entries(entry("Budget", "Money."))));
  const before = b.post.mock.calls.length;
  b.click(required(b.marks()[0]));
  const host = required(b.host());
  expect(host.localName).toBe("emend-term-card");
  expect(host.childNodes).toHaveLength(0);
  expect(host.shadowRoot).toBeNull();
  expect(b.shadows).toHaveLength(1);
  expect(b.post.mock.calls.slice(before).map(([data]) => data.type)).not.toContain("emend:glossary");
  expect(JSON.stringify(b.post.mock.calls)).not.toContain("Money.");
  const dialog = required(b.dialog());
  expect(dialog.getAttribute("role")).toBe("dialog");
  expect(dialog.getAttribute("aria-labelledby")).toBe(dialog.querySelector("strong")?.getAttribute("id"));
});

const hostile = [
  {
    name: "script text",
    term: "&lt;script&gt;alert(1)&lt;/script&gt;",
    definition: "&lt;script&gt;alert(2)&lt;/script&gt;",
  },
  {
    name: "img onerror markup",
    term: '<img src="x" onerror="alert(1)">Gadget',
    definition: '<img src="x" onerror="alert(2)">Does things.',
  },
  {
    name: "javascript link",
    term: '<a href="javascript:alert(1)">Gadget</a>',
    definition: 'See <a href="javascript:alert(2)">this</a> now.',
  },
  {
    name: "svg and style",
    term: "Gadget",
    definition: '<svg><a href="javascript:alert(1)"><text>x</text></a></svg><style>*{}</style><b>bold</b> text.',
  },
];

test.each(hostile)("hostile glossary text stays text in the card: $name", ({ term, definition }) => {
  const b = bridge(page("A gadget and &lt;script&gt;alert(1)&lt;/script&gt; here.", entries(entry(term, definition))));
  for (const mark of b.marks()) b.click(mark);
  expect(b.open()).toBe(true);
  const dialog = required(b.dialog());
  expect(dialog.querySelectorAll("script, img, a, svg, style, b")).toHaveLength(0);
  expect([...dialog.querySelectorAll("*")].map((element) => element.localName)).toEqual(["strong", "p", "button"]);
  for (const element of dialog.querySelectorAll("*")) {
    expect([...element.childNodes].every((node) => node.nodeType === 3)).toBe(true);
    expect(element.getAttributeNames().filter((name) => name.startsWith("on"))).toEqual([]);
  }
  expect(b.window.document.querySelector("emend-term-card")?.childNodes).toHaveLength(0);
});

test("a hostile term cannot escape the term pattern", () => {
  const b = bridge(page("A (a+)+$ b and [x] c.", entries(entry("(a+)+$", "Regex."), entry("[x]", "Class."))));
  expect(markTexts(b)).toEqual(["(a+)+$", "[x]"]);
});

const sampleEntries = [
  { term: "Budget", aliases: ["allowance"], definition: "Money." },
  { term: "API", aliases: [], definition: "Interface." },
  { term: "hub  node", aliases: ["Hubs"], definition: "Machine." },
  { term: "Zoé", aliases: [], definition: "A name." },
  { term: "e-mail", aliases: ["mail"], definition: "Text." },
];
const matcherSamples = [
  "Budget",
  "A budget and a Budget.",
  "BUDGETS and budgets and budgetes",
  "the allowance, the budget",
  "unbudgeted budgeting budget_x _budget",
  "API apis APIs Api api",
  "an API, then APIs, then the API",
  "hub node and hub\nnode and hub\t \tnode",
  "hubs; Hubs; HUB NODES",
  "Zoé and zoé and Zoés",
  "e-mail, E-mail, mail, mails",
  "budget́ budget",
  "x budget́",
  "budget‍ budget",
  "漢budget budget漢 budget。",
  "😀budget budget😀",
  "none of them here",
  "",
  "budget budget budget allowance",
  "Budgetary budget'sbudget",
];

// The bridge's marks for one text node equal core's doc matcher (the regex matcher of the writeup agrees with it).
function expectBridgeMatchesCore(items: typeof sampleEntries, text: string) {
  const tree: HtmlRoot = { type: "root", children: [{ type: "text", value: text }] };
  const file = { data: { terms: docTermMatcher(items, DOC_TERM_MATCH_STEP_BUDGET) } } as unknown as Parameters<
    ReturnType<typeof markTerms>
  >[1];
  markTerms()(tree, file);
  const expected = tree.children.flatMap((node) =>
    node.type === "element" ? node.children.map((child) => (child.type === "text" ? child.value : "")) : [],
  );
  const definitions = items
    .map(
      (item) =>
        `<dt>${item.term}</dt>${item.aliases.map((alias) => `<dt>${alias}</dt>`).join("")}<dd>${item.definition}</dd>`,
    )
    .join("");
  // The bridge marks at ready, so the text goes in before it runs.
  const b = bridge(`<body><p id="t"></p>${entries(definitions)}</body>`, (window) => {
    window.document.querySelector("#t")?.append(text);
  });
  expect(markTexts(b)).toEqual(expected);
  expect(b.window.document.querySelector("#t")?.textContent).toBe(text);
  return expected;
}

test.each(matcherSamples)("bridge term marks match core for %s", (text) => {
  expectBridgeMatchesCore(sampleEntries, text);
});

// Characters whose case folding crosses scripts and lengths, and the characters the plain rule gets wrong.
const foldSpecials = [
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
test.each(foldSpecials)("bridge term marks match core for the fold group %s", (...members) => {
  // The bridge gives a text node that is not NFC no marks (a documented difference), and U+212A, U+0390's
  // twin U+1FD3 and U+03B0's twin U+1FE3 change under NFC, so only members that are stable are compared.
  const group = members.filter((member) => member.normalize("NFC") === member);
  for (const form of group) {
    const items = [
      { term: `x${form}y`, aliases: [], definition: "One." },
      { term: `${form}${form}`, aliases: [], definition: "Two." },
      { term: form, aliases: [], definition: "Three." },
    ];
    // Each group member as text, with the s and es suffixes, as one text node.
    const text = group.map((other) => `x${other}y ${other}${other} ${other}s ${other}es ${other}ES`).join(" | ");
    expect(expectBridgeMatchesCore(items, text).length).toBeGreaterThan(0);
  }
});

test("the bridge's fold exceptions stay in parity with core's", () => {
  expect(bridgeSource).toContain(
    "const foldExceptions = new Map([[0x131, 0x131], [0x1fd3, 0x390], [0x1fe3, 0x3b0], [0xfb05, 0xfb06]]);",
  );
  expect([0x131, 0x1fd3, 0x1fe3, 0xfb05].map(foldCodePoint)).toEqual([0x131, 0x390, 0x3b0, 0xfb06]);
});

test("the bridge matches multiword forms across every whitespace character, as core does", () => {
  const items = [{ term: "hub node", aliases: [], definition: "Machine." }];
  const gaps = ["\t", "\n", " ", "　", "    ", "﻿", "​", "᠎", ""];
  expect(gaps.map((gap) => expectBridgeMatchesCore(items, `hub${gap}node`).length)).toEqual([
    1, 1, 1, 1, 1, 1, 0, 0, 0,
  ]);
});

test("issue links and comment anchors keep working in a doc with marks", () => {
  const b = bridge(
    page("A budget, see #12 and the hub.", entries(entry("Budget", "Money."), entry("Hub", "Machine."))),
  );
  const text = required(b.window.document.querySelector("#t")).textContent;
  b.message({ type: "emend:repo", url: "https://github.com/o/r" });
  const link = required(b.window.document.querySelector("#t a"));
  expect(link.textContent).toBe("#12");
  b.post.mockClear();
  const issue = new b.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
  link.dispatchEvent(issue);
  expect(issue.defaultPrevented).toBe(true);
  expect(b.post.mock.calls).toEqual([[{ type: "emend:issue", number: 12 }, "*"]]);
  expect(b.open()).toBe(false);
  // A selection across marks and text becomes one anchor with the plain quote.
  const selection = required(b.window.getSelection());
  const range = b.window.document.createRange();
  range.selectNodeContents(required(b.window.document.querySelector("#t")));
  selection.removeAllRanges();
  selection.addRange(range);
  b.post.mockClear();
  b.window.document.dispatchEvent(new b.window.Event("mouseup", { bubbles: true }));
  expect(b.post.mock.calls).toHaveLength(1);
  expect(b.post.mock.calls[0]?.[0]).toMatchObject({ type: "emend:anchor", quote: text, prefix: "" });
  // The same selection, with the event coming from the card, is ignored.
  b.key(required(b.marks()[0]), "Enter");
  b.post.mockClear();
  b.fire(required(b.host()), "mouseup");
  expect(b.post.mock.calls).toEqual([]);
});

test("highlights anchor across marked text", () => {
  const b = bridge(page("A budget and a hub.", entries(entry("Budget", "Money."), entry("Hub", "Machine."))));
  b.message({
    type: "emend:highlight",
    anchors: [{ threadId: "t1", quote: "budget and a hub", prefix: "A ", suffix: "." }],
  });
  b.message({ type: "emend:scroll", threadId: "t1" });
  expect(b.scrolled).toHaveLength(1);
});
