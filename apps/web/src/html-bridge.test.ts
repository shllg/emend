// @vitest-environment node
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { ThemeColor } from "@recense/contract";
import { type Element, Window } from "happy-dom";
import { expect, test, vi } from "vitest";
import { docText, placeHtmlSpan } from "../../../packages/core/src/place/html.ts";
import { highlightHtmlCode } from "../../../packages/core/src/render/html-code.ts";

const corpus: { name: string; old: string; new: string }[] = JSON.parse(
  readFileSync(new URL("../../../packages/core/src/place/corpus/html.json", import.meta.url), "utf8"),
);
function bridge(html: string, customHighlights = true, prepare?: (window: Window) => void) {
  const window = new Window({
    url: `http://127.0.0.1:3636/content/${"k".repeat(43)}${"a".repeat(32)}/docs/seed.html`,
    settings: { enableJavaScriptEvaluation: false },
  });
  window.document.write(html);
  // Browser Node.textContent includes elements; happy-dom implements it on Element instead.
  const textContent = Object.getOwnPropertyDescriptor(window.Element.prototype, "textContent")?.get;
  if (!textContent) throw new Error("Missing textContent getter");
  vi.spyOn(window.Node.prototype, "textContent", "get").mockImplementation(function (this: Element) {
    return textContent.call(this);
  });
  // Unlike browsers, happy-dom's Node baseURI getter cannot run on a Document.
  const baseURI = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(window.Document.prototype), "baseURI")?.get;
  if (!baseURI) throw new Error("Missing document baseURI getter");
  vi.spyOn(window.Node.prototype, "baseURI", "get").mockImplementation(() => baseURI.call(window.document));
  const post = vi.fn();
  const parent = { postMessage: post };
  Object.defineProperty(window, "parent", { value: parent });
  const source = readFileSync(new URL("../../recense/src/server/content/bridge.ts", import.meta.url), "utf8");
  const script = runInNewContext(`${source.replace("export const", "const")}; BRIDGE_SOURCE;`);
  const highlights = new Map();
  Object.defineProperty(window, "HighlightRegistry", { value: Map });
  class Highlight {
    range: Range;
    constructor(range: Range) {
      this.range = range;
    }
  }
  const replaceSync = vi.spyOn(window.CSSStyleSheet.prototype, "replaceSync");
  prepare?.(window);
  runInNewContext(script, {
    window,
    document: window.document,
    parent,
    CSS: customHighlights ? { highlights } : {},
    Highlight,
    CSSStyleSheet: window.CSSStyleSheet,
    Node: window.Node,
    NodeFilter: window.NodeFilter,
    Range: window.Range,
    Intl,
  });
  window.document.dispatchEvent(new window.Event("DOMContentLoaded"));
  const message = (data: unknown, source: unknown = parent) =>
    window.dispatchEvent(new window.MessageEvent("message", { data, source: source as Window }));
  const select = (range = window.document.createRange()) => {
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    window.document.dispatchEvent(new window.Event("mouseup"));
    return post.mock.calls.findLast(([data]) => data.type === "recense:anchor")?.[0];
  };
  message({
    type: "recense:docs",
    paths: ["docs/seed.html", "docs/other.html", "docs/a #é.html", "docs/plan.md", "docs/plan.markdown"],
  });
  return { window, post, highlights, message, select, replaceSync };
}
test.each(corpus)("bridge text equals server docText for corpus $name", async (entry) => {
  for (const html of [entry.old, entry.new]) {
    const b = bridge(html);
    try {
      const range = b.window.document.createRange();
      range.selectNodeContents(b.window.document.body);
      const anchor = b.select(range);
      const expected = docText(html);
      if (expected) {
        expect(anchor).toEqual({ type: "recense:anchor", quote: expected, prefix: "", suffix: "" });
        expect(placeHtmlSpan(expected, { kind: "html-span", path: "doc.html", ...anchor }).status).toBe("placed");
      } else expect(anchor).toBeUndefined();
      expect(b.post).toHaveBeenCalledWith({ type: "recense:ready" }, "*");
    } finally {
      await b.window.happyDOM.close();
    }
  }
});

test("theme messages replace one layered sheet, set only the root mode, and never scroll or post", async () => {
  const b = bridge('<html lang="en"><body><h2>Part</h2></body></html>');
  const root = b.window.document.documentElement;
  const set = vi.spyOn(b.window.Element.prototype, "setAttribute");
  const adopt = vi.spyOn(b.window.Document.prototype, "adoptedStyleSheets", "set");
  const scroll = vi.spyOn(b.window.Element.prototype, "scrollIntoView");
  const scrollTo = vi.spyOn(b.window.Element.prototype, "scrollTo");
  const windowScroll = vi.spyOn(b.window, "scrollTo");
  const clobbered = vi.fn();
  Object.defineProperty(root, "setAttribute", { value: clobbered });
  Object.defineProperty(b.window.document, "documentElement", {
    configurable: true,
    value: b.window.document.createElement("form"),
  });
  b.post.mockClear();
  try {
    b.message({
      type: "recense:theme",
      mode: "dark",
      scales: { "n-950": "#112233" },
      tokens: { "fg-1": "#eeeeee", "bg-app": "n-950" },
    });
    expect(root.getAttribute("data-theme")).toBe("dark");
    expect(b.replaceSync).toHaveBeenCalledExactlyOnceWith(
      "@layer recense{:root:root:root{--n-950:#112233;--fg-1:#eeeeee;--bg-app:var(--n-950);}}",
    );
    const sheets = b.window.document.adoptedStyleSheets;
    expect(sheets).toHaveLength(1);
    const sheet = sheets[0];
    if (!sheet) throw new Error("Missing theme sheet");
    Object.defineProperty(sheet, "replaceSync", { value: clobbered });
    Object.defineProperty(b.window.document, "adoptedStyleSheets", {
      configurable: true,
      get: clobbered,
      set: clobbered,
    });
    b.message({
      type: "recense:theme",
      mode: "light",
      scales: { "n-25": "oklch(0.98 0.01 260 / 0.5)" },
      tokens: { "fg-1": "#112233ff" },
    });
    expect(root.getAttribute("data-theme")).toBe("light");
    expect(b.replaceSync).toHaveBeenLastCalledWith(
      "@layer recense{:root:root:root{--n-25:oklch(0.98 0.01 260 / 0.5);--fg-1:#112233ff;}}",
    );
    b.message({ type: "recense:theme", mode: "dark", scales: {}, tokens: {} });
    expect(b.replaceSync).toHaveBeenLastCalledWith("");
    expect(b.replaceSync.mock.instances).toEqual([sheet, sheet, sheet]);
    expect(adopt).toHaveBeenCalledExactlyOnceWith([sheet]);
    expect(set.mock.calls).toEqual([
      ["data-theme", "dark"],
      ["data-theme", "light"],
      ["data-theme", "dark"],
    ]);
    expect(set.mock.instances).toEqual([root, root, root]);
    expect(root.getAttribute("lang")).toBe("en");
    for (const spy of [clobbered, scroll, scrollTo, windowScroll, b.post]) expect(spy).not.toHaveBeenCalled();
  } finally {
    Reflect.deleteProperty(b.window.document, "documentElement");
    Reflect.deleteProperty(b.window.document, "adoptedStyleSheets");
    vi.restoreAllMocks();
    await b.window.happyDOM.close();
  }
});

test.each([
  "#ffffff",
  "#aabbcc00",
  "oklch(0.995 0.001 260)",
  "oklch(0 0 0)",
  "oklch(1 0.5 359.999999 / 0.5)",
  "oklch(0.000001 0.1 0 / 0)",
  "oklch(0.2 0.01 260.123456)",
  "oklch(0.123456 0.123456 123.123456 / 0.123456)",
  "oklch(1 0.5 359.999999 / 0.999999)",
])("theme bridge accepts the contract colour %s in both maps", async (color) => {
  expect(ThemeColor.parse(color)).toBe(color);
  const b = bridge("<p>Seed</p>");
  try {
    b.message({ type: "recense:theme", mode: "dark", scales: { "n-950": color }, tokens: { "bg-app": color } });
    expect(b.window.document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(b.replaceSync).toHaveBeenCalledExactlyOnceWith(
      `@layer recense{:root:root:root{--n-950:${color};--bg-app:${color};}}`,
    );
  } finally {
    vi.restoreAllMocks();
    await b.window.happyDOM.close();
  }
});

test.each(
  ["0e0", "+0", "-0", ".1", "0.1234567", "00", "0.10", "1000"].flatMap((number) =>
    Array.from({ length: 4 }, (_, index) => {
      const numbers = ["0", "0", "0", "0"];
      numbers[index] = number;
      return `oklch(${numbers[0]} ${numbers[1]} ${numbers[2]} / ${numbers[3]})`;
    }),
  ),
)("theme bridge refuses noncanonical colour %s in both maps", async (color) => {
  expect(ThemeColor.safeParse(color).success).toBe(false);
  const b = bridge("<p>Seed</p>");
  try {
    const valid = {
      type: "recense:theme",
      mode: "light",
      scales: { "n-950": "#112233" },
      tokens: { "bg-app": "n-950" },
    };
    b.message(valid);
    b.replaceSync.mockClear();
    for (const field of ["scales", "tokens"]) {
      b.message({ ...valid, mode: "dark", [field]: { "n-950": color } });
      expect(b.window.document.documentElement.getAttribute("data-theme")).toBe("light");
      expect(b.replaceSync).not.toHaveBeenCalled();
    }
  } finally {
    vi.restoreAllMocks();
    await b.window.happyDOM.close();
  }
});

test("theme messages reject invalid entries and foreign sources without changing any state", async () => {
  const b = bridge("<h2>Part</h2>");
  const valid = { type: "recense:theme", mode: "dark", scales: { "n-950": "#112233" }, tokens: { "bg-app": "n-950" } };
  b.message({ ...valid, mode: "light" });
  const root = b.window.document.documentElement;
  const sheets = [...b.window.document.adoptedStyleSheets];
  const set = vi.spyOn(b.window.Element.prototype, "setAttribute");
  const adopt = vi.spyOn(b.window.Document.prototype, "adoptedStyleSheets", "set");
  const scroll = vi.spyOn(b.window.Element.prototype, "scrollIntoView");
  const scrollTo = vi.spyOn(b.window.Element.prototype, "scrollTo");
  b.replaceSync.mockClear();
  b.post.mockClear();
  try {
    const invalid = [
      ...[undefined, null, "DARK", "dark\n", "system", {}, [], 1].map((mode) => ({ ...valid, mode })),
      ...["scales", "tokens"].flatMap((field) => [
        ...[
          undefined,
          null,
          [],
          "colors",
          1,
          Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`n-${i}`, "#112233"])),
        ].map((value) => ({ ...valid, [field]: value })),
        ...["N-950", "n--950", "--", "-n", "n-", "a".repeat(41), "n\n", ""].map((name) => ({
          ...valid,
          [field]: { [name]: "#112233" },
        })),
        ...["#fff;}", "url(x)", "var(--a)", "oklch(1 0 0);x", "expression(1)", "#abcdef\n", "#ABCDEF", null, 1].map(
          (value) => ({ ...valid, [field]: { "n-950": value } }),
        ),
      ]),
      { ...valid, scales: { "n-950": "red" } },
      { ...valid, scales: { "n-950": "n-25" } },
      ...["N-950", "n--950", "-n", "n-", "a".repeat(41)].map((value) => ({ ...valid, tokens: { "bg-app": value } })),
    ];
    for (const data of invalid) b.message(data);
    for (const source of [null, b.window, {}]) b.message(valid, source);
    expect(root.getAttribute("data-theme")).toBe("light");
    expect(b.window.document.adoptedStyleSheets).toEqual(sheets);
    for (const spy of [set, adopt, b.replaceSync, scroll, scrollTo, b.post]) expect(spy).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    await b.window.happyDOM.close();
  }
});

test("theme maps accept the entry and key length boundaries", async () => {
  const b = bridge("<p>Seed</p>");
  try {
    const scales = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`n-${i}`, "#112233"]));
    b.message({ type: "recense:theme", mode: "dark", scales, tokens: { ["a".repeat(40)]: "oklch(1 0 0)" } });
    expect(b.window.document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(b.replaceSync).toHaveBeenCalledExactlyOnceWith(
      `@layer recense{:root:root:root{${Object.keys(scales)
        .map((name) => `--${name}:#112233;`)
        .join("")}--${"a".repeat(40)}:oklch(1 0 0);}}`,
    );
  } finally {
    vi.restoreAllMocks();
    await b.window.happyDOM.close();
  }
});

test("theme mode applies without constructed stylesheets", async () => {
  const b = bridge("<p>Seed</p>", true, (window) => {
    Object.defineProperty(window, "CSSStyleSheet", { value: undefined });
  });
  try {
    b.message({ type: "recense:theme", mode: "dark", scales: { "n-950": "#112233" }, tokens: {} });
    expect(b.window.document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(b.window.document.adoptedStyleSheets).toEqual([]);
    expect(b.replaceSync).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    await b.window.happyDOM.close();
  }
});

test("bridge applies parent layout preferences through prototype DOM calls", async () => {
  const b = bridge("<body><h2>Part</h2></body>");
  // Attribute checks need no layout; the reflow harness supplies it explicitly.
  const visible = vi.spyOn(b.window.Element.prototype, "checkVisibility").mockReturnValue(false);
  try {
    const root = b.window.document.documentElement;
    const clobbered = vi.fn();
    Object.defineProperty(root, "setAttribute", { value: clobbered });
    Object.defineProperty(root, "getAttribute", { value: clobbered });
    const attribute = (name: string) => b.window.Element.prototype.getAttribute.call(root, name);
    Object.defineProperty(b.window.document, "documentElement", {
      configurable: true,
      value: b.window.document.createElement("form"),
    });
    expect(root.hasAttribute("data-recense-layout")).toBe(false);
    b.message({ type: "recense:layout", wide: true });
    expect(attribute("data-recense-layout")).toBe("wide");
    b.message({ type: "recense:layout", wide: false, width: "narrow", prose: 18, code: 15 });
    expect(attribute("data-recense-layout")).toBe("narrow");
    expect(attribute("data-recense-width")).toBe("narrow");
    expect(attribute("data-recense-prose")).toBe("18");
    expect(attribute("data-recense-code")).toBe("15");
    expect(clobbered).not.toHaveBeenCalled();
  } finally {
    visible.mockRestore();
    Reflect.deleteProperty(b.window.document, "documentElement");
    await b.window.happyDOM.close();
  }
});

test("bridge sets each allowed preference and legacy layout leaves preferences alone", async () => {
  const b = bridge("<h2>Part</h2>");
  const visible = vi.spyOn(b.window.Element.prototype, "checkVisibility").mockReturnValue(false);
  const set = vi.spyOn(b.window.Element.prototype, "setAttribute");
  try {
    const root = b.window.document.documentElement;
    for (const wide of [true, false])
      for (const width of ["comfortable", "wide", "narrow"])
        for (const prose of [15, 16, 17, 18])
          for (const code of [12, 13, 14, 15]) {
            set.mockClear();
            b.message({ type: "recense:layout", wide, width, prose, code });
            expect(set.mock.calls).toEqual([
              ["data-recense-layout", wide ? "wide" : "narrow"],
              ["data-recense-width", width],
              ["data-recense-prose", String(prose)],
              ["data-recense-code", String(code)],
              ["data-emend-layout", wide ? "wide" : "narrow"],
              ["data-emend-width", width],
              ["data-emend-prose", String(prose)],
              ["data-emend-code", String(code)],
            ]);
            expect(set.mock.instances.every((element) => element === root)).toBe(true);
            expect(root.getAttribute("data-recense-width")).toBe(width);
            expect(root.getAttribute("data-recense-prose")).toBe(String(prose));
            expect(root.getAttribute("data-recense-code")).toBe(String(code));
            // Pages that the emend command styled key their layout rules to the old names.
            expect(root.getAttribute("data-emend-width")).toBe(width);
            expect(root.getAttribute("data-emend-prose")).toBe(String(prose));
            expect(root.getAttribute("data-emend-code")).toBe(String(code));
            expect(root.getAttribute("data-emend-layout")).toBe(wide ? "wide" : "narrow");
          }
    set.mockClear();
    b.message({ type: "recense:layout", wide: true });
    expect(set.mock.calls).toEqual([
      ["data-recense-layout", "wide"],
      ["data-emend-layout", "wide"],
    ]);
    expect(root.getAttribute("data-recense-width")).toBe("narrow");
    expect(root.getAttribute("data-recense-prose")).toBe("18");
    expect(root.getAttribute("data-recense-code")).toBe("15");
  } finally {
    set.mockRestore();
    visible.mockRestore();
    await b.window.happyDOM.close();
  }
});

test("bridge ignores invalid or partial preferences and messages from anyone but its parent", async () => {
  const b = bridge("<h2>Part</h2>");
  const visible = vi.spyOn(b.window.Element.prototype, "checkVisibility").mockReturnValue(false);
  const root = b.window.document.documentElement;
  b.message({ type: "recense:layout", wide: false, width: "narrow", prose: 15, code: 12 });
  const before = [...root.attributes].map(({ name, value }) => [name, value]);
  const set = vi.spyOn(b.window.Element.prototype, "setAttribute");
  try {
    const full = { type: "recense:layout", wide: true, width: "wide", prose: 17, code: 14 };
    const invalid = [
      ...[undefined, null, "true", 1, {}, []].map((wide) => ({ ...full, wide })),
      ...[undefined, null, "unknown", "68ch", 0, {}, []].map((width) => ({ ...full, width })),
      ...[undefined, null, 14, 19, 16.5, "17", {}, [], true, NaN, Infinity].map((prose) => ({ ...full, prose })),
      ...[undefined, null, 11, 16, 13.5, 16.5, "13", {}, [], true, NaN, Infinity].map((code) => ({ ...full, code })),
      ...[
        { width: "wide" },
        { prose: 17 },
        { code: 14 },
        { width: "wide", prose: 17 },
        { width: "wide", code: 14 },
        { prose: 17, code: 14 },
      ].map((partial) => ({ type: "recense:layout", wide: true, ...partial })),
    ];
    for (const data of invalid) b.message(data);
    for (const source of [null, b.window, {}]) b.message(full, source);
    expect(set).not.toHaveBeenCalled();
    expect([...root.attributes].map(({ name, value }) => [name, value])).toEqual(before);
  } finally {
    set.mockRestore();
    visible.mockRestore();
    await b.window.happyDOM.close();
  }
});

const initialLayout = { type: "recense:layout", wide: true, width: "comfortable", prose: 16, code: 13 };

function layoutBridge(
  html = "<h2>First</h2><h3>Second</h3><h2>Last</h2>",
  {
    offsets = [300, 350, 900],
    wideScale = 2,
    nested = false,
    reverse = false,
  }: {
    offsets?: number[];
    wideScale?: number;
    nested?: boolean;
    reverse?: boolean;
  } = {},
) {
  const b = bridge(html, true, (window) => {
    if (vi.isFakeTimers())
      Object.assign(window, { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
  });
  const root = b.window.document.scrollingElement;
  const container = nested ? b.window.document.querySelector("main") : root;
  if (!container) throw new Error("Missing scroll container");
  const { get: getTop, set: setTop } = Object.getOwnPropertyDescriptor(b.window.Element.prototype, "scrollTop") ?? {};
  if (!getTop || !setTop) throw new Error("Missing scrollTop accessors");
  const readTop = (element: Element): number => getTop.call(element);
  const writeTop = (element: Element, top: number) => setTop.call(element, top);
  const attribute = (name: string) => b.window.Element.prototype.getAttribute.call(root, name);
  const headings = [...b.window.document.querySelectorAll("h2,h3")];
  Object.defineProperty(b.window, "innerHeight", { configurable: true, value: 400 });
  const assignedSlot = Object.getOwnPropertyDescriptor(b.window.Element.prototype, "assignedSlot");
  if (!assignedSlot)
    Object.defineProperty(b.window.Element.prototype, "assignedSlot", { configurable: true, get: () => null });
  const scale = () => {
    if (attribute("data-recense-width") === "wide") return wideScale;
    return attribute("data-recense-prose") === "18" ||
      attribute("data-recense-code") === "15" ||
      attribute("data-recense-layout") === "narrow"
      ? 2
      : 1;
  };
  const diagramHeight = () => (b.window.document.querySelector("[data-recense-diagram]") ? 200 : 0);
  const limit = () => Math.max(0, 1100 * scale() + diagramHeight() - 400);
  const offset = (element: Element) =>
    (offsets[headings.indexOf(element)] ?? 0) * scale() + diagramHeight() - (reverse ? limit() : 0);
  const clamp = (top: number) => (reverse ? Math.min(0, Math.max(-limit(), top)) : Math.max(0, Math.min(limit(), top)));
  const visible = vi.spyOn(b.window.Element.prototype, "checkVisibility").mockReturnValue(true);
  const scrollHeight = vi.spyOn(b.window.Element.prototype, "scrollHeight", "get").mockImplementation(function (
    this: Element,
  ) {
    return nested && this !== container ? 400 : 1100 * scale() + diagramHeight();
  });
  const bounds = vi.spyOn(b.window.Element.prototype, "getBoundingClientRect").mockImplementation(function (
    this: Element,
  ) {
    return new b.window.DOMRect(0, offset(this) - readTop(container) - (nested ? readTop(root) : 0), 400, 20);
  });
  const scroll = vi.spyOn(b.window.Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
    writeTop(container, clamp(offset(this)));
  });
  const scrollTo = vi.spyOn(b.window.Element.prototype, "scrollTo").mockImplementation(function (
    this: Element,
    options: number | ScrollToOptions | undefined,
  ) {
    if (this === container && typeof options === "object" && options.behavior === "instant")
      writeTop(this, clamp(Math.round(options.top ?? 0)));
  });
  b.message(initialLayout);
  const restore = () => {
    for (const spy of [visible, scrollHeight, bounds, scroll, scrollTo]) spy.mockRestore();
    if (!assignedSlot) Reflect.deleteProperty(b.window.Element.prototype, "assignedSlot");
  };
  return { ...b, root, container, headings, visible, scroll, scrollTo, readTop, writeTop, restore };
}

test.each([{ prose: 18 }, { code: 15 }, { width: "wide" }, { wide: false }])(
  "layout change %j keeps the scrolled heading and fraction through reflow",
  async (change) => {
    const b = layoutBridge();
    try {
      b.root.scrollTop = 500;
      const fraction = (100 - (350 - b.root.scrollTop)) / (900 - 350);
      b.message({ ...initialLayout, ...change });
      expect(b.scroll).toHaveBeenCalledExactlyOnceWith({ block: "start", behavior: "instant" });
      expect(b.scroll.mock.instances[0]).toBe(b.headings[1]);
      expect(b.root.scrollTop).toBe(1100);
      expect((100 - (700 - b.root.scrollTop)) / (1800 - 700)).toBeCloseTo(fraction);
      expect(b.window.document.body.scrollTop).toBe(0);
    } finally {
      b.restore();
      await b.window.happyDOM.close();
    }
  },
);

test.each([false, true])("layout change preserves only a pin that still holds (moved=%s)", async (moved) => {
  const b = layoutBridge();
  try {
    b.message({ type: "recense:goto", heading: 0, label: "First", fraction: 0.25 });
    expect(b.root.scrollTop).toBe(213); // Rounded landing is 0.26; the pin holds 0.25.
    if (moved) b.root.scrollTop = 225; // The reader moved to fraction 0.5 before the next sample.
    b.scroll.mockClear();
    b.message({ ...initialLayout, prose: 18 });
    expect(b.scroll.mock.instances).toEqual([b.headings[0]]);
    expect(b.root.scrollTop).toBe(moved ? 550 : 525);
  } finally {
    b.restore();
    await b.window.happyDOM.close();
  }
});

test("layout keeps a pin clamped to zero when Wide fits and restores it on returning to Narrow", async () => {
  vi.useFakeTimers();
  const b = layoutBridge(undefined, { wideScale: 0.25 });
  try {
    const narrow = { ...initialLayout, width: "narrow" };
    b.message(narrow);
    b.root.scrollTop = 500;
    const held = { type: "recense:position", heading: 1, fraction: 5 / 11 };
    b.message({ ...initialLayout, width: "wide" });
    expect(b.scroll.mock.instances).toEqual([b.headings[1]]);
    expect(b.root.scrollTop).toBe(0);
    vi.runAllTimers();
    expect(b.post).toHaveBeenLastCalledWith(held, "*");
    b.scroll.mockClear();
    b.message(narrow);
    expect(b.scroll.mock.instances).toEqual([b.headings[1]]);
    expect(b.root.scrollTop).toBe(500);
    vi.runAllTimers();
    expect(b.post).toHaveBeenLastCalledWith(held, "*");
  } finally {
    b.restore();
    vi.clearAllTimers();
    vi.useRealTimers();
    await b.window.happyDOM.close();
  }
});

const nestedLayoutHtml = '<main style="height:400px;overflow:auto"><h2>First</h2><h3>Second</h3><h2>Last</h2></main>';

test("layout keeps the heading and fraction inside a scrolled container while the root stays at zero", async () => {
  const b = layoutBridge(nestedLayoutHtml, { nested: true });
  try {
    b.container.scrollTop = 500;
    const fraction = (100 - (350 - b.container.scrollTop)) / (900 - 350);
    b.message({ ...initialLayout, prose: 18 });
    expect(b.scroll.mock.instances).toEqual([b.headings[1]]);
    expect(b.scrollTo.mock.instances).toContain(b.container);
    expect(b.container.scrollTop).toBe(1100);
    expect((100 - (700 - b.container.scrollTop)) / (1800 - 700)).toBeCloseTo(fraction);
    expect(b.root.scrollTop).toBe(0);
    expect(b.window.document.body.scrollTop).toBe(0);
  } finally {
    b.restore();
    await b.window.happyDOM.close();
  }
});

test("layout holds a negative scrollTop in a column-reverse container through a size change", async () => {
  const b = layoutBridge(
    '<main style="height:400px;overflow:auto;display:flex;flex-direction:column-reverse">' +
      '<article style="flex-shrink:0"><h2>First</h2><h3>Second</h3><h2>Last</h2></article></main>',
    { nested: true, reverse: true },
  );
  try {
    b.container.scrollTop = -200;
    const fraction = (100 - (-350 - b.container.scrollTop)) / 550;
    b.message({ ...initialLayout, prose: 18 });
    expect(b.scroll.mock.instances).toEqual([b.headings[1]]);
    expect(b.scrollTo.mock.instances).toContain(b.container);
    expect(b.container.scrollTop).toBe(-700);
    expect((100 - (-1100 - b.container.scrollTop)) / 1100).toBeCloseTo(fraction);
    expect(b.root.scrollTop).toBe(0);
  } finally {
    b.restore();
    await b.window.happyDOM.close();
  }
});

test("layout holds through prototype calls despite clobbered root and container members", async () => {
  const b = layoutBridge(nestedLayoutHtml, { nested: true });
  // happy-dom's scrollY getter reads root.scrollTop; a browser's native getter does not.
  const scrollY = vi.spyOn(b.window, "scrollY", "get").mockImplementation(() => b.readTop(b.root));
  const clobbered = vi.fn();
  const members = [b.root, b.container].flatMap((element) =>
    ["setAttribute", "getAttribute", "scrollTop"].map((name) => ({
      element,
      name,
      descriptor: Object.getOwnPropertyDescriptor(element, name),
    })),
  );
  try {
    b.writeTop(b.container, 500);
    for (const { element, name } of members)
      Object.defineProperty(element, name, {
        configurable: true,
        ...(name === "scrollTop" ? { get: clobbered, set: clobbered } : { value: clobbered }),
      });
    b.message({ ...initialLayout, prose: 18 });
    expect(b.scroll).toHaveBeenCalledExactlyOnceWith({ block: "start", behavior: "instant" });
    expect(b.scroll.mock.instances).toEqual([b.headings[1]]);
    expect(b.readTop(b.container)).toBe(1100);
    expect((100 - (700 - b.readTop(b.container))) / 1100).toBeCloseTo(5 / 11);
    expect(b.readTop(b.root)).toBe(0);
    expect(b.window.Element.prototype.getAttribute.call(b.root, "data-recense-prose")).toBe("18");
    expect(clobbered).not.toHaveBeenCalled();
  } finally {
    for (const { element, name, descriptor } of members) {
      if (descriptor) Object.defineProperty(element, name, descriptor);
      else Reflect.deleteProperty(element, name);
    }
    scrollY.mockRestore();
    b.restore();
    await b.window.happyDOM.close();
  }
});

test("layout leaves an unscrolled doc at the top even when the first heading is above the reading line", async () => {
  const b = layoutBridge(undefined, { offsets: [0, 350, 900] });
  try {
    b.message({ ...initialLayout, prose: 18 });
    expect(b.scroll).not.toHaveBeenCalled();
    expect(b.scrollTo).not.toHaveBeenCalled();
    expect(b.root.scrollTop).toBe(0);
  } finally {
    b.restore();
    await b.window.happyDOM.close();
  }
});

test.each([false, true])(
  "position samples keep restored and reflowed pins until the reader scrolls (nested=%s)",
  async (nested) => {
    vi.useFakeTimers();
    const b = layoutBridge(nested ? nestedLayoutHtml : undefined, { nested });
    try {
      expect(b.post).toHaveBeenCalledWith({ type: "recense:ready" }, "*");
      const held = { type: "recense:position", heading: 0, fraction: 0.25 };
      b.message({ type: "recense:goto", heading: 0, label: "First", fraction: 0.25 });
      expect(b.container.scrollTop).toBe(213);
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      vi.runAllTimers();
      expect(b.post).toHaveBeenLastCalledWith(held, "*");

      b.message({ ...initialLayout, prose: 18 });
      expect(b.container.scrollTop).toBe(525);
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      vi.runAllTimers();
      expect(b.post).toHaveBeenLastCalledWith(held, "*");

      b.post.mockClear();
      b.container.scrollTop = 900;
      b.container.dispatchEvent(new b.window.Event("scroll"));
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      vi.runAllTimers();
      expect(b.post).toHaveBeenCalledExactlyOnceWith({ type: "recense:position", heading: 1, fraction: 3 / 11 }, "*");
      if (nested) expect(b.root.scrollTop).toBe(0);
    } finally {
      b.restore();
      vi.clearAllTimers();
      vi.useRealTimers();
      await b.window.happyDOM.close();
    }
  },
);

test.each(["top", "unchanged", "hidden", "no headings", "before headings"])(
  "layout does not scroll at %s",
  async (kind) => {
    const b = layoutBridge(kind === "no headings" ? "<p>Introduction</p>" : undefined);
    try {
      b.root.scrollTop = kind === "top" ? 0 : kind === "before headings" ? 10 : 500;
      if (kind === "hidden") b.visible.mockReturnValue(false);
      b.message(kind === "unchanged" ? initialLayout : { ...initialLayout, prose: 18 });
      expect(b.scroll).not.toHaveBeenCalled();
      expect(b.scrollTo).not.toHaveBeenCalled();
      expect(b.root.getAttribute("data-recense-prose")).toBe(kind === "unchanged" ? "16" : "18");
    } finally {
      b.restore();
      await b.window.happyDOM.close();
    }
  },
);

test("bridge ignores non-boolean layouts and layouts from anyone but the parent", async () => {
  const b = bridge("<body><h2>Part</h2></body>");
  const visible = vi.spyOn(b.window.Element.prototype, "checkVisibility").mockReturnValue(false);
  try {
    const root = b.window.document.documentElement;
    b.message({ type: "recense:layout", wide: false });
    for (const wide of [undefined, null, "wide", "true", 0, 1, {}, []]) b.message({ type: "recense:layout", wide });
    for (const source of [null, b.window, {}]) b.message({ type: "recense:layout", wide: true }, source);
    expect(root.getAttribute("data-recense-layout")).toBe("narrow");
  } finally {
    visible.mockRestore();
    await b.window.happyDOM.close();
  }
});

test("bridge ignores layout when the document has no root", async () => {
  const b = bridge("<body><h2>Part</h2></body>");
  try {
    const root = b.window.document.documentElement;
    b.window.document.removeChild(root);
    expect(() => b.message({ type: "recense:layout", wide: true })).not.toThrow();
    expect(root.hasAttribute("data-recense-layout")).toBe(false);
  } finally {
    await b.window.happyDOM.close();
  }
});

test("bridge posts a touch selection from a debounced selectionchange and keeps the 2000 character limit", async () => {
  vi.useFakeTimers();
  const b = bridge(`<body><p>Alpha beta gamma</p><p>${"x".repeat(2001)}</p></body>`);
  // The happy-dom window keeps its own timers; give the bridge the faked ones.
  Object.assign(b.window, { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
  try {
    const [first, second] = [...b.window.document.querySelectorAll("p")];
    const text = first?.firstChild;
    if (!text || !second) throw new Error("Missing text");
    const range = b.window.document.createRange();
    range.setStart(text, 6);
    range.setEnd(text, 10);
    const selection = b.window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    b.window.document.dispatchEvent(new b.window.Event("selectionchange"));
    b.window.document.dispatchEvent(new b.window.Event("selectionchange"));
    expect(b.post.mock.calls.some(([data]) => data.type === "recense:anchor")).toBe(false);
    vi.advanceTimersByTime(199);
    expect(b.post.mock.calls.some(([data]) => data.type === "recense:anchor")).toBe(false);
    vi.advanceTimersByTime(1);
    const anchors = b.post.mock.calls.filter(([data]) => data.type === "recense:anchor");
    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.[0]).toMatchObject({ quote: "beta", prefix: "Alpha ", suffix: ` gamma${"x".repeat(26)}` });
    const tooLong = b.window.document.createRange();
    tooLong.selectNodeContents(second);
    selection?.removeAllRanges();
    selection?.addRange(tooLong);
    b.window.document.dispatchEvent(new b.window.Event("selectionchange"));
    vi.advanceTimersByTime(300);
    expect(b.post.mock.calls.filter(([data]) => data.type === "recense:anchor")).toHaveLength(1);
  } finally {
    vi.useRealTimers();
    await b.window.happyDOM.close();
  }
});

test.each(["mouse", "touch"])("bridge reports a collapsed %s selection once capture runs", async (pointerType) => {
  vi.useFakeTimers();
  const b = bridge("<p>Seeds grow</p>");
  Object.assign(b.window, { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
  try {
    const doc = b.window.document;
    const paragraph = doc.querySelector("p");
    if (!paragraph?.firstChild) throw new Error("Missing paragraph text");
    const selectionMessages = () =>
      b.post.mock.calls.filter(([data]) => data.type === "recense:anchor" || data.type === "recense:deselect");
    const range = doc.createRange();
    range.selectNodeContents(paragraph);
    expect(b.select(range)).toMatchObject({ type: "recense:anchor", quote: "Seeds grow" });
    b.post.mockClear();
    if (pointerType === "mouse") {
      paragraph.dispatchEvent(new b.window.PointerEvent("pointerdown", { bubbles: true, pointerType }));
      paragraph.dispatchEvent(new b.window.MouseEvent("mousedown", { bubbles: true }));
    }
    b.window.getSelection()?.collapse(paragraph.firstChild, 0);
    doc.dispatchEvent(new b.window.Event("selectionchange"));
    vi.advanceTimersByTime(pointerType === "mouse" ? 120 : 199);
    expect(selectionMessages()).toEqual([]);
    if (pointerType === "mouse") {
      paragraph.dispatchEvent(new b.window.PointerEvent("pointerup", { bubbles: true, pointerType }));
      paragraph.dispatchEvent(new b.window.MouseEvent("mouseup", { bubbles: true }));
    } else vi.advanceTimersByTime(1);
    expect(selectionMessages()).toEqual([[{ type: "recense:deselect" }, "*"]]);
    b.post.mockClear();
    doc.dispatchEvent(new b.window.Event("keyup"));
    expect(b.post).toHaveBeenCalledExactlyOnceWith({ type: "recense:deselect" }, "*");
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
    await b.window.happyDOM.close();
  }
});

test("glossary card events are ignored and a selection in the card retires the document quote", async () => {
  const b = bridge("<p>Seeds grow.</p><h2>Glossary</h2><dl><dt>Seeds</dt><dd>Grains.</dd></dl>");
  try {
    const doc = b.window.document;
    const attach = vi.spyOn(b.window.Element.prototype, "attachShadow");
    const mark = doc.querySelector("span[aria-haspopup]");
    if (!mark?.firstChild) throw new Error("Missing glossary mark");
    const range = doc.createRange();
    range.selectNodeContents(mark.firstChild);
    expect(b.select(range)).toMatchObject({ type: "recense:anchor", quote: "Seeds" });
    mark.dispatchEvent(new b.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const result = attach.mock.results[0];
    const definition = result?.type === "return" ? result.value.querySelector("p") : null;
    if (!definition?.firstChild) throw new Error("Missing glossary definition");
    range.selectNodeContents(definition.firstChild);
    const selection = b.window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    expect(selection?.toString()).toBe("Grains.");
    b.post.mockClear();
    definition.dispatchEvent(new b.window.MouseEvent("mouseup", { bubbles: true, composed: true }));
    expect(b.post).not.toHaveBeenCalled();
    doc.dispatchEvent(new b.window.Event("mouseup"));
    expect(b.post).toHaveBeenCalledExactlyOnceWith({ type: "recense:deselect" }, "*");
  } finally {
    vi.restoreAllMocks();
    await b.window.happyDOM.close();
  }
});

test.each([
  ["other.html#heading", "docs/other.html", "heading"],
  ["a%20%23%C3%A9.html#part%20%C3%A9%25%23", "docs/a #é.html", "part é%#"],
  ["plan.md", "docs/plan.md", ""],
  ["plan.markdown#detail", "docs/plan.markdown", "detail"],
])(
  "doc link %s posts navigation in capture phase and prevents its own frame navigation",
  async (href, path, fragment) => {
    const b = bridge(`<body><a href="${href}"><span>Other doc</span></a></body>`);
    try {
      const link = b.window.document.querySelector("a");
      const span = b.window.document.querySelector("span");
      if (!link || !span) throw new Error("Missing link");
      const captured: boolean[] = [];
      link.addEventListener("click", (event) => {
        captured.push(event.defaultPrevented);
        event.stopPropagation();
      });
      const click = new b.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
      span.dispatchEvent(click);
      expect(captured).toEqual([true]);
      expect(click.defaultPrevented).toBe(true);
      expect(b.post).toHaveBeenCalledWith({ type: "recense:navigate", path, fragment }, "*");
    } finally {
      await b.window.happyDOM.close();
    }
  },
);

test.each([
  ["seed.svg", {}],
  ["shared.css", {}],
  ["module.mjs", {}],
  ["font.woff2", {}],
  ["https://example.com/other.html", {}],
  ["/other.html", {}],
  [`/content/${"x".repeat(75)}/docs/other.html`, {}],
  ["broken%.html", {}],
  ["other.html", { button: 1 }],
  ["other.html", { ctrlKey: true }],
  ["other.html", { metaKey: true }],
  ["other.html", { altKey: true }],
  ["other.html", { shiftKey: true }],
])("bridge leaves other link behavior intact: %s %j", async (href, options) => {
  const b = bridge(`<body><a href="${href}">Link</a></body>`);
  try {
    const link = b.window.document.querySelector("a");
    if (!link) throw new Error("Missing link");
    const captured: boolean[] = [];
    // Stop the test DOM's default navigation only after observing the bridge's capture handler.
    link.addEventListener("click", (event) => {
      captured.push(event.defaultPrevented);
      event.preventDefault();
    });
    link.dispatchEvent(new b.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...options }));
    expect(captured).toEqual([false]);
    expect(b.post.mock.calls.filter(([message]) => message.type === "recense:navigate")).toEqual([]);
  } finally {
    await b.window.happyDOM.close();
  }
});
test("selection normalizes across nodes, skips omitted subtrees, and supplies 32-character context", async () => {
  const html = `<body>${"a".repeat(40)} <b>Cafe</b>\u0301\u2003<script>hidden</script><i>seeds</i> ${"z".repeat(40)}</body>`;
  const b = bridge(html);
  try {
    const range = b.window.document.createRange();
    const start = b.window.document.querySelector("b")?.firstChild;
    const end = b.window.document.querySelector("i")?.firstChild;
    if (!start || !end) throw new Error("Missing fixture text");
    range.setStart(start, 0);
    range.setEnd(end, 5);
    const anchor = b.select(range);
    expect(anchor).toEqual({
      type: "recense:anchor",
      quote: "Café seeds",
      prefix: `${"a".repeat(31)} `,
      suffix: ` ${"z".repeat(31)}`,
    });
    expect(placeHtmlSpan(docText(html), { kind: "html-span", path: "doc.html", ...anchor })).toMatchObject({
      status: "placed",
      location: { start: 41, end: 51 },
    });
  } finally {
    await b.window.happyDOM.close();
  }
});
test("selection and highlights span coloured tokens without changing the anchor text", async () => {
  const text = 'const seed: string = "fern"; const count: number = 42;';
  const originalHtml = `<body><p>Before</p><pre><code class="language-ts">${text}</code></pre><p>After</p></body>`;
  const colouredHtml = await highlightHtmlCode(originalHtml);
  expect(colouredHtml).toContain("<span style=");
  const b = bridge(colouredHtml);
  try {
    const tokens = [...b.window.document.querySelectorAll("code > span")];
    const start = tokens.find((token) => token.textContent === "const")?.firstChild;
    const end = tokens.find((token) => token.textContent.trim() === "42")?.firstChild;
    if (!start || !end) throw new Error("Missing token text");
    const range = b.window.document.createRange();
    range.setStart(start, 1);
    range.setEnd(end, (end.textContent ?? "").indexOf("42") + 1);
    const quote = text.slice(1, text.indexOf("42") + 1);
    const anchor = b.select(range);
    expect(anchor).toMatchObject({ type: "recense:anchor", quote });
    expect(placeHtmlSpan(docText(originalHtml), { kind: "html-span", path: "doc.html", ...anchor })).toMatchObject({
      status: "placed",
    });
    b.message({ type: "recense:highlight", anchors: [{ threadId: "one", ...anchor }] });
    expect(b.highlights.size).toBe(1);
    expect([...b.highlights.values()][0].range.toString()).toBe(quote);
  } finally {
    vi.restoreAllMocks();
    await b.window.happyDOM.close();
  }
});

test("highlight registry methods are called through their prototype", async () => {
  const b = bridge("<body><p>seed</p></body>");
  const shadow = vi.fn(() => {
    throw new Error("shadowed method");
  });
  b.highlights.set = shadow;
  b.highlights.delete = shadow;
  try {
    b.message({ type: "recense:highlight", anchors: [{ threadId: "one", quote: "seed", prefix: "", suffix: "" }] });
    expect(shadow).not.toHaveBeenCalled();
    expect(b.highlights.size).toBe(1);
  } finally {
    await b.window.happyDOM.close();
  }
});

test("overlong selections post deselect and highlights require unique exact context, including overlaps", async () => {
  const b = bridge(`<body><p>${"x".repeat(2001)}</p><div>aaa red seed blue</div></body>`);
  try {
    const range = b.window.document.createRange();
    const paragraph = b.window.document.querySelector("p");
    if (!paragraph) throw new Error("Missing paragraph");
    range.selectNodeContents(paragraph);
    expect(b.select(range)).toBeUndefined();
    expect(b.post).toHaveBeenLastCalledWith({ type: "recense:deselect" }, "*");
    const before = b.window.document.body.textContent;
    const anchors = [{ threadId: "one", quote: "seed", prefix: "red ", suffix: " blue" }];
    b.message({ type: "recense:highlight", anchors }, null);
    expect(b.highlights.size).toBe(0);
    b.message({ type: "recense:highlight", anchors });
    expect(b.highlights.size).toBe(1);
    expect(b.replaceSync).toHaveBeenCalledWith(expect.stringContaining("::highlight(recense-quotes)"));
    expect(b.window.document.adoptedStyleSheets).toHaveLength(1);
    expect([...b.highlights.values()][0].range.toString()).toBe("seed");
    b.message({ type: "recense:highlight", anchors: [{ threadId: "one", quote: "aa", prefix: "", suffix: "" }] });
    expect(b.highlights.size).toBe(0);
    b.message({
      type: "recense:highlight",
      anchors: [{ threadId: "one", quote: "seed", prefix: "wrong", suffix: "" }],
    });
    expect(b.highlights.size).toBe(0);
    expect(b.window.document.body.textContent).toBe(before);
  } finally {
    await b.window.happyDOM.close();
  }
});

test("without Custom Highlights, no DOM fallback is used and matching quotes still scroll", async () => {
  const b = bridge("<body><p>seed</p></body>", false);
  try {
    const paragraph = b.window.document.querySelector("p");
    if (!paragraph) throw new Error("Missing paragraph");
    const scroll = vi.spyOn(b.window.Element.prototype, "scrollIntoView").mockImplementation(() => {});
    const children = [...b.window.document.body.childNodes];
    b.message({ type: "recense:highlight", anchors: [{ threadId: "one", quote: "seed", prefix: "", suffix: "" }] });
    expect(b.highlights.size).toBe(0);
    b.message({ type: "recense:scroll", threadId: "one" }, null);
    expect(scroll).not.toHaveBeenCalled();
    b.message({ type: "recense:scroll", threadId: "one" });
    expect(scroll).toHaveBeenCalledWith({ block: "center" });
    expect([...b.window.document.body.childNodes]).toEqual(children);
  } finally {
    await b.window.happyDOM.close();
  }
});

test.each([
  "<body><p>  Café &amp; <b>seeds</b></p>\n<p>grow.</p></body>",
  "<body><p>one</p><p>two<br>three</p></body>",
  "<body>\ufeff <b>Cafe</b>\u0301\t\u0085 \u2003seeds\ufeff </body>",
  "<body>한글 <b>\u1100</b>\u1161 🪴 <i>seeds</i></body>",
])("body text and whole-document anchors normalize exactly: %s", async (html) => {
  const b = bridge(html);
  try {
    const range = b.window.document.createRange();
    range.selectNodeContents(b.window.document.body);
    expect(b.select(range)?.quote).toBe(docText(html));
  } finally {
    await b.window.happyDOM.close();
  }
});

const FALLBACK_CSS = "@layer recense-fallback { pre { overflow-x: auto; } }";

test("the bridge inserts a layered layout fallback first in the head", async () => {
  const b = bridge(
    '<!doctype html><html><head><link rel="stylesheet" href="probe.css"><style>pre { color: red; }</style></head><body><p>Seed</p><pre>long line</pre></body></html>',
  );
  try {
    const doc = b.window.document;
    const first = doc.head.firstElementChild;
    expect(first?.localName).toBe("style");
    expect(first?.textContent).toBe(FALLBACK_CSS);
    expect(doc.head.querySelectorAll("style")).toHaveLength(2);
    expect(first?.nextElementSibling?.localName).toBe("link");
    expect([...doc.querySelectorAll("*")].filter((el) => el.textContent === FALLBACK_CSS)).toHaveLength(1);
    expect(doc.body.textContent).toBe("Seedlong line");
    expect(doc.adoptedStyleSheets).toHaveLength(0);
  } finally {
    await b.window.happyDOM.close();
  }
});

test("the layout fallback lands in the parser-created head of a bare fragment", async () => {
  const b = bridge("<p>Seed</p><pre>x</pre>");
  try {
    const head = b.window.document.head;
    expect(head.firstChild?.textContent).toBe(FALLBACK_CSS);
    expect((head.firstChild as unknown as Element).localName).toBe("style");
  } finally {
    await b.window.happyDOM.close();
  }
});

test.each(["pin", "root", "nested", "top"])(
  "diagram placement and removal preserve the %s reading position",
  async (kind) => {
    const html = '<main><pre class="mermaid">graph LR</pre><h2>First</h2><h3>Second</h3><h2>Last</h2></main>';
    const b = layoutBridge(html, { nested: kind === "nested" });
    try {
      if (kind === "pin") b.message({ type: "recense:goto", heading: 0, label: "First", fraction: 0.25 });
      else if (kind !== "top") b.container.scrollTop = 500;
      const before = b.container.scrollTop;
      b.message({ type: "recense:diagram", request: 1, index: 0, svg: "<svg/>", width: 300, height: 200 });
      expect(b.window.document.querySelector("[data-recense-diagram]")).not.toBeNull();
      expect(b.container.scrollTop).toBe(kind === "top" ? 0 : before + 200);
      b.message({ type: "recense:diagram", request: 1, index: 0, svg: null });
      expect(b.container.scrollTop).toBe(before);
    } finally {
      b.restore();
      await b.window.happyDOM.close();
      vi.restoreAllMocks();
    }
  },
);
