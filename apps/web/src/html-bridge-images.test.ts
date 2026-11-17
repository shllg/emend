// @vitest-environment node
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { type Element, type HTMLImageElement, Window } from "happy-dom";
import { afterEach, expect, test, vi } from "vitest";

const prefix = `/content/${"k".repeat(43)}${"a".repeat(32)}/`;
const origin = "http://127.0.0.1:3636";
afterEach(() => vi.restoreAllMocks());
function bridge(html: string) {
  const window = new Window({
    url: `${origin}${prefix}docs/page.html`,
    settings: { enableJavaScriptEvaluation: false },
  });
  window.document.write(html);
  // happy-dom omits the native assignedSlot getter used by same-doc link scrolling.
  if (!Object.getOwnPropertyDescriptor(window.Element.prototype, "assignedSlot"))
    Object.defineProperty(window.Element.prototype, "assignedSlot", { configurable: true, get: () => null });
  const attr = (node: Element, name: string) => window.Element.prototype.getAttribute.call(node, name);
  vi.spyOn(window.Element.prototype, "checkVisibility").mockImplementation(function (this: Element) {
    return attr(this, "data-hidden") === null;
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
  vi.spyOn(window.Node.prototype, "baseURI", "get").mockImplementation(() => baseURI.call(window.document));
  const post = vi.fn();
  const parent = { postMessage: post };
  Object.defineProperty(window, "parent", { value: parent });
  const source = readFileSync(new URL("../../emend/src/server/content/bridge.ts", import.meta.url), "utf8");
  const script = runInNewContext(`${source.replace("export const", "const")}; BRIDGE_SOURCE;`);
  runInNewContext(script, { window, document: window.document, Intl });
  window.document.dispatchEvent(new window.Event("DOMContentLoaded"));
  const click = (selector: string, options = {}, prevented = false) => {
    const image = window.document.querySelector(selector);
    if (!image) throw new Error("Missing fixture image");
    const event = new window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...options });
    if (prevented) event.preventDefault();
    image.dispatchEvent(event);
    return event;
  };
  const images = () => post.mock.calls.filter(([data]) => data.type === "emend:image").map(([data]) => data);
  return { window, post, click, images, close: () => window.happyDOM.close() };
}

test("image clicks report the page-order gallery and cleaned figure, alt and empty captions", async () => {
  const b = bridge(`<body>
    <figure><div><img id="first" src="../images/a%20%23%C3%A9.png?size=2#part" alt="Unused"></div>
      <figcaption> Caption\n <b>one</b>\u202e<script>hidden</script></figcaption></figure>
    <figure><img id="second" src="b.png" alt=" Alt\t two\u200b "><div><figcaption>Not direct</figcaption></div></figure>
    <img src="c.png">
    <figure><figcaption>Outer</figcaption><figure><img src="d.png" alt="Nearest"></figure></figure>
    <figure><img src="e.png" alt="Unused"><figcaption></figcaption></figure>
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
          { path: "docs/e.png", caption: "" },
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
    expect(b.click("img:last-child").defaultPrevented).toBe(false);
    expect(b.images()).toEqual([]);
    expect(b.click("img").defaultPrevented).toBe(true);
    expect(b.images()[0]?.images).toHaveLength(10000);
  } finally {
    await b.close();
  }
});
