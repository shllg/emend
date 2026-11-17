// @vitest-environment node
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { type Element, type HTMLImageElement, Window } from "happy-dom";
import { afterEach, expect, test, vi } from "vitest";

const prefix = `/content/${"k".repeat(43)}${"a".repeat(32)}/`;
const origin = "http://127.0.0.1:3636";
afterEach(() => vi.restoreAllMocks());
function bridge(html: string, options: { captionNodes?: number } = {}) {
  const window = new Window({
    url: `${origin}${prefix}docs/page.html`,
    settings: { enableJavaScriptEvaluation: false },
  });
  window.document.write(html);
  // happy-dom omits the native assignedSlot getter used by same-doc link scrolling.
  if (!Object.getOwnPropertyDescriptor(window.Element.prototype, "assignedSlot"))
    Object.defineProperty(window.Element.prototype, "assignedSlot", { configurable: true, get: () => null });
  // happy-dom returns MediaQueryList objects but does not expose their constructor on Window.
  Object.defineProperty(window, "MediaQueryList", {
    value: Object.getPrototypeOf(window.matchMedia("all")).constructor,
  });
  // Browser Window operations live on the instance, unlike happy-dom's prototype methods.
  const nativeMatchMedia = window.matchMedia;
  const matchMedia = vi.fn((media: string) => nativeMatchMedia.call(window, media));
  Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: matchMedia });
  const prototypeMatchMedia = Object.getOwnPropertyDescriptor(window.Window.prototype, "matchMedia");
  Object.defineProperty(window.Window.prototype, "matchMedia", { configurable: true, value: undefined });
  const restoreMatchMedia = () => {
    if (prototypeMatchMedia) Object.defineProperty(window.Window.prototype, "matchMedia", prototypeMatchMedia);
    else Reflect.deleteProperty(window.Window.prototype, "matchMedia");
  };
  const attr = (node: Element, name: string) => window.Element.prototype.getAttribute.call(node, name);
  vi.spyOn(window.Element.prototype, "checkVisibility").mockImplementation(function (this: Element, options) {
    const style = attr(this, "style") ? window.getComputedStyle(this) : null;
    return (
      attr(this, "data-hidden") === null &&
      (!(options?.checkVisibilityCSS || options?.visibilityProperty) || style?.visibility !== "hidden") &&
      (!options?.opacityProperty || style?.opacity !== "0")
    );
  });
  vi.spyOn(window.HTMLImageElement.prototype, "currentSrc", "get").mockImplementation(function (
    this: HTMLImageElement,
  ) {
    return attr(this, "data-current-src") ?? "";
  });
  vi.spyOn(window.HTMLImageElement.prototype, "complete", "get").mockImplementation(function (this: HTMLImageElement) {
    return attr(this, "data-loading") === null;
  });
  for (const [name, attribute] of [
    ["naturalWidth", "data-width"],
    ["naturalHeight", "data-height"],
  ] as const)
    vi.spyOn(window.HTMLImageElement.prototype, name, "get").mockImplementation(function (this: HTMLImageElement) {
      return Number(attr(this, attribute) ?? 600);
    });
  const baseURI = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(window.Document.prototype), "baseURI")?.get;
  if (!baseURI) throw new Error("Missing document baseURI getter");
  const baseReads = vi
    .spyOn(window.Node.prototype, "baseURI", "get")
    .mockImplementation(() => baseURI.call(window.document));
  const post = vi.fn();
  const parent = { postMessage: post };
  Object.defineProperty(window, "parent", { value: parent });
  const source = readFileSync(new URL("../../emend/src/server/content/bridge.ts", import.meta.url), "utf8");
  try {
    let script: string = runInNewContext(`${source.replace("export const", "const")}; BRIDGE_SOURCE;`);
    if (options.captionNodes !== undefined) {
      // Exercise exhaustion with a small fixture; the shipped bridge keeps its million-node default.
      const declaration = "const captionBudget = { remaining: 1000000 };";
      if (!script.includes(declaration)) throw new Error("Missing caption budget declaration");
      script = script.replace(declaration, `const captionBudget = { remaining: ${options.captionNodes} };`);
    }
    runInNewContext(script, { window, document: window.document, Intl });
  } catch (error) {
    restoreMatchMedia();
    void window.happyDOM.close();
    throw error;
  }
  window.document.dispatchEvent(new window.Event("DOMContentLoaded"));
  const click = (selector: string | Element, options = {}, prevented = false) => {
    const image = typeof selector === "string" ? window.document.querySelector(selector) : selector;
    if (!image) throw new Error("Missing fixture image");
    const event = new window.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: 0,
      ...options,
    });
    if (prevented) event.preventDefault();
    image.dispatchEvent(event);
    return event;
  };
  const images = () => post.mock.calls.filter(([data]) => data.type === "emend:image").map(([data]) => data);
  const close = async () => {
    try {
      await window.happyDOM.close();
    } finally {
      restoreMatchMedia();
    }
  };
  return { window, post, click, images, baseReads, matchMedia, close };
}

test("image clicks report the page-order gallery and cleaned figure, alt and empty captions", async () => {
  const b = bridge(`<body>
    <figure><div><img id="first" src="../images/a%20%23%C3%A9.png?size=2#part" alt="Unused"></div>
      <figcaption> Caption\n <b>one</b>\u202e<script>hidden</script></figcaption></figure>
    <figure><img id="second" src="b.png" alt=" Alt\t two\u200b "><div><figcaption>Not direct</figcaption></div></figure>
    <img src="c.png">
    <figure><figcaption>Outer</figcaption><figure><img src="d.png" alt="Nearest"></figure></figure>
    <figure><img src="e.png" alt=" Empty caption fallback "><figcaption>\u200b\u202e </figcaption></figure>
    <template><img src="hidden.png"></template><noscript><img src="hidden.png"></noscript>
  </body>`);
  try {
    expect(b.click("#second").defaultPrevented).toBe(true);
    expect(b.images()).toEqual([
      {
        type: "emend:image",
        images: [
          { path: "images/a #é.png", caption: "Caption one" },
          { path: "docs/b.png", caption: "Alt two" },
          { path: "docs/c.png", caption: "" },
          { path: "docs/d.png", caption: "Nearest" },
          { path: "docs/e.png", caption: "Empty caption fallback" },
        ],
        index: 1,
      },
    ]);
  } finally {
    await b.close();
  }
});

test("gallery uses currentSrc, ignores loaded icons and broken or hidden images, and keeps pending images", async () => {
  const b = bridge(`<body>
    <img id="icon" src="icon.png" data-width="16" data-height="16">
    <img id="broken" src="broken.png" data-width="0" data-height="0">
    <img id="hidden" src="hidden.png" data-hidden>
    <img id="pending" src="pending.png" data-loading data-width="0" data-height="0">
    <img src="thin.png" data-width="16" data-height="48">
    <img src="fallback.png" data-current-src="${origin}${prefix}images/chosen.png">
  </body>`);
  try {
    for (const selector of ["#icon", "#broken", "#hidden"]) expect(b.click(selector).defaultPrevented).toBe(false);
    expect(b.images()).toEqual([]);
    b.click("#pending");
    expect(b.images()[0]).toMatchObject({
      index: 0,
      images: [
        { path: "docs/pending.png", caption: "" },
        { path: "docs/thin.png", caption: "" },
        { path: "images/chosen.png", caption: "" },
      ],
    });
  } finally {
    await b.close();
  }
});

test.each([
  "data:image/png;base64,AA==",
  "javascript:alert(1)",
  "https://example.com/image.png",
  "/elsewhere/image.png",
  `/content/${"z".repeat(75)}/image.png`,
  `${prefix}images//a.png`,
  `${prefix}images/a%2Fb.png`,
  `${prefix}images/a%5Cb.png`,
  `${prefix}images/a%00b.png`,
  `${prefix}images/a%C2%85b.png`,
  `${prefix}images/bad%.png`,
])("hostile or out-of-scope image %s is neither opened nor included", async (src) => {
  const b = bridge(`<body><img id="bad" src="${src}" onerror="alert(1)"><img id="good" src="good.png"></body>`);
  try {
    expect(b.click("#bad").defaultPrevented).toBe(false);
    expect(b.images()).toEqual([]);
    b.click("#good");
    expect(b.images()).toEqual([{ type: "emend:image", images: [{ path: "docs/good.png", caption: "" }], index: 0 }]);
  } finally {
    await b.close();
  }
});

test("image path decoding happens once and caption caps preserve well-formed text", async () => {
  const b =
    bridge(`<body><figure><img id="image" src="a%252Fb.png"><figcaption>${"x".repeat(1999)}🪴tail</figcaption></figure>
    <img src="alt.png" alt="${"x".repeat(1999)}🪴tail"><img src="malformed.png" alt="a\ud800b"></body>`);
  try {
    b.click("#image");
    expect(b.images()[0]?.images).toEqual([
      { path: "docs/a%2Fb.png", caption: "x".repeat(1999) },
      { path: "docs/alt.png", caption: "x".repeat(1999) },
      { path: "docs/malformed.png", caption: "a\ufffdb" },
    ]);
  } finally {
    await b.close();
  }
});

test.each([{}, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }])(
  "prevented and modified clicks leave image handling alone: %j",
  async (options) => {
    const b = bridge('<body><img src="image.png"></body>');
    try {
      b.click("img", options, Object.keys(options).length === 0);
      expect(b.images()).toEqual([]);
    } finally {
      await b.close();
    }
  },
);

test("linked images are excluded from a plain image's gallery", async () => {
  const b = bridge(`<body>
    <img id="first" src="first.png" alt="First">
    <a href="other.html"><span><img src="linked.png" alt="Linked"></span></a>
    <img id="second" src="second.png" alt="Second">
  </body>`);
  try {
    expect(b.click("#second").defaultPrevented).toBe(true);
    expect(b.images()).toEqual([
      {
        type: "emend:image",
        images: [
          { path: "docs/first.png", caption: "First" },
          { path: "docs/second.png", caption: "Second" },
        ],
        index: 1,
      },
    ]);
  } finally {
    await b.close();
  }
});

test.each(["#part", "other.html#part"])("linked images retain bridge navigation for %s", async (href) => {
  const b = bridge(`<body><a href="${href}"><img src="image.png"></a><h2 id="part">Part</h2></body>`);
  try {
    const scroll = vi.spyOn(b.window.Element.prototype, "scrollIntoView").mockImplementation(() => {});
    b.window.dispatchEvent(
      new b.window.MessageEvent("message", {
        source: b.window.parent,
        data: { type: "emend:docs", paths: ["docs/other.html"] },
      }),
    );
    expect(b.click("img").defaultPrevented).toBe(true);
    expect(b.images()).toEqual([]);
    if (href.startsWith("#")) expect(scroll).toHaveBeenCalled();
    else
      expect(b.post).toHaveBeenCalledWith({ type: "emend:navigate", path: "docs/other.html", fragment: "part" }, "*");
  } finally {
    await b.close();
  }
});

test("image DOM getters and methods cannot be replaced on elements", async () => {
  const b = bridge(
    `<body><figure><img data-current-src="${origin}${prefix}docs/image.png" alt="Alt"><figcaption>Caption</figcaption></figure></body>`,
  );
  const image = b.window.document.querySelector("img");
  if (!image) throw new Error("Missing image");
  const names = ["currentSrc", "src", "naturalWidth", "naturalHeight", "complete", "getAttribute", "checkVisibility"];
  try {
    for (const name of names) Object.defineProperty(image, name, { configurable: true, value: null });
    expect(b.click("img").defaultPrevented).toBe(true);
    expect(b.images()[0]?.images).toEqual([{ path: "docs/image.png", caption: "Caption" }]);
  } finally {
    for (const name of names) Reflect.deleteProperty(image, name);
    await b.close();
  }
});

test("gallery stops at 10000 images and ignores a clicked image outside that cap", async () => {
  const b = bridge(`<body>${'<img src="image.png">'.repeat(10001)}</body>`);
  try {
    b.baseReads.mockClear();
    expect(b.click("img:last-child").defaultPrevented).toBe(false);
    expect(b.images()).toEqual([]);
    expect(b.baseReads).toHaveBeenCalledTimes(1);
    expect(b.click("img").defaultPrevented).toBe(true);
    expect(b.images()[0]?.images).toHaveLength(10000);
    expect(b.baseReads).toHaveBeenCalledTimes(2);
  } finally {
    await b.close();
  }
});

function shadowGallery() {
  const b = bridge(`<body><img src="before.png"><div id="host">
    <img id="slotted" slot="photo" src="slotted.png"><img src="unassigned.png">
  </div><img src="after.png"></body>`);
  const doc = b.window.document;
  const host = doc.querySelector("#host");
  const slotted = doc.querySelector("#slotted");
  if (!host || !slotted) throw new Error("Missing shadow fixture");
  const root = host.attachShadow({ mode: "open" });
  const figure = doc.createElement("figure");
  const caption = doc.createElement("figcaption");
  caption.textContent = "Shadow caption";
  const image = (src: string) => {
    const node = doc.createElement("img");
    node.setAttribute("src", src);
    return node;
  };
  const first = image("shadow-first.png");
  const last = image("shadow-last.png");
  const slot = doc.createElement("slot");
  slot.name = "photo";
  slot.appendChild(image("replaced-fallback.png"));
  const empty = doc.createElement("slot");
  empty.name = "missing";
  empty.appendChild(image("fallback.png"));
  figure.append(caption, first, slot, empty, last);
  root.appendChild(figure);
  // happy-dom omits assignedSlot. Model the native getter for the slotted light image.
  vi.spyOn(
    b.window.Element.prototype as Element & { readonly assignedSlot: Element | null },
    "assignedSlot",
    "get",
  ).mockImplementation(function (this: Element) {
    return this === slotted ? slot : null;
  });
  return { ...b, host, root, figure, first, last, slotted, slot };
}

test("open shadow images and slotted light images form a gallery in flat-tree order", async () => {
  const b = shadowGallery();
  try {
    const event = new b.window.MouseEvent("click", { bubbles: true, cancelable: true, composed: true, button: 0 });
    // Model browser retargeting even when happy-dom exposes the internal image as target.
    Object.defineProperty(event, "target", { configurable: true, get: () => b.host });
    b.last.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(b.images()).toEqual([
      {
        type: "emend:image",
        images: [
          { path: "docs/before.png", caption: "" },
          { path: "docs/shadow-first.png", caption: "Shadow caption" },
          { path: "docs/slotted.png", caption: "Shadow caption" },
          { path: "docs/fallback.png", caption: "Shadow caption" },
          { path: "docs/shadow-last.png", caption: "Shadow caption" },
          { path: "docs/after.png", caption: "" },
        ],
        index: 4,
      },
    ]);
    b.click(b.slotted);
    expect(b.images()[1]).toMatchObject({ index: 2 });
  } finally {
    await b.close();
  }
});

test.each(["summary", "label", "button"])(
  "light-DOM images inside %s leave the control's default action intact",
  async (tag) => {
    const control = `<${tag}><span><img id="control" src="control.png"></span></${tag}>`;
    const b = bridge(
      `<body>${tag === "summary" ? `<details>${control}</details>` : control}<img id="plain" src="plain.png"></body>`,
    );
    try {
      expect(b.click("#control").defaultPrevented).toBe(false);
      expect(b.images()).toEqual([]);
      b.click("#plain");
      expect(b.images()).toEqual([
        { type: "emend:image", images: [{ path: "docs/plain.png", caption: "" }], index: 0 },
      ]);
    } finally {
      await b.close();
    }
  },
);

test("interactive ancestors follow slots and cross shadow hosts", async () => {
  const b = shadowGallery();
  try {
    const button = b.window.document.createElement("button");
    b.figure.insertBefore(button, b.slot);
    button.appendChild(b.slot);
    expect(b.click(b.slotted).defaultPrevented).toBe(false);
    expect(b.images()).toEqual([]);
    b.click(b.first);
    expect(b.images()[0]?.images.map((image: { path: string }) => image.path)).not.toContain("docs/slotted.png");
    b.post.mockClear();
    const label = b.window.document.createElement("label");
    b.host.before(label);
    label.appendChild(b.host);
    expect(b.click(b.first).defaultPrevented).toBe(false);
    expect(b.images()).toEqual([]);
    b.click("body > img");
    expect(b.images()[0]?.images).toEqual([
      { path: "docs/before.png", caption: "" },
      { path: "docs/after.png", caption: "" },
    ]);
  } finally {
    await b.close();
  }
});

test("CSS visibility and opacity exclude images only when the image visibility options are requested", async () => {
  const b = bridge(`<body>
    <img id="hidden" src="hidden.png" style="visibility: hidden">
    <img id="transparent" src="transparent.png" style="opacity: 0">
    <img id="visible" src="visible.png">
  </body>`);
  try {
    for (const selector of ["#hidden", "#transparent"]) {
      const image = b.window.document.querySelector(selector);
      if (!image) throw new Error("Missing hidden image");
      expect(b.window.Element.prototype.checkVisibility.call(image)).toBe(true);
      expect(b.click(selector).defaultPrevented).toBe(false);
    }
    expect(b.images()).toEqual([]);
    b.click("#visible");
    expect(b.images()[0]?.images).toEqual([{ path: "docs/visible.png", caption: "" }]);
    expect(b.window.Element.prototype.checkVisibility).toHaveBeenCalledWith({
      checkVisibilityCSS: true,
      visibilityProperty: true,
      opacityProperty: true,
    });
  } finally {
    await b.close();
  }
});

test.each([
  ["small.png 320w, large.png 1280w, medium.png 640w", "large.png"],
  ["small.png, large.png 2x, medium.png 1.5x", "large.png"],
  ["first.png 1x, bad.png invalid, large.png 3x", "first.png"],
  ["first.png 320w, mixed.png 2x", "first.png"],
  ["small.png .5x, large.png 2.e0x", "large.png"],
  ["small.png 1x, large.png 2e+0x", "large.png"],
])("pending srcset-only images choose the expected candidate from %s", async (srcset, expected) => {
  const b = bridge(`<head><base href="${prefix}images/"></head><body><img data-loading srcset="${srcset}"></body>`);
  try {
    expect(b.click("img").defaultPrevented).toBe(true);
    expect(b.images()[0]?.images).toEqual([{ path: `images/${expected}`, caption: "" }]);
  } finally {
    await b.close();
  }
});

test("pending pictures use window's own matchMedia to select the first matching raster source", async () => {
  const b = bridge(`<body><picture>
    <source media="(min-width: 10000px)" srcset="non-matching.png 2x">
    <source type="image/svg+xml" srcset="unsupported.svg 2x">
    <source media="(min-width: 1px)" type="image/webp" srcset="small.webp 320w, chosen.webp 1280w">
    <source srcset="later.png 3000w">
    <img data-loading srcset="own.png 2x" src="fallback.png">
    <source srcset="after.png 4000w">
  </picture></body>`);
  try {
    expect(Object.hasOwn(b.window, "matchMedia")).toBe(true);
    expect(b.window.Window.prototype.matchMedia).toBeUndefined();
    expect(b.click("img").defaultPrevented).toBe(true);
    expect(b.images()[0]?.images).toEqual([{ path: "docs/chosen.webp", caption: "" }]);
    expect(b.matchMedia).toHaveBeenCalledWith("(min-width: 10000px)");
    expect(b.matchMedia).toHaveBeenCalledWith("(min-width: 1px)");
  } finally {
    await b.close();
  }
});

test("pictures without a matching preceding source fall back to the image's own srcset or src", async () => {
  const b = bridge(`<body>
    <picture><source media="(min-width: 10000px)" srcset="other.png 2x">
      <img id="first" data-loading srcset="small.png 1x, own.png 2x" src="fallback.png">
      <source srcset="after.png 3x"></picture>
    <picture><source type="image/svg+xml" srcset="vector.svg"><img data-loading src="fallback.png"></picture>
  </body>`);
  try {
    b.click("#first");
    expect(b.images()[0]?.images).toEqual([
      { path: "docs/own.png", caption: "" },
      { path: "docs/fallback.png", caption: "" },
    ]);
  } finally {
    await b.close();
  }
});

test.each(["Shared caption", "\u200b\u202e "])(
  "a shared figure caption %j is cleaned once per gallery",
  async (caption) => {
    const b = bridge(
      `<body><figure><figcaption>${caption}</figcaption>${Array.from({ length: 100 }, (_, index) => `<img src="image.png" alt="Alt ${index}">`).join("")}</figure></body>`,
    );
    try {
      const text = b.window.document.querySelector("figcaption")?.firstChild;
      const data = Object.getOwnPropertyDescriptor(b.window.CharacterData.prototype, "data")?.get;
      if (!text || !data) throw new Error("Missing caption text getter");
      const reads = vi.spyOn(b.window.CharacterData.prototype, "data", "get").mockImplementation(function (
        this: unknown,
      ) {
        return data.call(this);
      });
      b.click("img");
      expect(b.images()[0]?.images).toHaveLength(100);
      expect(reads.mock.contexts.filter((node) => node === text)).toHaveLength(1);
      expect(b.images()[0]?.images[99].caption).toBe(caption === "Shared caption" ? caption : "Alt 99");
      b.click("img");
      expect(reads.mock.contexts.filter((node) => node === text)).toHaveLength(2);
    } finally {
      await b.close();
    }
  },
);

test("gallery stops at the total character budget and refuses a clicked image beyond it", async () => {
  const path = "docs/image.png";
  const caption = "x".repeat(2000 - path.length);
  const b = bridge(
    `<body><figure><figcaption>${caption}</figcaption>${'<img src="image.png">'.repeat(501)}</figure></body>`,
  );
  try {
    expect(b.click("img:last-child").defaultPrevented).toBe(false);
    expect(b.images()).toEqual([]);
    expect(b.click("img:nth-of-type(500)").defaultPrevented).toBe(true);
    const gallery = b.images()[0];
    expect(gallery?.images).toHaveLength(500);
    expect(gallery?.index).toBe(499);
    expect(
      gallery?.images.reduce(
        (total: number, image: { path: string; caption: string }) => total + image.path.length + image.caption.length,
        0,
      ),
    ).toBe(1_000_000);
  } finally {
    await b.close();
  }
});

test.each(["", " \t, ,, "])("empty source sets %j fall back to src or the next picture source", async (srcset) => {
  const b = bridge(`<body>
    <img id="plain" loading="lazy" data-loading srcset="${srcset}" src="photo.png">
    <picture><source srcset="${srcset}"><source srcset="b.png"><img data-loading src="c.png"></picture>
  </body>`);
  try {
    expect(b.click("#plain").defaultPrevented).toBe(true);
    expect(b.images()[0]?.images).toEqual([
      { path: "docs/photo.png", caption: "" },
      { path: "docs/b.png", caption: "" },
    ]);
  } finally {
    await b.close();
  }
});

test.each([
  { name: "source set at the limit", srcset: "large.png 2x".padEnd(16384, " "), expected: "large.png" },
  { name: "overlong source set", srcset: "large.png 2x".padEnd(16385, " "), expected: "fallback.png" },
  { name: "descriptor at the limit", srcset: `first.png 1x, large.png ${"0".repeat(30)}2x`, expected: "large.png" },
  { name: "overlong descriptor", srcset: `first.png 1x, large.png ${"0".repeat(31)}2x`, expected: "first.png" },
  { name: "long digit run", srcset: `first.png ${"9".repeat(12000)}x, large.png 2x`, expected: "first.png" },
  { name: "long trailing comma run", srcset: `first.png${",".repeat(12000)} tail.png 2x`, expected: "tail.png" },
  { name: "long internal comma run", srcset: `first.png${",".repeat(12000)}suffix, tail.png 2x`, expected: "tail.png" },
])("bounded responsive parsing handles $name", async ({ srcset, expected }) => {
  const b = bridge(`<body><img data-loading srcset="${srcset}" src="fallback.png"></body>`);
  try {
    expect(b.click("img").defaultPrevented).toBe(true);
    expect(b.images()[0]?.images).toEqual([{ path: `docs/${expected}`, caption: "" }]);
  } finally {
    await b.close();
  }
});

test("pictures skip overlong source sets before trying a later source", async () => {
  const b = bridge(`<body><picture>
    <source srcset="${"large.png 2x".padEnd(16385, " ")}"><source srcset="next.png">
    <img data-loading src="fallback.png">
  </picture></body>`);
  try {
    expect(b.click("img").defaultPrevented).toBe(true);
    expect(b.images()[0]?.images).toEqual([{ path: "docs/next.png", caption: "" }]);
  } finally {
    await b.close();
  }
});

test("nested figures share a caption node budget and later images fall back to alt", async () => {
  const inner = '<figure><img src="inner.png" alt="Inner alt"><figcaption>Inner</figcaption></figure>';
  const middle = `<figure><img src="middle.png" alt="Middle alt"><figcaption>Middle${inner}</figcaption></figure>`;
  const b = bridge(
    `<body><figure><img id="first" src="outer.png" alt="Outer alt"><figcaption>Outer${middle}</figcaption></figure><figure><img id="later" src="later.png" alt="Later alt"><figcaption id="later-caption">Later</figcaption></figure></body>`,
    { captionNodes: 12 },
  );
  try {
    const laterText = b.window.document.querySelector("#later-caption")?.firstChild;
    const reads = vi.spyOn(b.window.CharacterData.prototype, "data", "get");
    expect(b.click("#first").defaultPrevented).toBe(true);
    // The outer walk visits ten nodes. The middle walk spends the remaining two,
    // discards its partial text, and leaves both following captions unread.
    expect(b.images()[0]?.images).toEqual([
      { path: "docs/outer.png", caption: "OuterMiddleInner" },
      { path: "docs/middle.png", caption: "Middle alt" },
      { path: "docs/inner.png", caption: "Inner alt" },
      { path: "docs/later.png", caption: "Later alt" },
    ]);
    expect(reads).toHaveBeenCalledTimes(4);
    expect(reads.mock.contexts).not.toContain(laterText);
    expect(b.click("#later").defaultPrevented).toBe(true);
    expect(b.images()[1]).toEqual({ ...b.images()[0], index: 3 });
    expect(reads).toHaveBeenCalledTimes(8);
  } finally {
    await b.close();
  }
});

test("omitted caption nodes still consume the shared node budget", async () => {
  const b = bridge(
    '<body><figure><img src="image.png" alt="Alt"><figcaption><script>hidden</script><style>hidden</style><template>hidden</template>Caption</figcaption></figure></body>',
    { captionNodes: 4 },
  );
  try {
    expect(b.click("img").defaultPrevented).toBe(true);
    expect(b.images()[0]?.images).toEqual([{ path: "docs/image.png", caption: "Alt" }]);
  } finally {
    await b.close();
  }
});
