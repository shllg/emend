// @vitest-environment node
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { Window } from "happy-dom";
import { expect, test, vi } from "vitest";
import { docText, placeHtmlSpan } from "../../../packages/core/src/place/html.ts";

const corpus: { name: string; old: string; new: string }[] = JSON.parse(
  readFileSync(new URL("../../../packages/core/src/place/corpus/html.json", import.meta.url), "utf8"),
);
function bridge(html: string, customHighlights = true) {
  const window = new Window({
    url: `http://127.0.0.1:3636/content/${"k".repeat(43)}${"a".repeat(32)}/docs/seed.html`,
    settings: { enableJavaScriptEvaluation: false },
  });
  window.document.write(html);
  // Unlike browsers, happy-dom's Node baseURI getter cannot run on a Document.
  const baseURI = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(window.Document.prototype), "baseURI")?.get;
  if (!baseURI) throw new Error("Missing document baseURI getter");
  vi.spyOn(window.Node.prototype, "baseURI", "get").mockImplementation(() => baseURI.call(window.document));
  const post = vi.fn();
  const parent = { postMessage: post };
  Object.defineProperty(window, "parent", { value: parent });
  const source = readFileSync(new URL("../../emend/src/server/content/bridge.ts", import.meta.url), "utf8");
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
    return post.mock.calls.findLast(([data]) => data.type === "emend:anchor")?.[0];
  };
  message({
    type: "emend:docs",
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
        expect(anchor).toEqual({ type: "emend:anchor", quote: expected, prefix: "", suffix: "" });
        expect(placeHtmlSpan(expected, { kind: "html-span", path: "doc.html", ...anchor }).status).toBe("placed");
      } else expect(anchor).toBeUndefined();
      expect(b.post).toHaveBeenCalledWith({ type: "emend:ready" }, "*");
    } finally {
      await b.window.happyDOM.close();
    }
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
    expect(b.post.mock.calls.some(([data]) => data.type === "emend:anchor")).toBe(false);
    vi.advanceTimersByTime(199);
    expect(b.post.mock.calls.some(([data]) => data.type === "emend:anchor")).toBe(false);
    vi.advanceTimersByTime(1);
    const anchors = b.post.mock.calls.filter(([data]) => data.type === "emend:anchor");
    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.[0]).toMatchObject({ quote: "beta", prefix: "Alpha ", suffix: ` gamma${"x".repeat(26)}` });
    const tooLong = b.window.document.createRange();
    tooLong.selectNodeContents(second);
    selection?.removeAllRanges();
    selection?.addRange(tooLong);
    b.window.document.dispatchEvent(new b.window.Event("selectionchange"));
    vi.advanceTimersByTime(300);
    expect(b.post.mock.calls.filter(([data]) => data.type === "emend:anchor")).toHaveLength(1);
  } finally {
    vi.useRealTimers();
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
      expect(b.post).toHaveBeenCalledWith({ type: "emend:navigate", path, fragment }, "*");
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
    expect(b.post.mock.calls.filter(([message]) => message.type === "emend:navigate")).toEqual([]);
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
      type: "emend:anchor",
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
test("highlight registry methods are called through their prototype", async () => {
  const b = bridge("<body><p>seed</p></body>");
  const shadow = vi.fn(() => {
    throw new Error("shadowed method");
  });
  b.highlights.set = shadow;
  b.highlights.delete = shadow;
  try {
    b.message({ type: "emend:highlight", anchors: [{ threadId: "one", quote: "seed", prefix: "", suffix: "" }] });
    expect(shadow).not.toHaveBeenCalled();
    expect(b.highlights.size).toBe(1);
  } finally {
    await b.window.happyDOM.close();
  }
});

test("overlong selections post nothing and highlights require unique exact context, including overlaps", async () => {
  const b = bridge(`<body><p>${"x".repeat(2001)}</p><div>aaa red seed blue</div></body>`);
  try {
    const range = b.window.document.createRange();
    const paragraph = b.window.document.querySelector("p");
    if (!paragraph) throw new Error("Missing paragraph");
    range.selectNodeContents(paragraph);
    expect(b.select(range)).toBeUndefined();
    const before = b.window.document.body.textContent;
    const anchors = [{ threadId: "one", quote: "seed", prefix: "red ", suffix: " blue" }];
    b.message({ type: "emend:highlight", anchors }, null);
    expect(b.highlights.size).toBe(0);
    b.message({ type: "emend:highlight", anchors });
    expect(b.highlights.size).toBe(1);
    expect(b.replaceSync).toHaveBeenCalledWith(expect.stringContaining("::highlight(emend-quotes)"));
    expect(b.window.document.adoptedStyleSheets).toHaveLength(1);
    expect([...b.highlights.values()][0].range.toString()).toBe("seed");
    b.message({ type: "emend:highlight", anchors: [{ threadId: "one", quote: "aa", prefix: "", suffix: "" }] });
    expect(b.highlights.size).toBe(0);
    b.message({ type: "emend:highlight", anchors: [{ threadId: "one", quote: "seed", prefix: "wrong", suffix: "" }] });
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
    b.message({ type: "emend:highlight", anchors: [{ threadId: "one", quote: "seed", prefix: "", suffix: "" }] });
    expect(b.highlights.size).toBe(0);
    b.message({ type: "emend:scroll", threadId: "one" }, null);
    expect(scroll).not.toHaveBeenCalled();
    b.message({ type: "emend:scroll", threadId: "one" });
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

const FALLBACK_CSS = "@layer emend-fallback { pre { overflow-x: auto; } }";

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
