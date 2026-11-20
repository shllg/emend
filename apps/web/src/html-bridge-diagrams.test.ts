// @vitest-environment node
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { type Element, type ShadowRoot, Window } from "happy-dom";
import { afterEach, expect, test, vi } from "vitest";
import {
  DIAGRAM_COUNT_MAX,
  DIAGRAM_DIMENSION_MAX,
  DIAGRAM_REQUEST_MAX,
  DIAGRAM_SOURCE_MAX,
  DIAGRAM_SVG_MAX,
  DIAGRAM_TOTAL_MAX,
  FrameToParent,
} from "./lib/frame-messages.ts";

const bridgeSource = readFileSync(new URL("../../emend/src/server/content/bridge.ts", import.meta.url), "utf8");
const windows: Window[] = [];
afterEach(async () => {
  for (const window of windows.splice(0)) await window.happyDOM.close();
  vi.restoreAllMocks();
});
function bridge(html: string, prepare?: (window: Window) => void) {
  const window = new Window({ settings: { enableJavaScriptEvaluation: false } });
  windows.push(window);
  const errors: unknown[] = [];
  window.addEventListener("error", (event) => {
    if ("error" in event) errors.push(event.error);
  });
  window.document.write(html);
  if (!Object.getOwnPropertyDescriptor(window.Element.prototype, "assignedSlot"))
    Object.defineProperty(window.Element.prototype, "assignedSlot", { configurable: true, get: () => null });
  // Browsers implement element textContent on Node; happy-dom overrides it on Element.
  const textContent = Object.getOwnPropertyDescriptor(window.Element.prototype, "textContent")?.get;
  if (!textContent) throw new Error("Missing textContent getter");
  vi.spyOn(window.Node.prototype, "textContent", "get").mockImplementation(function (this: Element) {
    return textContent.call(this);
  });
  const post = vi.fn();
  const parent = { postMessage: post };
  Object.defineProperty(window, "parent", { value: parent });
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  vi.spyOn(window, "matchMedia").mockReturnValue(media);
  const pixels = { color: "", rgb: [0, 0, 0, 255], fail: false };
  class Pixel {
    get data() {
      return pixels.rgb;
    }
  }
  class Context {
    set fillStyle(value: string) {
      pixels.color = value;
    }
    fillRect() {}
    getImageData() {
      return new Pixel();
    }
  }
  Object.defineProperty(window, "CanvasRenderingContext2D", { value: Context, configurable: true });
  Object.defineProperty(window, "ImageData", { value: Pixel, configurable: true });
  vi.spyOn(window.HTMLCanvasElement.prototype, "getContext").mockImplementation(() => {
    if (pixels.fail) throw new Error("No canvas");
    return new Context() as never;
  });
  const shadows: ShadowRoot[] = [];
  const attach = window.Element.prototype.attachShadow;
  vi.spyOn(window.Element.prototype, "attachShadow").mockImplementation(function (this: Element, options) {
    const shadow = attach.call(this, options);
    shadows.push(shadow);
    return shadow;
  });
  const highlights = new Map();
  Object.defineProperty(window, "HighlightRegistry", { value: Map });
  class Highlight {
    range: Range;
    constructor(range: Range) {
      this.range = range;
    }
  }
  prepare?.(window);
  const script = runInNewContext(`${bridgeSource.replace("export const", "const")}; BRIDGE_SOURCE;`);
  runInNewContext(script, {
    window,
    document: window.document,
    CSS: { highlights },
    Highlight,
    CSSStyleSheet: window.CSSStyleSheet,
    Intl,
  });
  window.document.dispatchEvent(new window.Event("DOMContentLoaded"));
  if (errors.length) throw errors[0];
  const message = (data: unknown, source: unknown = parent) => {
    window.dispatchEvent(new window.MessageEvent("message", { data, source: source as Window }));
    if (errors.length) throw errors[0];
  };
  const jobs = () => post.mock.calls.filter(([data]) => data.type === "emend:diagrams").map(([data]) => data);
  const result = {
    type: "emend:diagram",
    request: 1,
    index: 0,
    svg: '<svg xmlns="http://www.w3.org/2000/svg"/>',
    width: 480,
    height: 240,
  };
  return { window, post, pixels, media, shadows, highlights, message, jobs, result };
}

test("bridge diagram limits stay in parity with message schemas", () => {
  for (const [name, value] of Object.entries({
    DIAGRAM_SOURCE_MAX,
    DIAGRAM_COUNT_MAX,
    DIAGRAM_TOTAL_MAX,
    DIAGRAM_SVG_MAX,
    DIAGRAM_DIMENSION_MAX,
    DIAGRAM_REQUEST_MAX,
  }))
    expect(bridgeSource).toContain(`const ${name} = ${value};`);
});

test("scan uses exact HTML pre class tokens, light DOM, source text and document order", () => {
  const b = bridge(
    `<body>
    <pre class="code\tmermaid other"><code>flowchart LR\n A --&gt; B</code></pre>
    <div class="mermaid">no</div><code class="language-mermaid">no</code>
    <pre class="xmermaid">no</pre><pre class="mermaid\u00a0other">no</pre>
    <template><pre class="mermaid">no</pre></template><noscript><pre class="mermaid">no</pre></noscript>
    <script><pre class="mermaid">no</pre></script><style><pre class="mermaid">no</pre></style>
    <pre class="mermaid">   </pre><pre class="mermaid">${"x".repeat(50001)}</pre>
    <pre id="outer" class="mermaid">outer</pre><pre class="mermaid">last</pre>
  </body>`,
    (window) => {
      const outer = window.document.querySelector("#outer");
      const nested = window.document.createElement("pre");
      nested.className = "mermaid";
      nested.textContent = "nested";
      outer?.append(nested);
      const shadow = window.document.createElement("div");
      window.document.body.append(shadow);
      shadow.attachShadow({ mode: "open" }).append(nested.cloneNode(true));
      const foreign = window.document.createElementNS("http://www.w3.org/2000/svg", "pre");
      foreign.setAttribute("class", "mermaid");
      foreign.textContent = "foreign";
      window.document.body.append(foreign);
    },
  );
  expect(b.jobs()).toEqual([
    {
      type: "emend:diagrams",
      request: 1,
      diagrams: [
        { source: "flowchart LR\n A --> B", mode: "light", width: 1 },
        { source: "outernested", mode: "light", width: 1 },
        { source: "last", mode: "light", width: 1 },
      ],
    },
  ]);
  expect(b.post.mock.calls.slice(0, 2).map(([data]) => data.type)).toEqual(["emend:ready", "emend:diagrams"]);
});

test.each([
  { count: 51, length: 1, kept: 50 },
  { count: 21, length: 50000, kept: 20 },
  { count: 22, length: 49000, kept: 20 },
])("scan caps $count sources of $length characters at $kept", ({ count, length, kept }) => {
  const b = bridge(
    `<body>${`<pre class="mermaid">${"x".repeat(length)}</pre>`.repeat(count)}<pre class="mermaid">tail</pre></body>`,
  );
  expect(b.jobs()[0].diagrams).toHaveLength(kept);
  expect(FrameToParent.safeParse(b.jobs()[0]).success).toBe(true);
});

test("empty scans send nothing", () => {
  expect(bridge('<pre class="mermaid"> \n </pre>').jobs()).toEqual([]);
});

test("modes use parent colour, sRGB luminance ignoring alpha, and only changes request another draw", () => {
  const b = bridge('<div style="color: rgb(255, 255, 255)"><pre class="mermaid">graph LR</pre></div>');
  expect(b.pixels.color).toBe("rgb(255, 255, 255)");
  const theme = { type: "emend:theme", mode: "dark", scales: {}, tokens: {} };
  b.pixels.rgb = [255, 255, 255, 128];
  b.message({ ...theme, mode: "invalid" });
  b.message({ ...theme, tokens: { bad: "url(x)" } });
  expect(b.jobs()).toHaveLength(1);
  b.message(theme);
  expect(b.jobs()[1]).toMatchObject({ request: 2, diagrams: [{ mode: "dark" }] });
  b.message(b.result);
  expect(b.shadows).toHaveLength(0); // A reply to the first mode is now stale.
  b.message(theme);
  expect(b.jobs()).toHaveLength(2);
  b.pixels.rgb = [0, 255, 0, 255];
  b.media.dispatchEvent(new b.window.Event("change"));
  expect(b.jobs()).toHaveLength(2);
  b.pixels.rgb = [255, 0, 0, 255];
  b.media.dispatchEvent(new b.window.Event("change"));
  expect(b.jobs()).toHaveLength(2);
  b.pixels.rgb = [0, 0, 255, 255];
  b.media.dispatchEvent(new b.window.Event("change"));
  expect(b.jobs()[2]).toMatchObject({ request: 3, diagrams: [{ mode: "light" }] });
  b.pixels.rgb = [255, 255, 255, 255];
  b.message(theme);
  b.pixels.fail = true;
  b.message(theme);
  expect(b.jobs().at(-1)).toMatchObject({ request: 5, diagrams: [{ mode: "light" }] });
});

test.each(["theme", "colour scheme"])("a color transition after a %s change rechecks diagram modes", (trigger) => {
  const b = bridge('<section><div><pre class="mermaid">graph LR</pre></div></section><aside>Other</aside>');
  // Happy DOM has no TransitionEvent; provide its browser prototype getter.
  class TransitionEvent extends b.window.Event {
    #propertyName: string;
    constructor(propertyName: string) {
      super("transitionend");
      this.#propertyName = propertyName;
    }
    get propertyName() {
      return this.#propertyName;
    }
  }
  Object.defineProperty(b.window, "TransitionEvent", { value: TransitionEvent });
  const ancestor = b.window.document.querySelector("section");
  const outside = b.window.document.querySelector("aside");
  if (!ancestor || !outside) throw new Error("Missing transition targets");
  expect(b.jobs()[0]).toMatchObject({ request: 1, diagrams: [{ mode: "light" }] });
  if (trigger === "theme") b.message({ type: "emend:theme", mode: "dark", scales: {}, tokens: {} });
  else b.media.dispatchEvent(new b.window.Event("change"));
  expect(b.jobs()).toHaveLength(1);
  b.pixels.rgb = [255, 255, 255, 255];
  ancestor.dispatchEvent(new TransitionEvent("opacity"));
  outside.dispatchEvent(new TransitionEvent("color"));
  expect(b.jobs()).toHaveLength(1);
  ancestor.dispatchEvent(new TransitionEvent("color"));
  expect(b.jobs()).toHaveLength(2);
  expect(b.jobs()[1]).toMatchObject({ request: 2, diagrams: [{ mode: "dark" }] });
  ancestor.dispatchEvent(new TransitionEvent("color"));
  expect(b.jobs()).toHaveLength(2);
});

test.each([0, 450.6, 10001])("width %s is rounded and clamped; width alone never reposts", (width) => {
  const b = bridge('<pre class="mermaid">graph LR</pre>', (window) => {
    vi.spyOn(window.Element.prototype, "getBoundingClientRect").mockReturnValue({ width } as never);
  });
  expect(b.jobs()[0].diagrams[0].width).toBe(Math.max(1, Math.min(10000, Math.round(width))));
  b.media.dispatchEvent(new b.window.Event("change"));
  expect(b.jobs()).toHaveLength(1);
});

test.each([0, 720.6, 10001])("redraws measure the placed host's width %s", (width) => {
  const b = bridge('<pre class="mermaid">graph LR</pre>', (window) => {
    vi.spyOn(window.Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const measured = this.hasAttribute("data-emend-diagram")
        ? width
        : window.getComputedStyle(this).display === "none"
          ? 0
          : 450.6;
      return new window.DOMRect(0, 0, measured, 20);
    });
  });
  expect(b.jobs()[0].diagrams[0].width).toBe(451);
  b.message(b.result);
  expect(b.window.document.querySelector("pre")?.style.display).toBe("none");
  b.pixels.rgb = [255, 255, 255, 255];
  b.message({ type: "emend:theme", mode: "dark", scales: {}, tokens: {} });
  expect(b.jobs()[1].diagrams[0].width).toBe(Math.max(1, Math.min(10000, Math.round(width))));
  b.pixels.rgb = [0, 0, 0, 255];
  b.media.dispatchEvent(new b.window.Event("change"));
  expect(b.jobs()[2].diagrams[0].width).toBe(Math.max(1, Math.min(10000, Math.round(width))));
});

test.each(["", "display: inline", "display: grid !important"])(
  "placement preserves text, earlier highlights and original display %s",
  (style) => {
    const b = bridge(
      `<body><h2>Heading</h2><pre class="mermaid" style="${style}"><code>graph LR</code></pre><p>After</p></body>`,
    );
    const pre = b.window.document.querySelector("pre");
    if (!pre) throw new Error("Missing pre");
    const original = [pre.style.getPropertyValue("display"), pre.style.getPropertyPriority("display")];
    const nodes = [...pre.childNodes];
    const text = b.window.document.body.textContent;
    b.message({
      type: "emend:highlight",
      anchors: [{ threadId: "t", quote: "graph LR", prefix: "Heading", suffix: "After" }],
    });
    const range = b.highlights.get("emend-quotes").range;
    b.message(b.result);
    const host = pre.previousElementSibling;
    expect(host?.getAttribute("data-emend-diagram")).toBe("");
    expect(host?.tagName).toBe("DIV");
    expect(host?.shadowRoot).toBeNull();
    expect(host?.childNodes).toHaveLength(0);
    const img = b.shadows[0]?.querySelector("img");
    expect(img?.alt).toBe("Diagram");
    expect(img?.getAttribute("width")).toBe("480");
    expect(img?.getAttribute("height")).toBe("240");
    expect(img?.getAttribute("src")).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(b.result.svg)}`);
    expect(img?.style.cssText).toBe("display: block; max-width: 100%; height: auto;");
    expect([pre.style.getPropertyValue("display"), pre.style.getPropertyPriority("display")]).toEqual(original);
    b.message({ ...b.result, width: 120, height: 60 });
    expect(pre.previousElementSibling).toBe(host);
    expect(b.shadows).toHaveLength(1);
    expect(img?.width).toBe(120);
    expect([pre.style.getPropertyValue("display"), pre.style.getPropertyPriority("display")]).toEqual(original);
    expect(b.window.document.body.textContent).toBe(text);
    expect([...pre.childNodes]).toEqual(nodes);
    expect(range.toString()).toBe("graph LR");
    img?.dispatchEvent(new b.window.MouseEvent("click", { bubbles: true, composed: true }));
    expect(b.post.mock.calls.some(([data]) => data.type === "emend:image")).toBe(false);
    b.message({ type: "emend:diagram", request: 1, index: 0, svg: null });
    expect(host?.isConnected).toBe(false);
    expect([pre.style.getPropertyValue("display"), pre.style.getPropertyPriority("display")]).toEqual(original);
    expect(range.toString()).toBe("graph LR");
  },
);

test.each(["", "display: inline", "display: grid !important"])(
  "highlights reveal placed source with original display %s and hide it again",
  (style) => {
    const b = bridge(`<body><pre class="mermaid" style="${style}"><code>graph LR</code></pre><p>After</p></body>`);
    const pre = b.window.document.querySelector("pre");
    if (!pre) throw new Error("Missing pre");
    const original = [pre.style.getPropertyValue("display"), pre.style.getPropertyPriority("display")];
    b.message(b.result);
    const host = pre.previousElementSibling;
    expect(host?.getAttribute("data-emend-diagram")).toBe("");
    expect(pre.style.getPropertyValue("display")).toBe("none");
    expect(pre.style.getPropertyPriority("display")).toBe("important");
    const outside = { threadId: "outside", quote: "After", prefix: "", suffix: "" };
    b.message({
      type: "emend:highlight",
      anchors: [outside, { threadId: "source", quote: "graph LR", prefix: "", suffix: "" }],
    });
    expect(pre.previousElementSibling).toBe(host);
    expect([pre.style.getPropertyValue("display"), pre.style.getPropertyPriority("display")]).toEqual(original);
    const scroll = vi.spyOn(b.window.Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
      expect(this).toBe(pre.querySelector("code"));
      expect([pre.style.getPropertyValue("display"), pre.style.getPropertyPriority("display")]).toEqual(original);
    });
    b.message({ type: "emend:scroll", threadId: "source" });
    expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: "center" });
    b.message({ type: "emend:highlight", anchors: [outside] });
    expect(pre.previousElementSibling).toBe(host);
    expect(pre.style.getPropertyValue("display")).toBe("none");
    expect(pre.style.getPropertyPriority("display")).toBe("important");
    b.message({ type: "emend:diagram", request: 1, index: 0, svg: null });
    expect(host?.isConnected).toBe(false);
    expect([pre.style.getPropertyValue("display"), pre.style.getPropertyPriority("display")]).toEqual(original);
  },
);

test.each(["no diagrams", "unplaced diagrams", "hidden sources", "shown sources", "mixed sources"])(
  "highlights with unchanged visibility leave pins and scroll calls alone: %s",
  (state) => {
    vi.useFakeTimers();
    try {
      const sources = state === "no diagrams" ? [] : ["graph LR", "graph TD"];
      const b = bridge(
        `<body><h2>First</h2>${sources.map((source) => `<pre class="mermaid">${source}</pre>`).join("")}<h3>Second</h3><h2>Last</h2></body>`,
        (window) => Object.assign(window, { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout }),
      );
      const root = b.window.document.scrollingElement;
      const headings = [...b.window.document.querySelectorAll("h2,h3")];
      Object.defineProperty(b.window, "innerHeight", { configurable: true, value: 400 });
      const scale = () => (root.getAttribute("data-emend-prose") === "18" ? 2 : 1);
      const offset = (element: Element) => ([300, 350, 900][headings.indexOf(element)] ?? 0) * scale();
      const clamp = (top: number) => Math.max(0, Math.min(1100 * scale() - 400, Math.round(top)));
      vi.spyOn(b.window.Element.prototype, "checkVisibility").mockReturnValue(true);
      vi.spyOn(b.window.Element.prototype, "scrollHeight", "get").mockImplementation(() => 1100 * scale());
      vi.spyOn(b.window.Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
        return new b.window.DOMRect(0, offset(this) - root.scrollTop, 400, 20);
      });
      const scroll = vi.spyOn(b.window.Element.prototype, "scrollIntoView").mockImplementation(function (
        this: Element,
      ) {
        root.scrollTop = clamp(offset(this));
      });
      const scrollTo = vi.spyOn(b.window.Element.prototype, "scrollTo").mockImplementation(function (
        this: Element,
        options: number | ScrollToOptions | undefined,
      ) {
        if (this === root && typeof options === "object") root.scrollTop = clamp(options.top ?? 0);
      });
      const windowScroll = vi.spyOn(b.window, "scrollTo");
      if (state.endsWith("sources")) {
        b.message(b.result);
        b.message({ ...b.result, index: 1 });
      }
      const shown = state === "shown sources" ? 2 : state === "mixed sources" ? 1 : 0;
      const anchors = sources.slice(0, shown).map((quote) => ({ threadId: quote, quote, prefix: "", suffix: "" }));
      b.message({ type: "emend:highlight", anchors });
      b.message({ type: "emend:goto", heading: 0, label: "First", fraction: 0.25 });
      expect(root.scrollTop).toBe(213); // Rounded landing is 0.26; the pin must keep 0.25.
      vi.runAllTimers();
      for (const spy of [scroll, scrollTo, windowScroll, b.post]) spy.mockClear();
      const timer = vi.spyOn(b.window, "setTimeout");

      b.message({
        type: "emend:highlight",
        anchors: [...anchors, { threadId: "outside", quote: "Last", prefix: "", suffix: "" }],
      });
      expect(timer).not.toHaveBeenCalled();
      vi.runAllTimers();
      for (const spy of [scroll, scrollTo, windowScroll, b.post]) expect(spy).not.toHaveBeenCalled();
      expect(root.scrollTop).toBe(213);
      const pres = [...b.window.document.querySelectorAll("pre")];
      expect(pres.map((pre) => pre.style.display)).toEqual(
        sources.map((_, index) => (state.endsWith("sources") && index >= shown ? "none" : "")),
      );

      // A later layout change still restores the original pin, without rounding drift.
      b.message({ type: "emend:layout", wide: true, width: "comfortable", prose: 18, code: 13 });
      expect(scroll.mock.instances).toEqual([headings[0]]);
      expect(root.scrollTop).toBe(525);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);

test("foreign, stale and malformed answers leave the document intact", () => {
  const b = bridge('<pre class="mermaid">graph LR</pre>');
  b.message(b.result, {});
  for (const patch of [
    { request: 0 },
    { request: 2 },
    { request: "1" },
    { index: -1 },
    { index: 1 },
    { index: 0.5 },
    { index: "0" },
    { svg: " <svg/>" },
    { svg: "<script/>" },
    { svg: false },
    { svg: `<svg${"x".repeat(4000000)}` },
    { svg: "<svg>\ud800</svg>" },
    { width: 1.5 },
    { height: 0 },
    { width: 10001 },
    { height: "12" },
    { extra: true },
    { svg: null },
  ])
    b.message({ ...b.result, ...patch });
  expect(b.shadows).toHaveLength(0);
  expect(b.window.document.querySelector("pre")?.style.display).toBe("");
});

test("hostile attributes stay on source nodes and clobbered instance members are never called", () => {
  const clobbered = vi.fn(() => {
    throw new Error("Clobbered");
  });
  const b = bridge(
    `<body><script>alert(1)</script><img onerror="alert(1)"><a href="javascript:alert(1)">link</a>
    <svg onload="alert(1)"></svg><pre class="mermaid" onclick="alert(1)">graph LR</pre></body>`,
    (window) => {
      const pre = window.document.querySelector("pre");
      if (!pre) throw new Error("Missing pre");
      // Native CSSOM never calls an element's JS getAttribute; happy-dom does. Detach its backing style.
      const nativeStyle = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "style")?.get;
      if (!nativeStyle) throw new Error("Missing style getter");
      const style = window.document.createElement("div").style;
      vi.spyOn(window.HTMLElement.prototype, "style", "get").mockImplementation(function (this: Element) {
        return this === pre ? style : nativeStyle.call(this);
      });
      for (const name of ["getAttribute", "getBoundingClientRect", "textContent", "parentElement", "style"])
        Object.defineProperty(pre, name, { configurable: true, get: clobbered });
      Object.defineProperty(window.document, "createElement", { configurable: true, value: clobbered });
    },
  );
  // Window methods were captured before later named-property interference.
  Object.defineProperty(b.window, "getComputedStyle", { value: clobbered });
  b.media.dispatchEvent(new b.window.Event("change"));
  b.message(b.result);
  const host = b.window.document.querySelector("[data-emend-diagram]");
  expect(host?.getAttributeNames()).toEqual(["data-emend-diagram"]);
  expect(b.shadows[0]?.querySelector("img")?.getAttributeNames().sort()).toEqual([
    "alt",
    "height",
    "src",
    "style",
    "width",
  ]);
  expect(clobbered).not.toHaveBeenCalled();
  const pre = b.window.document.querySelector("pre");
  if (pre)
    for (const name of ["getAttribute", "getBoundingClientRect", "textContent", "parentElement", "style"])
      Reflect.deleteProperty(pre, name);
  Reflect.deleteProperty(b.window.document, "createElement");
});
