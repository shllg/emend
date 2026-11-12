// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { type DOMRect, type Element, type Node, type Range, Window } from "happy-dom";
import { expect, test, vi } from "vitest";
import { htmlHeadings } from "../../../packages/core/src/doc-headings.ts";
import { cleanDocTitle } from "../../../packages/core/src/doc-title.ts";
import { docLinkCases } from "../../../packages/core/src/links.cases.ts";

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing fixture value");
  return value;
}
function rects(...values: DOMRect[]) {
  return Object.assign(values, { item: (index: number) => required(values[index]) });
}

const prefix = `/content/${"k".repeat(43)}${"a".repeat(32)}/`;
function bridge(html: string, base = "docs/a.html", shadow = false, prepare?: (window: Window) => () => void) {
  const window = new Window({
    url: `http://127.0.0.1:3636${prefix}${base}`,
    settings: {
      enableJavaScriptEvaluation: false,
      disableJavaScriptFileLoading: true,
      handleDisabledFileLoadingAsSuccess: true,
    },
  });
  window.document.write(html);
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 400 });
  const elementPrototype = window.Element.prototype as Element & {
    readonly clientHeight: number;
    readonly clientTop: number;
    readonly assignedSlot: Element | null;
  };
  // Native Element getters omitted or located on HTMLElement in happy-dom.
  for (const name of ["clientHeight", "clientTop"])
    if (!Object.getOwnPropertyDescriptor(window.Element.prototype, name))
      Object.defineProperty(window.Element.prototype, name, {
        ...Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, name),
        configurable: true,
      });
  if (!Object.getOwnPropertyDescriptor(window.Element.prototype, "assignedSlot"))
    Object.defineProperty(window.Element.prototype, "assignedSlot", { configurable: true, get: () => null });
  // Unlike browsers, happy-dom's Node baseURI getter cannot run on a Document.
  const baseURI = required(
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(window.Document.prototype), "baseURI")?.get,
  );
  vi.spyOn(window.Node.prototype, "baseURI", "get").mockImplementation(() => baseURI.call(window.document));
  // happy-dom misses the SVG foreignObject HTML integration point that browsers and parse5 implement.
  for (const foreign of window.document.querySelectorAll("foreignObject")) {
    for (const child of [...foreign.children]) {
      if (child.namespaceURI !== "http://www.w3.org/1999/xhtml" && /^h[23]$/.test(child.localName)) {
        const replacement = window.document.createElement(child.localName);
        replacement.textContent = child.textContent;
        child.replaceWith(replacement);
      }
    }
  }
  const post = vi.fn();
  const parent = { postMessage: post };
  Object.defineProperty(window, "parent", { value: parent });
  const forms = [...window.document.querySelectorAll("form")];
  if (shadow) {
    for (const name of ["getElementById", "createRange", "querySelector", "addEventListener"])
      Object.defineProperty(window.document, name, { value: window.document.createElement("img"), configurable: true });
    for (const element of forms)
      for (const name of ["closest", "getAttribute", "scrollIntoView", "getBoundingClientRect"])
        Object.defineProperty(element, name, { value: window.document.createElement("input"), configurable: true });
  }
  const source = readFileSync(new URL("../../emend/src/server/content/bridge.ts", import.meta.url), "utf8");
  const script = runInNewContext(`${source.replace("export const", "const")}; BRIDGE_SOURCE;`);
  const scroll = vi.spyOn(window.Element.prototype, "scrollIntoView").mockImplementation(() => {});
  const scrollTo = vi.spyOn(window.Element.prototype, "scrollTo").mockImplementation(() => {});
  vi.spyOn(window.Element.prototype, "getClientRects").mockImplementation(() =>
    rects(new window.DOMRect(0, 0, 400, 20)),
  );
  // Visibility/layout is explicit in this harness; happy-dom has no layout engine.
  vi.spyOn(window.Element.prototype, "checkVisibility").mockImplementation(function (this: Element) {
    return window.Element.prototype.getClientRects.call(this).length > 0;
  });
  const highlights = new Map();
  Object.defineProperty(window, "HighlightRegistry", { value: Map });
  const restore = prepare?.(window);
  const run = () =>
    runInNewContext(script, {
      window,
      document: window.document,
      Node: window.Node,
      Range: window.Range,
      Intl,
      CSS: { highlights },
      Highlight: class {
        range: Range;
        constructor(range: Range) {
          this.range = range;
        }
      },
      CSSStyleSheet: window.CSSStyleSheet,
    });
  try {
    run();
  } catch (error) {
    restore?.();
    void window.happyDOM.close();
    throw error;
  }
  window.document.dispatchEvent(new window.Event("DOMContentLoaded"));
  const message = (data: unknown, source: unknown = parent) =>
    window.dispatchEvent(new window.MessageEvent("message", { data, source: source as Window }));
  const close = async () => {
    restore?.();
    for (const element of forms)
      for (const name of ["closest", "getAttribute", "scrollIntoView", "getBoundingClientRect"])
        Reflect.deleteProperty(element, name);
    await window.happyDOM.close();
    vi.restoreAllMocks();
  };
  return { window, elementPrototype, post, scroll, scrollTo, highlights, message, close };
}

test.each(docLinkCases)("C3 bridge resolver matches core: $name", async ({ base, href, docs, expected }) => {
  const b = bridge("<body><a>Link</a><h2 id='part'>Part</h2></body>", base);
  try {
    b.message({ type: "emend:docs", paths: docs });
    const link = b.window.document.querySelector("a");
    if (!link) throw new Error("missing link");
    link.setAttribute("href", href);
    let prevented = false;
    link.addEventListener("click", (event) => {
      prevented = event.defaultPrevented;
      event.preventDefault();
    });
    link.dispatchEvent(new b.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    const sent = b.post.mock.calls.filter(([data]) => data.type === "emend:navigate");
    if (expected && expected.path !== base) {
      expect(sent).toEqual([[{ type: "emend:navigate", path: expected.path, fragment: expected.fragment ?? "" }, "*"]]);
      expect(prevented).toBe(true);
    } else {
      expect(sent).toEqual([]);
      if (expected?.fragment) expect(prevented).toBe(true);
    }
  } finally {
    await b.close();
  }
});

test.each(["#part", "a.html#part"])("C3 same-document %s scrolls without history or location changes", async (href) => {
  const b = bridge(`<body><h2 id="part">Part</h2><a href="${href}">Part</a></body>`);
  try {
    const before = b.window.location.href;
    const length = b.window.history.length;
    b.window.document
      .querySelector("a")
      ?.dispatchEvent(new b.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    expect(b.scroll).toHaveBeenCalledOnce();
    expect(b.window.location.href).toBe(before);
    expect(b.window.history.length).toBe(length);
  } finally {
    await b.close();
  }
});

const corpus: { name: string; old: string; new: string }[] = JSON.parse(
  readFileSync(new URL("../../../packages/core/src/place/corpus/html.json", import.meta.url), "utf8"),
);
const fixtures = [
  ...corpus.flatMap((fixture) => [
    { name: `${fixture.name} old`, html: fixture.old },
    { name: `${fixture.name} new`, html: fixture.new },
  ]),
  ...["../../../sync/", "../../emend/src/server/content/fixtures/"].flatMap((path) =>
    readdirSync(new URL(path, import.meta.url), { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".html"))
      .map((file) => ({ name: file, html: readFileSync(new URL(`${path}${file}`, import.meta.url), "utf8") })),
  ),
  {
    name: "nested skipped subtrees and namespaces",
    html: "<body><h2> A\u200b &amp; B </h2><script><h2>No</h2></script><style><h3>No</h3></style><noscript><h2>No</h2></noscript><template><h2>No</h2></template><svg><text>None</text><foreignObject><h3>HTML inside SVG</h3></foreignObject></svg><h3>Last <b>label</b></h3>",
  },
  { name: "heading text caps", html: `<h2>${"x".repeat(900)}</h2><h3>\u202e\u2066\uFE0F End\t here</h3>` },
  { name: "excess nesting", html: `${"<div>".repeat(512)}<h2>too deep</h2>${"</div>".repeat(512)}` },
  { name: "heading count cap", html: "<h2>Repeated</h2>".repeat(1030) },
];
test.each(fixtures)("C3 bridge/server heading parity: $name", async ({ name, html }) => {
  const b = bridge(html);
  try {
    const headings = htmlHeadings(html);
    const elements = [...b.window.document.querySelectorAll("h2,h3")];
    const capped = name === "heading count cap";
    if (capped) {
      expect(headings).toHaveLength(1024);
      expect(elements).toHaveLength(1030);
    }
    // Each goto measures every heading. Sample this uniform cap fixture's boundaries and
    // midpoint by element; every other fixture still visits all declared headings.
    const indexes = capped ? [0, 512, 1023] : [...headings.keys()];
    for (const [call, heading] of indexes.entries()) {
      const value = required(headings[heading]);
      b.message({ type: "emend:goto", heading, label: value.text });
      expect(b.scroll).toHaveBeenCalledTimes(call + 1);
      if (capped) expect(b.scroll.mock.instances[call]).toBe(required(elements[heading]));
    }
    const candidateLabels = new Set(["", ...elements.map((element) => cleanDocTitle(element.textContent))]);
    for (const label of candidateLabels) b.message({ type: "emend:goto", heading: headings.length, label });
    expect(b.scroll).toHaveBeenCalledTimes(indexes.length);
    if (capped) expect(b.scroll.mock.instances).not.toContain(required(elements[1024]));
    b.message({ type: "emend:goto", heading: 0, label: "wrong label" });
    expect(b.scroll).toHaveBeenCalledTimes(indexes.length);
  } finally {
    await b.close();
  }
});

test("C3 goto is parent-only, rejects invalid offsets and survives named DOM-method shadows", async () => {
  const b = bridge(
    '<body><img name="getElementById"><form name="querySelector"><h2 id="part">Part</h2><a href="#part">Link</a></form>',
    "docs/a.html",
    true,
  );
  try {
    const goto = { type: "emend:goto", heading: 0, label: "Part" };
    b.message(goto, null);
    for (const fraction of [-1, 2, NaN, Infinity]) b.message({ ...goto, fraction });
    expect(b.scroll).not.toHaveBeenCalled();
    b.message(goto);
    expect(b.scroll).toHaveBeenCalledOnce();
    b.scroll.mockClear();
    const link = b.window.Document.prototype.querySelector.call(b.window.document, "a");
    link?.dispatchEvent(new b.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    expect(b.scroll).toHaveBeenCalledOnce();
  } finally {
    await b.close();
  }
});

test("C3 position uses a heading index and section fraction, and throttles scroll messages", async () => {
  const b = bridge("<body><h2>First</h2><h3>Second</h3><h2>Third</h2></body>");
  try {
    let offset = 250;
    const headings = [...b.window.document.querySelectorAll("h2,h3")];
    vi.spyOn(b.window.Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return new b.window.DOMRect(0, headings.indexOf(this) * 200 - offset, 400, 20);
    });
    b.post.mockClear();
    for (let i = 0; i < 10; i++) b.window.dispatchEvent(new b.window.Event("scroll"));
    await b.window.happyDOM.waitUntilComplete();
    expect(b.post.mock.calls.filter(([data]) => data.type === "emend:position")).toEqual([
      [{ type: "emend:position", heading: 1, fraction: 0.75 }, "*"],
    ]);
    offset = 100;
    b.window.dispatchEvent(new b.window.Event("scroll"));
    await b.window.happyDOM.waitUntilComplete();
    expect(b.post).toHaveBeenLastCalledWith({ type: "emend:position", heading: 1, fraction: 0 }, "*");
  } finally {
    await b.close();
  }
});

function click(b: ReturnType<typeof bridge>, element: Element) {
  const event = new b.window.MouseEvent("click", { bubbles: true, composed: true, cancelable: true, button: 0 });
  element.dispatchEvent(event);
  return event;
}

test.each([true, false])(
  "R1.1 bridge ignores shadowed properties with a form scroller (checkVisibility=%s)",
  async (visibility) => {
    const touched = vi.fn();
    let restore = () => {};
    let heading: Element | undefined;
    let text: Node | undefined;
    let formOffset = 0;
    const b = bridge(
      '<body><form style="height:400px;overflow-y:auto"><h2 id="part">Part</h2><p>seed</p><h3>Next</h3><a href="#part">Link</a></form><template><h2>Skip</h2></template>',
      "docs/a.html",
      false,
      (window) => {
        const doc = window.document;
        const form = required(doc.querySelector("form"));
        heading = required(doc.querySelector("h2"));
        text = required(required(doc.querySelector("p")).firstChild);
        const root = doc.documentElement;
        const template = required(doc.querySelector("template"));
        const next = required(doc.querySelector("h3"));
        const visibilityMethod = window.Element.prototype.checkVisibility;
        if (!visibility)
          Object.defineProperty(window.Element.prototype, "checkVisibility", { configurable: true, value: undefined });
        vi.spyOn(window.Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
          formOffset = this === next ? 900 : 300;
        });
        vi.spyOn(window.Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
          return new window.DOMRect(0, (this === next ? 900 : 300) - formOffset, 400, 20);
        });
        vi.spyOn(window.Element.prototype, "scrollTop", "get").mockImplementation(function (this: Element) {
          return this === form ? formOffset : 0;
        });
        vi.spyOn(window.Element.prototype, "scrollTo").mockImplementation(function (
          this: Element,
          options: number | ScrollToOptions | undefined,
        ) {
          if (this === form && typeof options === "object" && options.behavior === "instant")
            formOffset = options.top ?? 0;
        });
        // Emulate native getters: happy-dom implements these by reading shadowable instance properties.
        vi.spyOn(window.Document.prototype, "body", "get").mockReturnValue(doc.body);
        vi.spyOn(window.Document.prototype, "scrollingElement", "get").mockReturnValue(root);
        Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
        // Native Range boundary validation reads internal text data, not an instance getter.
        for (const method of ["setStart", "setEnd"] as const) {
          const native = window.Range.prototype[method];
          vi.spyOn(window.Range.prototype, method).mockImplementation(function (this: Range, node: Node, offset = 0) {
            const own = Object.getOwnPropertyDescriptor(node, "data");
            if (own) Reflect.deleteProperty(node, "data");
            try {
              return native.call(this, node, offset);
            } finally {
              if (own) Object.defineProperty(node, "data", own);
            }
          });
        }
        const shadows: [object, string][] = [
          ...[doc, form, root, heading, next].flatMap((node) =>
            [
              "checkVisibility",
              "getClientRects",
              "getBoundingClientRect",
              "assignedSlot",
              "scrollTop",
              "scrollHeight",
              "scrollTo",
              "scrollIntoView",
            ].map((name) => [node, name] as [object, string]),
          ),
          ...["body", "documentElement", "scrollingElement", "readyState", "adoptedStyleSheets", "baseURI"].map(
            (name) => [doc, name] as [object, string],
          ),
          ...[
            "nodeType",
            "parentNode",
            "parentElement",
            "localName",
            "namespaceURI",
            "childNodes",
            "scrollTop",
            "scrollHeight",
          ].map((name) => [form, name] as [object, string]),
          [root, "scrollTop"],
          [root, "scrollHeight"],
          [template, "content"],
          [text, "data"],
        ];
        const poison = doc.createElement("input");
        for (const [node, name] of shadows)
          Object.defineProperty(node, name, {
            configurable: true,
            get: () => {
              touched(name);
              return poison;
            },
            set: () => touched(name),
          });
        restore = () => {
          Object.defineProperty(window.Element.prototype, "checkVisibility", {
            configurable: true,
            writable: true,
            value: visibilityMethod,
          });
          for (const [node, name] of shadows) Reflect.deleteProperty(node, name);
        };
        return restore;
      },
    );
    try {
      b.message({ type: "emend:goto", heading: 0, label: "Part" });
      b.message({ type: "emend:goto", heading: 1, label: "Next" });
      expect(b.scroll).toHaveBeenCalledTimes(2);
      b.message({ type: "emend:goto", heading: 2, label: "Skip" });
      expect(b.scroll).toHaveBeenCalledTimes(2);
      b.message({ type: "emend:goto", heading: 0, label: "Part", fraction: 0.5 });
      expect(formOffset).toBe(500);
      await resumeMeasurement(b);
      await b.window.happyDOM.waitUntilComplete();
      expect(b.post).toHaveBeenLastCalledWith({ type: "emend:position", heading: 0, fraction: 0.5 }, "*");
      b.message({ type: "emend:highlight", anchors: [{ threadId: "one", quote: "seed", prefix: "", suffix: "" }] });
      expect(b.highlights.size).toBe(1);
      b.scroll.mockClear();
      b.message({ type: "emend:scroll", threadId: "one" });
      expect(b.scroll).toHaveBeenCalledOnce();
      // Prepare a native selection without asking the DOM emulator to interpret the shadowed properties.
      restore();
      const range = b.window.document.createRange();
      range.selectNodeContents(required(text));
      b.window.getSelection()?.addRange(range);
      Object.defineProperty(b.window.document, "body", {
        configurable: true,
        get: () => {
          touched("body");
          return null;
        },
      });
      b.window.document.dispatchEvent(new b.window.Event("mouseup"));
      expect(b.post.mock.calls.findLast(([data]) => data.type === "emend:anchor")?.[0].quote).toBe("seed");
      const before = { href: b.window.location.href, length: b.window.history.length };
      Object.defineProperty(b.window.document, "baseURI", {
        configurable: true,
        get: () => {
          touched("baseURI");
          return null;
        },
      });
      expect(
        click(b, required(b.window.Document.prototype.querySelector.call(b.window.document, "a"))).defaultPrevented,
      ).toBe(true);
      expect(b.scroll.mock.instances.at(-1)).toBe(required(heading));
      expect({ href: b.window.location.href, length: b.window.history.length }).toEqual(before);
      b.window.dispatchEvent(new b.window.Event("scroll"));
      await b.window.happyDOM.waitUntilComplete();
      expect(b.post.mock.calls.some(([data]) => data.type === "emend:position")).toBe(true);
      expect(touched).not.toHaveBeenCalled();
    } finally {
      await b.close();
    }
  },
);

const FALLBACK_CSS = "@layer emend-fallback { pre { overflow-x: auto; } }";

test("the layout fallback ignores shadowed document properties", async () => {
  const touched = vi.fn();
  let restore = () => {};
  const b = bridge("<body><p>Seed</p><pre>x</pre></body>", "docs/a.html", false, (window) => {
    const doc = window.document;
    const root = doc.documentElement;
    const head = required(doc.head);
    // Emulate the native getter: happy-dom reads the shadowable documentElement instead.
    vi.spyOn(window.Document.prototype, "body", "get").mockReturnValue(doc.body);
    const poison = doc.createElement("input");
    const shadows: [object, string][] = [
      ...["createElement", "documentElement", "head"].map((name) => [doc, name] as [object, string]),
      ...[root, head].flatMap((node) =>
        ["firstElementChild", "firstChild", "insertBefore", "localName"].map(
          (name) => [node, name] as [object, string],
        ),
      ),
    ];
    for (const [node, name] of shadows)
      Object.defineProperty(node, name, {
        configurable: true,
        get: () => {
          touched(name);
          return poison;
        },
        set: () => touched(name),
      });
    restore = () => {
      for (const [node, name] of shadows) Reflect.deleteProperty(node, name);
    };
    return restore;
  });
  try {
    restore();
    const head = required(b.window.document.documentElement.firstElementChild);
    expect(head.localName).toBe("head");
    const style = required(head.firstElementChild);
    expect(style.localName).toBe("style");
    expect(style.textContent).toBe(FALLBACK_CSS);
    expect(
      [...b.window.document.querySelectorAll("*")].filter(
        (el) => el.localName === "style" && el.textContent === FALLBACK_CSS,
      ),
    ).toHaveLength(1);
    expect(touched).not.toHaveBeenCalled();
    expect(b.post).toHaveBeenCalledWith({ type: "emend:ready" }, "*");
  } finally {
    await b.close();
  }
});

test("a failing layout fallback leaves the bridge working", async () => {
  let text: Node | undefined;
  const b = bridge("<body><p>Seed</p><pre>x</pre></body>", "docs/a.html", false, (window) => {
    text = required(required(window.document.querySelector("p")).firstChild);
    const spy = vi.spyOn(window.Node.prototype, "insertBefore").mockImplementation(() => {
      throw new Error("blocked");
    });
    return () => spy.mockRestore();
  });
  try {
    // The bridge has run; let the document accept inserts again.
    vi.mocked(b.window.Node.prototype.insertBefore).mockRestore();
    expect(
      [...b.window.document.querySelectorAll("*")].filter(
        (el) => el.localName === "style" && el.textContent === FALLBACK_CSS,
      ),
    ).toHaveLength(0);
    expect(b.post).toHaveBeenCalledWith({ type: "emend:ready" }, "*");
    const range = b.window.document.createRange();
    range.selectNodeContents(required(text));
    b.window.getSelection()?.addRange(range);
    b.window.document.dispatchEvent(new b.window.Event("mouseup"));
    expect(b.post.mock.calls.findLast(([data]) => data.type === "emend:anchor")?.[0].quote).toBe("Seed");
  } finally {
    await b.close();
  }
});

test.each(["#", "a.html", "a.html#"])("R1.2 same-document top link %s has no history", async (href) => {
  const b = bridge(`<body><a href="${href}">Top</a></body>`);
  try {
    const before = { href: b.window.location.href, length: b.window.history.length };
    expect(click(b, required(b.window.document.querySelector("a"))).defaultPrevented).toBe(true);
    expect(b.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 0, behavior: "instant" });
    expect({ href: b.window.location.href, length: b.window.history.length }).toEqual(before);
  } finally {
    await b.close();
  }
});

test.each(["legacy", "missing"])("R1.2 fragment %s uses the first named anchor or stays put", async (name) => {
  const b = bridge(`<body><a name="legacy">First</a><a name="legacy">Second</a><a href="#${name}">Link</a></body>`);
  try {
    const before = { href: b.window.location.href, length: b.window.history.length };
    expect(click(b, required(b.window.document.querySelector("a[href]"))).defaultPrevented).toBe(true);
    if (name === "legacy") expect(b.scroll.mock.instances).toEqual([b.window.document.querySelector("a[name]")]);
    else expect(b.scroll).not.toHaveBeenCalled();
    expect({ href: b.window.location.href, length: b.window.history.length }).toEqual(before);
  } finally {
    await b.close();
  }
});

test.each(["area", "svg href", "svg xlink", "shadow"])(
  "R1.2 %s links handle fragments and cross-doc navigation",
  async (kind) => {
    const b = bridge('<body><h2 id="part">Part</h2><div id="host"></div></body>');
    try {
      const doc = b.window.document;
      const svg = kind.startsWith("svg");
      const link = svg
        ? doc.createElementNS("http://www.w3.org/2000/svg", "a")
        : doc.createElement(kind === "area" ? "area" : "a");
      const parent = kind === "shadow" ? required(doc.querySelector("#host")).attachShadow({ mode: "open" }) : doc.body;
      parent.appendChild(link);
      const href = (value: string) =>
        kind === "svg xlink"
          ? link.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", value)
          : link.setAttribute("href", value);
      const before = { href: b.window.location.href, length: b.window.history.length };
      href("#part");
      expect(click(b, link).defaultPrevented).toBe(true);
      expect(b.scroll.mock.instances).toEqual([doc.querySelector("h2")]);
      href("other.html#part");
      b.message({ type: "emend:docs", paths: ["docs/other.html"] });
      expect(click(b, link).defaultPrevented).toBe(true);
      expect(b.post).toHaveBeenCalledWith({ type: "emend:navigate", path: "docs/other.html", fragment: "part" }, "*");
      expect({ href: b.window.location.href, length: b.window.history.length }).toEqual(before);
    } finally {
      await b.close();
    }
  },
);

test.each(["link", "goto"])("R1.2 %s opens all ancestor details before scrolling", async (kind) => {
  const b = bridge(
    '<body><a href="#part">Link</a><details><summary>Outer</summary><details><summary>Inner</summary><h2 id="part">Part</h2></details></details></body>',
  );
  try {
    const before = { href: b.window.location.href, length: b.window.history.length };
    if (kind === "link") expect(click(b, required(b.window.document.querySelector("a"))).defaultPrevented).toBe(true);
    else b.message({ type: "emend:goto", heading: 0, label: "Part" });
    expect([...b.window.document.querySelectorAll("details")].every((node) => node.open)).toBe(true);
    expect({ href: b.window.location.href, length: b.window.history.length }).toEqual(before);
  } finally {
    await b.close();
  }
});

test("R1.2 a local shadow-root fragment opens details across its host", async () => {
  const b = bridge('<body><details><summary>Outer</summary><div id="host"></div></details></body>');
  try {
    const root = required(b.window.document.querySelector("#host")).attachShadow({ mode: "open" });
    const detail = b.window.document.createElement("details");
    const target = b.window.document.createElement("p");
    target.id = "part";
    detail.appendChild(target);
    root.appendChild(detail);
    const link = b.window.document.createElement("a");
    link.href = "#part";
    root.appendChild(link);
    const before = { href: b.window.location.href, length: b.window.history.length };
    expect(click(b, link).defaultPrevented).toBe(true);
    expect(detail.open).toBe(true);
    expect(required(b.window.document.querySelector("details")).open).toBe(true);
    expect(b.scroll.mock.instances).toEqual([target]);
    expect({ href: b.window.location.href, length: b.window.history.length }).toEqual(before);
  } finally {
    await b.close();
  }
});

test("R2.2 document restore uses instant heading and fractional scrolling despite smooth CSS", async () => {
  const b = bridge("<style>html { scroll-behavior: smooth }</style><h2>First</h2><h3>Second</h3>");
  try {
    const headings = [...b.window.document.querySelectorAll("h2,h3")];
    const root = b.window.document.scrollingElement;
    root.scrollTop = 125;
    vi.spyOn(b.window.Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return new b.window.DOMRect(0, (this === headings[0] ? 425 : 825) - root.scrollTop, 400, 20);
    });
    b.scroll.mockImplementation((options) => {
      if (typeof options === "object" && options.behavior === "instant") root.scrollTop = 425;
    });
    b.scrollTo.mockImplementation(function (this: Element, options: number | ScrollToOptions | undefined) {
      if (typeof options === "object" && options.behavior === "instant") this.scrollTop = options.top ?? 0;
    });
    b.message({ type: "emend:goto", heading: 0, label: "First", fraction: 0.5 });
    expect(b.scroll).toHaveBeenCalledExactlyOnceWith({ block: "start", behavior: "instant" });
    expect(b.scrollTo).toHaveBeenLastCalledWith({ top: 525, behavior: "instant" });
    expect(b.scrollTo.mock.instances.at(-1)).toBe(root);
    expect(b.window.document.body.scrollTop).toBe(0);
    expect(root.scrollTop).toBe(525);
    await resumeMeasurement(b);
    await b.window.happyDOM.waitUntilComplete();
    expect(b.post).toHaveBeenLastCalledWith({ type: "emend:position", heading: 0, fraction: 0.5 }, "*");
  } finally {
    await b.close();
  }
});

test.each(["introduction", "hidden headings"])("R1.3 position skips %s", async (kind) => {
  const b = bridge(
    '<body><h2>First</h2><details><summary>Folded</summary><h3>Hidden</h3></details><h2 style="display:none">Also hidden</h2><h2>Last</h2></body>',
  );
  try {
    const headings = [...b.window.document.querySelectorAll("h2,h3")];
    vi.spyOn(b.window.Element.prototype, "getClientRects").mockImplementation(function (this: Element) {
      return this === headings[1] || this === headings[2] ? rects() : rects(new b.window.DOMRect(0, 0, 400, 20));
    });
    vi.spyOn(b.window.Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return new b.window.DOMRect(
        0,
        this === headings[0] ? (kind === "introduction" ? 300 : -100) : this === headings[3] ? 300 : 0,
        400,
        20,
      );
    });
    b.window.dispatchEvent(new b.window.Event("scroll"));
    await b.window.happyDOM.waitUntilComplete();
    expect(b.post).toHaveBeenLastCalledWith(
      kind === "introduction"
        ? { type: "emend:position", heading: null, fraction: 0 }
        : { type: "emend:position", heading: 0, fraction: 0.5 },
      "*",
    );
  } finally {
    await b.close();
  }
});

test.each(["#%2F", "#%zz", "#a\\b", " #t1", "#t&#10;1", ""])(
  "R2.1 refused same-document href %j never reaches the browser",
  async (href) => {
    const b = bridge(`<body><a href="${href}">Link</a><h2 id="t1">Target</h2></body>`);
    try {
      const before = { href: b.window.location.href, length: b.window.history.length };
      expect(click(b, required(b.window.document.querySelector("a"))).defaultPrevented).toBe(true);
      expect(b.scroll).not.toHaveBeenCalled();
      if (href === "") expect(b.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 0, behavior: "instant" });
      else expect(b.scrollTo).not.toHaveBeenCalled();
      expect({ href: b.window.location.href, length: b.window.history.length }).toEqual(before);
    } finally {
      await b.close();
    }
  },
);

function nestedScroller() {
  const b = bridge(`<style>
    html, body { height: 100%; overflow: hidden; scroll-behavior: smooth }
    main { height: 400px; overflow-y: auto; scroll-behavior: smooth }
    </style><body><main><h2>First</h2><h3>Second</h3><h2>Third</h2></main></body>`);
  const container = required(b.window.document.querySelector("main"));
  const headings = [...b.window.document.querySelectorAll("h2,h3")];
  const offsets = [300, 900, 1400];
  // Layout is mocked, including a container inset from the viewport with a 3px border.
  vi.spyOn(b.elementPrototype, "clientHeight", "get").mockImplementation(function (this: Element) {
    return this === container ? 400 : 900;
  });
  vi.spyOn(b.elementPrototype, "clientTop", "get").mockImplementation(function (this: Element) {
    return this === container ? 3 : 0;
  });
  vi.spyOn(b.window.Element.prototype, "scrollHeight", "get").mockImplementation(function (this: Element) {
    return this === container ? 2400 : 900;
  });
  vi.spyOn(b.window.Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return new b.window.DOMRect(
      0,
      this === container ? 40 : required(offsets[headings.indexOf(this)]) - container.scrollTop + 43,
      400,
      20,
    );
  });
  b.scroll.mockImplementation(function (this: Element, options) {
    if (typeof options === "object" && options.behavior === "instant")
      container.scrollTop = required(offsets[headings.indexOf(this)]);
  });
  b.scrollTo.mockImplementation(function (this: Element, options: number | ScrollToOptions | undefined) {
    if (typeof options === "object" && options.behavior === "instant") this.scrollTop = options.top ?? 0;
  });
  return { ...b, container, headings };
}

test.each([
  { name: "pick", heading: 0, label: "First", fraction: undefined, offset: 300 },
  { name: "fractional restore", heading: 0, label: "First", fraction: 0.5, offset: 543 },
  // Last-section distance now ends at the document's viewport-relative end (900), not the box's end.
  {
    name: "bounded last-section restore",
    heading: 2,
    label: "Third",
    fraction: 0.4,
    // The isolated box changes its span; check the measured fraction rather than one exact landing.
    offset: undefined,
  },
])("R2.2 nested-scroller $name lands instantly despite smooth CSS", async ({ heading, label, fraction, offset }) => {
  const b = nestedScroller();
  try {
    b.message({ type: "emend:goto", heading, label, fraction });
    if (offset !== undefined) expect(b.container.scrollTop).toBeCloseTo(offset);
    expect(b.window.document.scrollingElement.scrollTop).toBe(0);
    expect(b.window.document.body.scrollTop).toBe(0);
    expect(b.scroll.mock.instances).toEqual([b.headings[heading]]);
    expect(b.scroll).toHaveBeenCalledExactlyOnceWith({ block: "start", behavior: "instant" });
    if (fraction) {
      for (const [options] of b.scrollTo.mock.calls) expect(options).toMatchObject({ behavior: "instant" });
      const moves = b.scrollTo.mock.instances.filter((container) => container === b.container).length;
      if (heading === 0) expect(moves).toBe(1);
      else {
        expect(moves).toBeGreaterThan(0);
        expect(moves).toBeLessThanOrEqual(8);
      }
    } else expect(b.scrollTo).not.toHaveBeenCalled();
    await resumeMeasurement(b);
    await b.window.happyDOM.waitUntilComplete();
    const position = b.post.mock.calls.findLast(([data]) => data.type === "emend:position")?.[0];
    // This inset container starts 43px below the frame's top. Picks retain that inset.
    const top = (heading === 0 ? 300 : 1400) - b.container.scrollTop + 43;
    expect(position?.heading).toBe(heading);
    expect(position?.fraction).toBeCloseTo((100 - top) / (heading === 0 ? 600 : 900 - top));
    if (fraction !== undefined) expect(Math.abs((position?.fraction ?? 9) - fraction)).toBeLessThanOrEqual(0.002);
  } finally {
    await b.close();
  }
});

test("R2.2 a non-bubbling nested scroll reports position relative to the frame viewport", async () => {
  const b = nestedScroller();
  try {
    await b.window.happyDOM.waitUntilComplete();
    b.post.mockClear();
    b.container.scrollTop = 600;
    b.container.dispatchEvent(new b.window.Event("scroll"));
    await b.window.happyDOM.waitUntilComplete();
    expect(b.post).toHaveBeenCalledExactlyOnceWith({ type: "emend:position", heading: 0, fraction: 357 / 600 }, "*");
  } finally {
    await b.close();
  }
});

test.each(["link", "goto"])("R2.3 %s opens closed details through the heading's prototype-read slot", async (kind) => {
  const b = bridge('<body><a href="#part">Link</a><div id="host"><h2 id="part">Part</h2></div></body>');
  try {
    const doc = b.window.document;
    const heading = required(doc.querySelector("h2"));
    const root = required(doc.querySelector("#host")).attachShadow({ mode: "open" });
    const details = doc.createElement("details");
    const slot = doc.createElement("slot");
    details.appendChild(slot);
    root.appendChild(details);
    // happy-dom does not implement assignedSlot; model the native getter, with a hostile own getter.
    const assigned = vi.fn(function (this: Element) {
      return this === heading ? slot : null;
    });
    vi.spyOn(b.elementPrototype, "assignedSlot", "get").mockImplementation(assigned);
    const poison = vi.fn(() => null);
    Object.defineProperty(heading, "assignedSlot", { configurable: true, get: poison });
    vi.spyOn(b.window.Element.prototype, "getClientRects").mockImplementation(function (this: Element) {
      return this === heading && !details.open ? rects() : rects(new b.window.DOMRect(0, 0, 400, 20));
    });
    const before = { href: b.window.location.href, length: b.window.history.length };
    if (kind === "link") expect(click(b, required(doc.querySelector("a"))).defaultPrevented).toBe(true);
    else b.message({ type: "emend:goto", heading: 0, label: "Part" });
    expect(details.open).toBe(true);
    expect(b.scroll.mock.instances).toEqual([heading]);
    expect(poison).not.toHaveBeenCalled();
    expect({ href: b.window.location.href, length: b.window.history.length }).toEqual(before);
  } finally {
    await b.close();
  }
});

test.each([
  { winner: "document id", loser: "shadow id" },
  { winner: "document id", loser: "named anchor" },
  { winner: "shadow id", loser: "named anchor" },
])("R2.5 fragment precedence: $winner beats $loser", async ({ winner, loser }) => {
  const b = bridge('<body><div id="host"></div></body>');
  try {
    const doc = b.window.document;
    const root = required(doc.querySelector("#host")).attachShadow({ mode: "open" });
    const fragment = 'part["exact"]';
    const target = (kind: string) => {
      const element = doc.createElement(kind === "named anchor" ? "a" : "p");
      element.setAttribute(kind === "named anchor" ? "name" : "id", fragment);
      (kind === "shadow id" ? root : doc.body).appendChild(element);
      return element;
    };
    target(loser);
    const expected = target(winner);
    const link = doc.createElement("a");
    link.setAttribute("href", `#${encodeURIComponent(fragment)}`);
    root.appendChild(link);
    expect(click(b, link).defaultPrevented).toBe(true);
    expect(b.scroll).toHaveBeenCalledOnce();
    expect(b.scroll.mock.instances[0]).toBe(expected);
  } finally {
    await b.close();
  }
});

function clockedBridge(html: string) {
  vi.useFakeTimers();
  const b = bridge(html, "docs/a.html", false, (window) => {
    Object.assign(window, { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
    return () => {};
  });
  return {
    ...b,
    close: async () => {
      vi.clearAllTimers();
      vi.useRealTimers();
      await b.close();
    },
  };
}

function viewportBody(overflow = true) {
  const b = clockedBridge(
    `${overflow ? "<style>html,body{height:100%}body{overflow-x:hidden;overflow-y:auto}</style>" : ""}<body><h2>First</h2><h3>Second</h3><h2>Third</h2></body>`,
  );
  const root = b.window.document.documentElement;
  const body = b.window.document.body;
  const headings = [...body.querySelectorAll("h2,h3")];
  const offsets = [300, 900, 1500];
  vi.spyOn(b.elementPrototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(b.elementPrototype, "scrollHeight", "get").mockReturnValue(2400);
  vi.spyOn(b.elementPrototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return new b.window.DOMRect(0, (offsets[headings.indexOf(this)] ?? 0) - root.scrollTop, 400, 20);
  });
  b.scroll.mockImplementation(function (this: Element) {
    root.scrollTop = required(offsets[headings.indexOf(this)]);
  });
  b.scrollTo.mockImplementation(function (this: Element, options: number | ScrollToOptions | undefined) {
    if (typeof options === "object" && options.behavior === "instant") this.scrollTop = options.top ?? 0;
  });
  return { ...b, root, body };
}

test.each(["report", "restore"])("R3 viewport-scrolling body with overflow-x hidden: %s", async (action) => {
  const b = viewportBody();
  try {
    b.root.scrollTop = 1100;
    b.body.scrollTop = 17;
    if (action === "restore") {
      b.message({ type: "emend:goto", heading: 1, label: "Second", fraction: 0.5 });
      expect(b.root.scrollTop).toBe(1100);
      await resumeMeasurement(b);
      expect(b.body.scrollTop).toBe(17); // An ineffective ancestor must be put back.
    }
    vi.advanceTimersByTime(200);
    const position = b.post.mock.calls.findLast(([data]) => data.type === "emend:position")?.[0];
    expect(position?.heading).toBe(1);
    expect(position?.fraction).toBeCloseTo(0.5);
  } finally {
    await b.close();
  }
});

test("R3 a nested scroller below the introduction stays in the introduction on opening and reload", async () => {
  for (const visit of ["opening", "reload"]) {
    const b = nestedScroller();
    try {
      vi.spyOn(b.elementPrototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
        return new b.window.DOMRect(0, this === b.container ? 1200 : 1203 + b.headings.indexOf(this) * 600, 400, 20);
      });
      await b.window.happyDOM.waitUntilComplete();
      expect(b.post.mock.calls.findLast(([data]) => data.type === "emend:position")?.[0], visit).toEqual({
        type: "emend:position",
        heading: null,
        fraction: 0,
      });
      expect(b.window.scrollY, visit).toBe(0);
      expect(b.container.scrollTop, visit).toBe(0);
      expect(b.scroll, visit).not.toHaveBeenCalled();
    } finally {
      await b.close();
    }
  }
});

function shadowScroller() {
  const b = clockedBridge('<body><div id="host"><h2>First</h2><h3>Next</h3></div></body>');
  const host = required(b.window.document.querySelector("#host"));
  const root = host.attachShadow({ mode: "open" });
  const container = b.window.document.createElement("main");
  const slot = b.window.document.createElement("slot");
  container.appendChild(slot);
  root.appendChild(container);
  const headings = [...host.querySelectorAll("h2,h3")];
  vi.spyOn(b.elementPrototype, "assignedSlot", "get").mockImplementation(function (this: Element) {
    return headings.includes(this) ? slot : null;
  });
  const bounds = vi.spyOn(b.elementPrototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return new b.window.DOMRect(0, headings.indexOf(this) * 600 + 300 - container.scrollTop, 400, 20);
  });
  const documentScroll = vi.fn();
  b.window.document.addEventListener("scroll", documentScroll, true);
  vi.advanceTimersByTime(400);
  b.post.mockClear();
  return { ...b, container, bounds, documentScroll };
}

test.each(["wheel", "touchmove", "touchend", "keydown", "pointerup"])(
  "R3 composed %s reports a scroll inside an open shadow root",
  async (input) => {
    const b = shadowScroller();
    try {
      b.container.dispatchEvent(new b.window.Event(input, { bubbles: true, composed: true }));
      vi.advanceTimersByTime(100);
      b.container.scrollTop = 600;
      b.container.dispatchEvent(new b.window.Event("scroll"));
      expect(b.documentScroll).not.toHaveBeenCalled();
      vi.advanceTimersByTime(100);
      expect(b.post).toHaveBeenLastCalledWith({ type: "emend:position", heading: 0, fraction: 2 / 3 }, "*");
    } finally {
      await b.close();
    }
  },
);

test("R3 shadow momentum is sampled until a trailing stable check, including motion within the introduction", async () => {
  const b = shadowScroller();
  try {
    b.container.dispatchEvent(new b.window.Event("wheel", { bubbles: true, composed: true }));
    b.container.scrollTop = 100;
    vi.advanceTimersByTime(200);
    // Motion within the introduction is not a change of position, so nothing is posted.
    expect(b.post).not.toHaveBeenCalled();
    b.container.scrollTop = 200;
    vi.advanceTimersByTime(200);
    b.container.scrollTop = 600;
    vi.advanceTimersByTime(200);
    expect(b.post).toHaveBeenLastCalledWith({ type: "emend:position", heading: 0, fraction: 2 / 3 }, "*");
    b.bounds.mockClear();
    vi.advanceTimersByTime(200);
    expect(b.bounds).toHaveBeenCalledTimes(2);
    b.bounds.mockClear();
    vi.advanceTimersByTime(2000);
    expect(b.bounds).not.toHaveBeenCalled();
  } finally {
    await b.close();
  }
});

test("R3 checkVisibility excludes a closed-details heading even when it has client rects", async () => {
  const b = clockedBridge("<h2>Visible</h2><details><summary>Closed</summary><h3>Hidden</h3></details><h2>Next</h2>");
  try {
    const headings = [...b.window.document.querySelectorAll("h2,h3")];
    vi.spyOn(b.elementPrototype, "checkVisibility").mockImplementation(function (this: Element) {
      return this !== headings[1];
    });
    vi.spyOn(b.elementPrototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return new b.window.DOMRect(0, required([-100, -36, 300][headings.indexOf(this)]), 400, 20);
    });
    expect(required(headings[1]).getClientRects().length).toBe(1);
    vi.advanceTimersByTime(200);
    expect(b.post).toHaveBeenLastCalledWith({ type: "emend:position", heading: 0, fraction: 0.5 }, "*");
  } finally {
    await b.close();
  }
});

test("R3 one report reads each of 1000 heading rects once without walking ancestors or reading styles", async () => {
  const b = clockedBridge(`${"<div>".repeat(10)}${"<h2>Heading</h2>".repeat(1000)}${"</div>".repeat(10)}`);
  try {
    const headings: Element[] = [...b.window.document.querySelectorAll("h2")];
    const bounds = vi.spyOn(b.elementPrototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return new b.window.DOMRect(0, headings.indexOf(this) * 40 - 200, 400, 20);
    });
    const height = vi.fn(() => 400);
    Object.defineProperty(b.window, "innerHeight", { configurable: true, get: height });
    const styles = vi.spyOn(b.window, "getComputedStyle");
    const parents = vi.spyOn(b.window.Node.prototype, "parentNode", "get");
    vi.advanceTimersByTime(200);
    expect(height).toHaveBeenCalledOnce();
    expect(bounds).toHaveBeenCalledTimes(1000);
    expect(new Set(bounds.mock.instances).size).toBe(1000);
    expect(styles).not.toHaveBeenCalled();
    expect(parents).not.toHaveBeenCalled();
    expect(b.post).toHaveBeenLastCalledWith({ type: "emend:position", heading: 7, fraction: 0.5 }, "*");
  } finally {
    await b.close();
  }
});

function readingLineLayout(kind: string) {
  if (kind === "inset") {
    const b = nestedScroller();
    return { ...b, scroller: b.container, settle: () => b.window.happyDOM.waitUntilComplete() };
  }
  const b = viewportBody(kind === "body");
  return {
    ...b,
    scroller: b.root,
    settle: async () => {
      vi.advanceTimersByTime(400);
    },
  };
}

test("R4 an inset Contents pick reports its heading at the reading line", async () => {
  const b = nestedScroller();
  try {
    b.message({ type: "emend:goto", heading: 0, label: "First" });
    await b.window.happyDOM.waitUntilComplete();
    expect(b.container.scrollTop).toBe(300);
    expect(b.scrollTo).not.toHaveBeenCalled();
    expect(b.post).toHaveBeenLastCalledWith({ type: "emend:position", heading: 0, fraction: 0 }, "*");
  } finally {
    await b.close();
  }
});

test.each(["document", "inset", "body"].flatMap((kind) => [false, true].map((last) => ({ kind, last }))))(
  "R4 report/reload/restore/report is stable for $kind (last heading=$last)",
  async ({ kind, last }) => {
    let saved: { heading: number; fraction: number } | undefined;
    const initial = kind === "inset" ? (last ? 1600 : 600) : last ? 1800 : 1100;
    const b = readingLineLayout(kind);
    try {
      b.scroller.scrollTop = initial;
      await b.settle();
      saved = b.post.mock.calls.findLast(([data]) => data.type === "emend:position")?.[0];
      expect(saved?.heading).toBe(last ? 2 : kind === "inset" ? 0 : 1);
      const top = kind === "inset" ? (last ? -157 : -257) : last ? -300 : -200;
      const span = last ? (kind === "inset" ? 900 - top : 900) : 600;
      expect(saved?.fraction).toBeCloseTo((100 - top) / span);
    } finally {
      await b.close();
    }
    const restored = readingLineLayout(kind);
    try {
      const position = required(saved);
      restored.message({
        type: "emend:goto",
        heading: position.heading,
        fraction: position.fraction,
        label: ["First", "Second", "Third"][position.heading],
      });
      await resumeMeasurement(restored);
      await restored.settle();
      const after = restored.post.mock.calls.findLast(([data]) => data.type === "emend:position")?.[0];
      expect(after?.heading).toBe(position.heading);
      // The measured loop permits an error below 0.01 instead of solving an exact pixel formula.
      expect(Math.abs(after.fraction - position.fraction)).toBeLessThan(0.01);
    } finally {
      await restored.close();
    }
  },
);

test.each(["document", "inset", "body"])(
  "R4 a small fraction can restore backwards in the %s scroller",
  async (kind) => {
    const b = readingLineLayout(kind);
    try {
      b.message({ type: "emend:goto", heading: 0, label: "First", fraction: 0.05 });
      await resumeMeasurement(b);
      await b.settle();
      expect(b.scroller.scrollTop).toBeCloseTo(kind === "inset" ? 273 : 230);
      const after = b.post.mock.calls.findLast(([data]) => data.type === "emend:position")?.[0];
      expect(after?.heading).toBe(0);
      expect(after?.fraction).toBeCloseTo(0.05);
    } finally {
      await b.close();
    }
  },
);

function shortSections() {
  const b = clockedBridge("<h2>First</h2><h3>Second</h3><h2>Last</h2>");
  const root = b.window.document.documentElement;
  const headings = [...b.window.document.querySelectorAll("h2,h3")];
  const offsets = [300, 350, 900];
  vi.spyOn(b.elementPrototype, "scrollHeight", "get").mockReturnValue(1100);
  vi.spyOn(b.elementPrototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return new b.window.DOMRect(0, required(offsets[headings.indexOf(this)]) - root.scrollTop, 400, 20);
  });
  b.scroll.mockImplementation(function (this: Element) {
    root.scrollTop = Math.min(700, required(offsets[headings.indexOf(this)]));
  });
  b.scrollTo.mockImplementation(function (this: Element, options: number | ScrollToOptions | undefined) {
    if (typeof options === "object" && options.behavior === "instant")
      this.scrollTop = Math.max(0, Math.min(700, options.top ?? 0));
  });
  return { ...b, root };
}

// Ends a goto's pin the way a reader would: the view moves (here the frame height, which moves the
// reading line) and a measurement runs. Then the height returns, so the next report is the true one.
async function resumeMeasurement(b: ReturnType<typeof bridge>) {
  const height = b.window.innerHeight;
  const settle = async () => {
    if (vi.isFakeTimers()) vi.advanceTimersByTime(200);
    else await b.window.happyDOM.waitUntilComplete();
  };
  Object.defineProperty(b.window, "innerHeight", { configurable: true, value: height + 40 });
  b.window.dispatchEvent(new b.window.Event("resize"));
  await settle();
  Object.defineProperty(b.window, "innerHeight", { configurable: true, value: height });
  b.window.dispatchEvent(new b.window.Event("resize"));
}

test("R5.1 restoring fraction zero aligns the saved heading to the reading line", async () => {
  const b = shortSections();
  try {
    b.root.scrollTop = 200;
    vi.advanceTimersByTime(400);
    expect(b.post).toHaveBeenLastCalledWith({ type: "emend:position", heading: 0, fraction: 0 }, "*");
    b.root.scrollTop = 0;
    b.message({ type: "emend:goto", heading: 0, label: "First", fraction: 0 });
    expect(b.root.scrollTop).toBe(200);
    await resumeMeasurement(b);
    vi.advanceTimersByTime(200);
    expect(b.post).toHaveBeenLastCalledWith({ type: "emend:position", heading: 0, fraction: 0 }, "*");
  } finally {
    await b.close();
  }
});

function coupledScroller(kind: string, paneLimit?: number) {
  const b = clockedBridge(
    "<style>main{max-height:200px;overflow:auto}</style><main><h2>Inside</h2></main><h2>Footer</h2>",
  );
  Object.defineProperty(b.window, "innerHeight", { configurable: true, value: 500 });
  const root = b.window.document.documentElement;
  const pane = required(b.window.document.querySelector("main"));
  const headings = [...b.window.document.querySelectorAll("h2")];
  const footer = kind === "footer" ? 268 : kind === "adjacent" || kind === "pane only" ? 248 : 1943;
  const limit = paneLimit ?? (kind === "footer" || kind === "adjacent" ? 320 : kind === "pane only" ? 3000 : 340);
  // In the pane-only layout the document itself cannot scroll: only the pane moves the heading.
  const rootLimit = kind === "pane only" ? 0 : 3000;
  vi.spyOn(b.elementPrototype, "scrollHeight", "get").mockReturnValue(4000);
  vi.spyOn(b.elementPrototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const top = this === headings[0] ? 343 - pane.scrollTop : this === headings[1] ? footer : 43;
    return new b.window.DOMRect(0, top - root.scrollTop, 400, 20);
  });
  b.scroll.mockImplementation(() => {
    pane.scrollTop = 300;
    root.scrollTop = Math.min(43, rootLimit);
  });
  b.scrollTo.mockImplementation(function (this: Element, options: number | ScrollToOptions | undefined) {
    if (typeof options === "object" && options.behavior === "instant")
      this.scrollTop = Math.max(0, Math.min(this === pane ? limit : rootLimit, options.top ?? 0));
  });
  const fraction = kind === "footer" ? 0.6425 : kind === "adjacent" || kind === "pane only" ? 0.7292 : 0.3235;
  if (kind === "pane only") {
    pane.scrollTop = 343 - (125 - fraction * footer) / (1 - fraction);
  } else {
    pane.scrollTop = limit;
    root.scrollTop = fraction * (footer - 343 + limit) + 343 - limit - 125;
  }
  return { ...b, pane, root, fraction };
}

test.each(["footer", "distant heading"])(
  "R5.2 restore distributes movement across ancestors with a %s outside the box",
  async (kind) => {
    const b = coupledScroller(kind);
    try {
      vi.advanceTimersByTime(400);
      const saved = b.post.mock.calls.findLast(([data]) => data.type === "emend:position")?.[0];
      expect(saved.heading).toBe(0);
      expect(saved.fraction).toBeCloseTo(b.fraction);
      b.root.scrollTop = 0;
      b.pane.scrollTop = 0;
      b.message({ type: "emend:goto", heading: 0, label: "Inside", fraction: saved.fraction });
      await resumeMeasurement(b);
      vi.advanceTimersByTime(200);
      const after = b.post.mock.calls.findLast(([data]) => data.type === "emend:position")?.[0];
      expect(after.heading).toBe(saved.heading);
      expect(Math.abs(after.fraction - saved.fraction)).toBeLessThan(0.01);
      expect(b.window.document.body.scrollTop).toBe(0);
    } finally {
      await b.close();
    }
  },
);

async function reportAfterRestore(
  kind: string,
  saved: { heading: number; fraction: number } | undefined,
  paneLimit?: number,
) {
  // A reload: a fresh bridge, both scrollers at the top, one restore, then the true measured position.
  const b = coupledScroller(kind, paneLimit);
  try {
    vi.advanceTimersByTime(400);
    const first = b.post.mock.calls.findLast(([data]) => data.type === "emend:position")?.[0];
    const position = saved ?? first;
    b.root.scrollTop = 0;
    b.pane.scrollTop = 0;
    b.message({ type: "emend:goto", heading: 0, label: "Inside", fraction: position.fraction });
    await resumeMeasurement(b);
    vi.advanceTimersByTime(200);
    return { first, after: b.post.mock.calls.findLast(([data]) => data.type === "emend:position")?.[0] };
  } finally {
    await b.close();
  }
}

test.each(["adjacent", "pane only"])("R6.3 a restore next to the footer heading converges (%s)", async (kind) => {
  const { first, after } = await reportAfterRestore(kind, undefined);
  expect(first.heading).toBe(0);
  expect(first.fraction).toBeCloseTo(0.7292, 3);
  expect(after.heading).toBe(0);
  expect(Math.abs(after.fraction - first.fraction)).toBeLessThan(0.002 + 1e-9);
});

test.each([0.02, 0.5, 0.7292, 0.92, 0.95, 0.98])(
  "R6.3 a footer-adjacent restore stays in its section when a secant step reaches the pane limit (fraction=%s)",
  async (fraction) => {
    // The pane takes the first step alone; a later step spills into the root,
    // where the fraction changes faster. Keep the earlier round-trip fixtures too.
    const saved = { heading: 0, fraction };
    const { after } = await reportAfterRestore("adjacent", saved, 400);
    expect(after.heading).toBe(saved.heading);
    expect(Math.abs(after.fraction - saved.fraction)).toBeLessThan(0.01);
  },
);

test("R7b a bracket contains an overshoot and converges within sixteen measured passes", async () => {
  const b = coupledScroller("adjacent", 400);
  try {
    vi.advanceTimersByTime(400);
    b.root.scrollTop = 0;
    b.pane.scrollTop = 0;
    const bounds = required(vi.mocked(b.elementPrototype.getBoundingClientRect).getMockImplementation());
    const footer = required(b.window.document.querySelectorAll("h2")[1]);
    const measured: { distance: number; fraction: number }[] = [];
    vi.spyOn(b.elementPrototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const result = bounds.call(this);
      // The footer is read once per search pass and once for the final landing measurement.
      // Reads of Inside during scrolling do not count as search passes.
      if (this === footer) {
        const top = 343 - b.pane.scrollTop - b.root.scrollTop;
        measured.push({ distance: 0 - top, fraction: (125 - top) / Math.max(1, result.top - top) });
      }
      return result;
    });
    const saved = 0.95;
    b.message({ type: "emend:goto", heading: 0, label: "Inside", fraction: saved });
    const passes = measured.slice(0, -1);
    expect(passes.length).toBeGreaterThan(2);
    expect(passes.length).toBeLessThanOrEqual(16);
    expect(passes[0]?.distance).toBe(0);
    expect(passes.some((sample) => sample.fraction > 1)).toBe(true); // The search crosses into Footer.
    let lower: number | undefined;
    let upper: number | undefined;
    for (const sample of passes) {
      if (lower !== undefined && upper !== undefined) {
        expect(sample.distance).toBeGreaterThan(lower);
        expect(sample.distance).toBeLessThan(upper);
      }
      if (sample.fraction < saved) lower = Math.max(lower ?? -Infinity, sample.distance);
      else upper = Math.min(upper ?? Infinity, sample.distance);
    }
    expect(lower).toBeDefined();
    expect(upper).toBeDefined();
    expect(Math.abs(required(measured.at(-1)).fraction - saved)).toBeLessThanOrEqual(0.002);
    await resumeMeasurement(b);
    vi.advanceTimersByTime(200);
    const after = b.post.mock.calls.findLast(([data]) => data.type === "emend:position")?.[0];
    expect(after.heading).toBe(0);
    expect(Math.abs(after.fraction - saved)).toBeLessThanOrEqual(0.002);
  } finally {
    await b.close();
  }
});

test.each(["adjacent", "pane only"])(
  "R6.3 five reload cycles in a row do not drift by more than 0.01 (%s)",
  async (kind) => {
    let saved: { heading: number; fraction: number } | undefined;
    const first = (await reportAfterRestore(kind, undefined)).first;
    saved = first;
    for (let cycle = 0; cycle < 5; cycle++) {
      const { after } = await reportAfterRestore(kind, saved);
      expect(after.heading).toBe(first.heading);
      saved = after;
    }
    expect(Math.abs(required(saved).fraction - first.fraction)).toBeLessThan(0.01);
  },
);

test.each(
  ["wheel", "touchmove", "keydown", "pointerdown", "click"].flatMap((input) =>
    ["pick", "restore"].map((kind) => ({ input, kind })),
  ),
)("R5.3 $kind stays pinned through $input and scroll events that move nothing", async ({ input, kind }) => {
  const b = shortSections();
  try {
    const pinned = { type: "emend:position", heading: 0, fraction: kind === "restore" ? 0.25 : 0 };
    b.message({ type: "emend:goto", heading: 0, label: "First", ...(kind === "restore" ? { fraction: 0.25 } : {}) });
    b.window.dispatchEvent(new b.window.Event("scroll"));
    vi.advanceTimersByTime(400);
    expect(b.post).toHaveBeenLastCalledWith(pinned, "*");
    for (const type of [input, "touchend", "pointerup"])
      b.window.document.dispatchEvent(new b.window.Event(type, { bubbles: true, composed: true }));
    b.window.dispatchEvent(new b.window.Event("scroll"));
    vi.advanceTimersByTime(400);
    expect(b.post).toHaveBeenLastCalledWith(pinned, "*");
    expect(b.post.mock.calls.filter(([data]) => data.type === "emend:position")).toHaveLength(1);
    b.root.scrollTop = 700;
    b.window.dispatchEvent(new b.window.Event("scroll"));
    vi.advanceTimersByTime(400);
    const actual = b.post.mock.calls.findLast(([data]) => data.type === "emend:position")?.[0];
    expect(actual.heading).toBe(1);
    expect(actual.fraction).toBeCloseTo(450 / 550);
  } finally {
    await b.close();
  }
});

test.each(["emend:scroll", "programmatic scroll"])(
  "R6.1 a pinned goto ends when the view moves by %s, with no input event",
  async (how) => {
    const b = shortSections();
    try {
      b.message({ type: "emend:goto", heading: 0, label: "First" });
      b.message({ type: "emend:highlight", anchors: [{ threadId: "t", quote: "Last", prefix: "", suffix: "" }] });
      vi.advanceTimersByTime(400);
      expect(b.post).toHaveBeenLastCalledWith({ type: "emend:position", heading: 0, fraction: 0 }, "*");
      b.scroll.mockImplementation(function (this: Element) {
        b.root.scrollTop = 700;
      });
      if (how === "emend:scroll") b.message({ type: "emend:scroll", threadId: "t" });
      else {
        b.root.scrollTop = 700;
        b.window.dispatchEvent(new b.window.Event("scroll"));
      }
      vi.advanceTimersByTime(400);
      const actual = b.post.mock.calls.findLast(([data]) => data.type === "emend:position")?.[0];
      expect(actual.heading).toBe(1);
      expect(actual.fraction).toBeCloseTo(450 / 550);
    } finally {
      await b.close();
    }
  },
);

test("R7.2 a broken same-doc fragment keeps the restore pin and does not scroll", async () => {
  const b = shortSections();
  try {
    // Integer scroll positions leave a real landing error in this short section.
    b.scrollTo.mockImplementation(function (this: Element, options: number | ScrollToOptions | undefined) {
      if (typeof options === "object") this.scrollTop = Math.max(0, Math.min(700, Math.round(options.top ?? 0)));
    });
    const link = b.window.document.createElement("a");
    link.setAttribute("href", "#missing");
    b.window.document.body.appendChild(link);
    b.message({ type: "emend:goto", heading: 0, label: "First", fraction: 0.25 });
    vi.advanceTimersByTime(400);
    expect(b.root.scrollTop).toBe(213); // Actual fraction 0.26; the pin must keep the requested 0.25.
    expect(b.post).toHaveBeenLastCalledWith({ type: "emend:position", heading: 0, fraction: 0.25 }, "*");
    const before = { href: b.window.location.href, length: b.window.history.length };
    b.scroll.mockClear();
    b.scrollTo.mockClear();
    b.post.mockClear();
    expect(click(b, link).defaultPrevented).toBe(true);
    b.window.document.dispatchEvent(new b.window.Event("pointerup", { bubbles: true, composed: true }));
    vi.advanceTimersByTime(1000);
    expect(b.scroll).not.toHaveBeenCalled();
    expect(b.scrollTo).not.toHaveBeenCalled();
    expect(b.post).not.toHaveBeenCalled();
    expect({ href: b.window.location.href, length: b.window.history.length }).toEqual(before);
    // Show that the landing error exists, independently of the pinned report.
    await resumeMeasurement(b);
    vi.advanceTimersByTime(200);
    expect(b.post).toHaveBeenLastCalledWith({ type: "emend:position", heading: 0, fraction: 0.26 }, "*");
  } finally {
    await b.close();
  }
});

test("R5.3 picking a final heading keeps that heading even when scroll limits leave it below the line", async () => {
  const b = shortSections();
  try {
    b.message({ type: "emend:goto", heading: 2, label: "Last" });
    expect(b.root.scrollTop).toBe(700);
    vi.advanceTimersByTime(200);
    expect(b.post).toHaveBeenLastCalledWith({ type: "emend:position", heading: 2, fraction: 0 }, "*");
  } finally {
    await b.close();
  }
});

test.each(
  [true, false].flatMap((native) => ["scroll", "idle", "resize", "goto"].map((trigger) => ({ native, trigger }))),
)("R5.4 hidden frames do not measure or post (native=$native, trigger=$trigger)", async ({ native, trigger }) => {
  const b = clockedBridge("<h2>First</h2><h3>Next</h3>");
  let hidden = false;
  const method = b.elementPrototype.checkVisibility;
  try {
    const root = b.window.document.documentElement;
    const bounds = vi
      .spyOn(b.elementPrototype, "getBoundingClientRect")
      .mockReturnValue(new b.window.DOMRect(0, 40, 400, 20));
    vi.spyOn(b.elementPrototype, "checkVisibility").mockImplementation(() => !hidden);
    vi.spyOn(b.elementPrototype, "getClientRects").mockImplementation(() =>
      hidden ? rects() : rects(new b.window.DOMRect(0, 0, 400, 20)),
    );
    if (!native) Object.defineProperty(b.elementPrototype, "checkVisibility", { configurable: true, value: undefined });
    Object.defineProperty(root, "checkVisibility", {
      configurable: true,
      value: () => {
        throw new Error("Shadowed visibility");
      },
    });
    vi.advanceTimersByTime(trigger === "idle" ? 200 : 400);
    if (trigger === "goto") b.message({ type: "emend:goto", heading: 0, label: "First" });
    b.post.mockClear();
    bounds.mockClear();
    hidden = true;
    if (trigger === "scroll" || trigger === "resize") b.window.dispatchEvent(new b.window.Event(trigger));
    vi.advanceTimersByTime(1400);
    expect(b.post).not.toHaveBeenCalled();
    expect(bounds).not.toHaveBeenCalled();
    hidden = false;
    b.window.dispatchEvent(new b.window.Event("scroll"));
    vi.advanceTimersByTime(200);
    expect(b.post.mock.calls.some(([data]) => data.type === "emend:position")).toBe(true);
  } finally {
    Object.defineProperty(b.elementPrototype, "checkVisibility", { configurable: true, writable: true, value: method });
    await b.close();
  }
});

test("R5.5 animated layout cannot keep the trailing checks alive past five samples", async () => {
  const b = clockedBridge("<h2>Moving</h2>");
  try {
    let top = 0;
    const bounds = vi
      .spyOn(b.elementPrototype, "getBoundingClientRect")
      .mockImplementation(() => new b.window.DOMRect(0, ++top, 400, 20));
    vi.advanceTimersByTime(4000);
    expect(bounds).toHaveBeenCalledTimes(5);
    b.window.document.dispatchEvent(new b.window.Event("wheel", { bubbles: true, composed: true }));
    vi.advanceTimersByTime(4000);
    expect(bounds).toHaveBeenCalledTimes(10);
  } finally {
    await b.close();
  }
});

test("R6.2 layout-driven scroll events post nothing and start no sampling when the position is unchanged", async () => {
  const b = clockedBridge("<h2>One</h2><h3>Two</h3>");
  try {
    const bounds = vi.spyOn(b.elementPrototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      // An animation above the headings moves the tops while scroll anchoring keeps the position.
      return new b.window.DOMRect(0, this.localName === "h2" ? 50 : 500, 400, 20);
    });
    vi.advanceTimersByTime(1500);
    const posts = () => b.post.mock.calls.filter(([data]) => data.type === "emend:position").length;
    expect(posts()).toBe(1);
    bounds.mockClear();
    for (let tick = 0; tick < 25; tick++) {
      b.window.dispatchEvent(new b.window.Event("scroll"));
      vi.advanceTimersByTime(200);
    }
    expect(posts()).toBe(1);
    // One measurement per event at most; no timer chain.
    expect(bounds.mock.calls.length).toBeLessThanOrEqual(2 * 25);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await b.close();
  }
});

test("R6.2 a posted position repeats nothing, and momentum still reports its final position", async () => {
  const b = shortSections();
  try {
    vi.advanceTimersByTime(400);
    b.post.mockClear();
    for (const top of [200, 210, 260, 320, 380]) {
      b.root.scrollTop = top;
      b.window.dispatchEvent(new b.window.Event("scroll"));
      vi.advanceTimersByTime(200);
    }
    vi.advanceTimersByTime(2000);
    expect(b.post.mock.calls.at(-1)?.[0]).toEqual({ type: "emend:position", heading: 1, fraction: 130 / 550 });
    const count = b.post.mock.calls.length;
    b.window.dispatchEvent(new b.window.Event("scroll"));
    b.window.dispatchEvent(new b.window.Event("resize"));
    vi.advanceTimersByTime(2000);
    expect(b.post.mock.calls).toHaveLength(count);
  } finally {
    await b.close();
  }
});

test("R5.6 resizing the frame updates the reading line without a scroll", async () => {
  const b = clockedBridge("<h2>First</h2><h3>Next</h3>");
  try {
    const headings = [...b.window.document.querySelectorAll("h2,h3")];
    vi.spyOn(b.elementPrototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return new b.window.DOMRect(0, this === headings[0] ? 140 : 740, 400, 20);
    });
    vi.advanceTimersByTime(400);
    expect(b.post).toHaveBeenLastCalledWith({ type: "emend:position", heading: null, fraction: 0 }, "*");
    Object.defineProperty(b.window, "innerHeight", { configurable: true, value: 800 });
    b.window.dispatchEvent(new b.window.Event("resize"));
    vi.advanceTimersByTime(200);
    expect(b.post).toHaveBeenLastCalledWith({ type: "emend:position", heading: 0, fraction: 0.1 }, "*");
  } finally {
    await b.close();
  }
});

test("R5.6 body scroll height wins over html height when only the body scrolls", async () => {
  const b = clockedBridge("<style>html{overflow:hidden}body{height:100%;overflow:auto}</style><h2>Last</h2>");
  try {
    const body = b.window.document.body;
    body.scrollTop = 600;
    vi.spyOn(b.elementPrototype, "scrollHeight", "get").mockImplementation(function (this: Element) {
      return this === body ? 2400 : 400;
    });
    vi.spyOn(b.elementPrototype, "getBoundingClientRect").mockImplementation(
      () => new b.window.DOMRect(0, 200 - body.scrollTop, 400, 20),
    );
    vi.advanceTimersByTime(200);
    expect(b.post).toHaveBeenLastCalledWith({ type: "emend:position", heading: 0, fraction: 500 / 2800 }, "*");
  } finally {
    await b.close();
  }
});
