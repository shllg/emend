// @vitest-environment node
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { LIMITS } from "@emend/contract";
import {
  type Element,
  type HTMLDivElement,
  type HTMLElement,
  type HTMLSpanElement,
  type Node,
  type ShadowRoot,
  Window,
} from "happy-dom";
import { afterEach, expect, test, vi } from "vitest";
import { HTML_PART_TAGS, htmlPartTexts } from "../../../packages/core/src/html-parts.ts";
import { parseDocHtml } from "../../../packages/core/src/place/html.ts";
import { normalizeText } from "../../../packages/core/src/render/normalize.ts";

const corpus: { name: string; old: string; new: string }[] = JSON.parse(
  readFileSync(new URL("../../../packages/core/src/place/corpus/html.json", import.meta.url), "utf8"),
);
const source = readFileSync(new URL("../../emend/src/server/content/bridge.ts", import.meta.url), "utf8");
const script = runInNewContext(`${source.replace("export const", "const")}; BRIDGE_SOURCE;`);
const windows: Window[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const window of windows.splice(0)) await window.happyDOM.close();
});

function bridge(html: string) {
  const window = new Window({
    url: `http://127.0.0.1:3636/content/${"k".repeat(43)}${"a".repeat(32)}/docs/seed.html`,
    settings: { enableJavaScriptEvaluation: false },
  });
  windows.push(window);
  window.document.write(html);
  // Browser Node.textContent includes elements; happy-dom implements it on Element instead.
  const textContent = Object.getOwnPropertyDescriptor(window.Element.prototype, "textContent")?.get;
  if (!textContent) throw new Error("missing textContent getter");
  vi.spyOn(window.Node.prototype, "textContent", "get").mockImplementation(function (this: Element) {
    return textContent.call(this);
  });
  // happy-dom lacks assignedSlot; browsers return null for an unslotted element.
  if (!Object.getOwnPropertyDescriptor(window.Element.prototype, "assignedSlot"))
    Object.defineProperty(window.Element.prototype, "assignedSlot", { configurable: true, get: () => null });
  const post = vi.fn();
  const parent = { postMessage: post };
  Object.defineProperty(window, "parent", { value: parent });
  const shadows = vi.spyOn(window.Element.prototype, "attachShadow");
  const replaceSync = vi.spyOn(window.CSSStyleSheet.prototype, "replaceSync");
  runInNewContext(script, {
    window,
    document: window.document,
    CSSStyleSheet: window.CSSStyleSheet,
    // Message data in this harness comes from this realm, as it does after a browser's structured clone.
    Object,
    Intl,
  });
  window.document.dispatchEvent(new window.Event("DOMContentLoaded"));
  expect(post).toHaveBeenCalledWith({ type: "emend:ready" }, "*");
  const message = (data: unknown, sender: unknown = parent) =>
    window.dispatchEvent(new window.MessageEvent("message", { data, source: sender as Window }));
  const select = (element: Element) => {
    const range = window.document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    window.document.dispatchEvent(new window.Event("mouseup"));
    return post.mock.calls.findLast(([data]) => data.type === "emend:anchor")?.[0];
  };
  const marked = () => Array.from(window.document.querySelectorAll<HTMLElement>("[data-emend-changed]"));
  const labels = () => Array.from(window.document.querySelectorAll<HTMLDivElement>("[data-emend-changed-label]"));
  const labelSpan = (host: Element) => {
    const index = shadows.mock.instances.indexOf(host);
    const shadow: ShadowRoot | undefined = shadows.mock.results[index]?.value;
    return shadow?.querySelector<HTMLSpanElement>("span");
  };
  const labelText = (host: Element) => labelSpan(host)?.textContent;
  return { window, post, message, select, marked, labels, labelSpan, labelText, shadows, replaceSync };
}

const partTags = new Set(HTML_PART_TAGS);
function ownText(element: Element): string {
  const text: string[] = [];
  const visit = (node: Node) => {
    if (node.nodeType === 3) text.push(node.textContent);
    else if (node.nodeType === 1) {
      const child = node as Element;
      if (["script", "style", "template", "noscript"].includes(child.localName)) return;
      if (child.namespaceURI === "http://www.w3.org/1999/xhtml" && partTags.has(child.localName)) return;
      for (const descendant of child.childNodes) visit(descendant);
    }
  };
  for (const child of element.childNodes) visit(child);
  return normalizeText(text.join(""));
}

function expectMarkColors(b: ReturnType<typeof bridge>, colors: { line: string; background: string; text: string }) {
  const expected = b.window.document.createElement("span").style;
  expected.setProperty("box-shadow", `-3px 0 0 0 ${colors.line}`);
  expected.setProperty("background", colors.background);
  expected.setProperty("color", colors.text);
  for (const target of b.marked()) {
    expect(target.style.getPropertyValue("box-shadow")).toBe(expected.getPropertyValue("box-shadow"));
    expect(target.style.getPropertyPriority("box-shadow")).toBe("important");
  }
  for (const host of b.labels()) {
    const label = b.labelSpan(host);
    expect(label?.style.getPropertyValue("background")).toBe(expected.getPropertyValue("background"));
    expect(label?.style.getPropertyValue("color")).toBe(expected.getPropertyValue("color"));
  }
}

test.each([
  ...corpus.flatMap((entry) => [
    { name: `${entry.name} old`, html: entry.old },
    { name: `${entry.name} new`, html: entry.new },
  ]),
  { name: "nested own text", html: "<ul><li><p>First</p></li><li>Own<ul><li>Nested</li></ul> tail</li></ul>" },
  { name: "inline and body text", html: "Dropped<span>too</span><div>A <b>bold</b> bit</div><p> </p>" },
  { name: "parent starts first", html: "<section><p>Child</p>Parent tail</section><p>Cafe\u0301\u0085seed</p>" },
  { name: "FEFF-only part", html: "<p>&#xfeff;</p><p>Changed</p>" },
  { name: "FEFF with whitespace and leading FEFF", html: "<p> &#xfeff; </p><p>&#xfeff;Lead</p>" },
  { name: "table parts", html: "<table><caption>Caption</caption><tr><th>Head</th><td>Cell</td></tr></table>" },
  // SVG scripts stay in core tests: happy-dom drops following SVG nodes when script evaluation is disabled.
  { name: "foreign content", html: "<div>Own<svg><text> SVG</text></svg></div>" },
])("bridge parts match core: $name", ({ html }) => {
  const b = bridge(html);
  const expected = htmlPartTexts(parseDocHtml(html));
  b.message({
    type: "emend:changed",
    parts: expected.length,
    marks: expected.map((_, index) => ({ index, revision: 2 })),
  });
  expect(b.marked().map(ownText)).toEqual(expected);
});

test("changed paragraphs around a heading both receive marks", () => {
  const b = bridge("<p>Changed before</p><h2>Heading</h2><p>Changed after</p>");
  b.message({
    type: "emend:changed",
    parts: 3,
    marks: [
      { index: 0, revision: 2 },
      { index: 2, revision: 2 },
    ],
  });
  expect(b.marked().map(ownText)).toEqual(["Changed before", "Changed after"]);
  expect(b.labels().map(b.labelText)).toEqual(["Changed in rev 2", "Changed in rev 2"]);
});

test("every core part tag is marked in order, including inline text in a part", () => {
  const html =
    HTML_PART_TAGS.map((tag) => {
      const element = `<${tag}>Part ${tag}</${tag}>`;
      switch (tag) {
        case "li":
          return `<ul>${element}</ul>`;
        case "dt":
        case "dd":
          return `<dl>${element}</dl>`;
        case "td":
        case "th":
          return `<table><tbody><tr>${element}</tr></tbody></table>`;
        case "caption":
          return `<table>${element}</table>`;
        case "legend":
          return `<fieldset>${element}</fieldset>`;
        case "summary":
          return `<details>${element}</details>`;
        case "figcaption":
          return `<figure>${element}</figure>`;
        default:
          return element;
      }
    }).join("") + "<p>With <span>inline</span> <b>bold</b> <a>link</a></p>";
  const expected = htmlPartTexts(parseDocHtml(html));
  expect(expected).toEqual([...HTML_PART_TAGS.map((tag) => `Part ${tag}`), "With inline bold link"]);
  const b = bridge(html);
  b.message({
    type: "emend:changed",
    parts: expected.length,
    marks: expected.map((_, index) => ({ index, revision: 2 })),
  });
  expect(b.marked().map(ownText)).toEqual(expected);
});

test.each(["emend", "custom"])("%s pages mark changed and added paragraphs with isolated labels", (look) => {
  const b = bridge(
    `<meta name="emend-look" content="${look}"><p>Stable</p><p>Changed</p><p>Stable too</p><p>Added</p>`,
  );
  expect(b.marked()).toEqual([]);
  b.message({
    type: "emend:changed",
    parts: 4,
    marks: [
      { index: 1, revision: 2 },
      { index: 3, revision: 2 },
    ],
  });
  expect(b.marked().map(ownText)).toEqual(["Changed", "Added"]);
  expect(b.marked().map((element) => element.getAttribute("data-emend-changed"))).toEqual(["2", "2"]);
  expect(b.labels().map(b.labelText)).toEqual(["Changed in rev 2", "Changed in rev 2"]);
  for (const host of b.labels()) {
    expect(host.shadowRoot).toBeNull();
    expect(host.childNodes).toHaveLength(0);
    expect(host.parentNode?.firstChild).toBe(host);
    expect(host.style.getPropertyPriority("display")).toBe("important");
  }
  expect(b.shadows.mock.calls.every(([options]) => options.mode === "closed")).toBe(true);
  expectMarkColors(b, { line: "#8b5cf6", background: "#f5f3ff", text: "#6d28d9" });
  expect(b.replaceSync).not.toHaveBeenCalled();
});

test("doc CSS cannot override the fixed inline line or label styles", () => {
  const b = bridge(`<html data-theme="dark"><head><style>
    :root { --changed-line: transparent; --changed-bg: transparent; --changed-fg: transparent; }
    [data-emend-changed] { box-shadow: none !important; }
    [data-emend-changed-label] { display: none !important; }
    </style></head><body><p>Changed</p></body></html>`);
  b.message({ type: "emend:changed", parts: 1, marks: [{ index: 0, revision: 2 }] });
  expect(b.marked().map(ownText)).toEqual(["Changed"]);
  expect(b.labels().map(b.labelText)).toEqual(["Changed in rev 2"]);
  expectMarkColors(b, { line: "#8b5cf6", background: "#f5f3ff", text: "#6d28d9" });
  for (const host of b.labels()) {
    expect(host.style.getPropertyValue("all")).toBe("initial");
    expect(host.style.getPropertyPriority("all")).toBe("important");
    expect(host.style.getPropertyValue("display")).toBe("block");
    expect(host.style.getPropertyPriority("display")).toBe("important");
    expect(host.style.getPropertyPriority("margin")).toBe("important");
    expect(host.shadowRoot).toBeNull();
  }
  expect(b.window.document.adoptedStyleSheets).toEqual([]);
});

test.each(["", "important"])("clearing reapplied marks restores inline box-shadow (priority: %s)", (priority) => {
  const b = bridge(`<p style="box-shadow: 1px 2px 3px 4px #123456${priority ? " !important" : ""}">One</p><p>Two</p>`);
  const paragraphs = Array.from(b.window.document.querySelectorAll<HTMLElement>("p"));
  const before = paragraphs.map((element) => ({
    value: element.style.getPropertyValue("box-shadow"),
    priority: element.style.getPropertyPriority("box-shadow"),
  }));
  expect(before[0]?.value).not.toBe("");
  expect(before[0]?.priority).toBe(priority);
  for (const revision of [2, 3]) {
    b.message({ type: "emend:changed", parts: 2, marks: [0, 1].map((index) => ({ index, revision })) });
    expect(b.marked()).toEqual(paragraphs);
    expectMarkColors(b, { line: "#8b5cf6", background: "#f5f3ff", text: "#6d28d9" });
  }
  b.message({ type: "emend:changed", parts: 2, marks: [] });
  expect(b.marked()).toEqual([]);
  expect(b.labels()).toEqual([]);
  expect(
    paragraphs.map((element) => ({
      value: element.style.getPropertyValue("box-shadow"),
      priority: element.style.getPropertyPriority("box-shadow"),
    })),
  ).toEqual(before);
  expect(paragraphs[1]?.getAttribute("style") ?? "").not.toContain("box-shadow");
});

test.each([false, true])("marks follow valid theme messages (theme first: %s)", (themeFirst) => {
  const b = bridge("<p>Changed</p>");
  const dark = { type: "emend:theme", mode: "dark", scales: {}, tokens: {} };
  if (themeFirst) b.message(dark);
  b.message({ type: "emend:changed", parts: 1, marks: [{ index: 0, revision: 2 }] });
  expect(b.marked()).toHaveLength(1);
  expect(b.labels().map(b.labelText)).toEqual(["Changed in rev 2"]);
  if (!themeFirst) {
    expectMarkColors(b, { line: "#8b5cf6", background: "#f5f3ff", text: "#6d28d9" });
    b.message(dark);
  }
  expectMarkColors(b, { line: "#a78bfa", background: "rgba(139, 92, 246, 0.16)", text: "#c4b5fd" });
  const darkLabel = b.labels()[0];
  b.message({ ...dark, mode: "light", tokens: { bad: "url(x)" } });
  b.message({ ...dark, mode: "light" }, {});
  expect(b.labels()).toEqual([darkLabel]);
  expectMarkColors(b, { line: "#a78bfa", background: "rgba(139, 92, 246, 0.16)", text: "#c4b5fd" });
  b.message({ ...dark, mode: "light" });
  expectMarkColors(b, { line: "#8b5cf6", background: "#f5f3ff", text: "#6d28d9" });
  expect(b.labels().map(b.labelText)).toEqual(["Changed in rev 2"]);
  expect(darkLabel?.parentNode).toBeNull();
});

test("consecutive marks share a label only within the same revision", () => {
  const b = bridge("<p>One</p><p>Two</p><p>Three</p><p>Four</p><p>Five</p>");
  b.message({
    type: "emend:changed",
    parts: 5,
    marks: [
      { index: 0, revision: 2 },
      { index: 1, revision: 2 },
      { index: 2, revision: 3 },
      { index: 4, revision: 3 },
    ],
  });
  expect(b.marked()).toHaveLength(4);
  expect(b.labels().map(b.labelText)).toEqual(["Changed in rev 2", "Changed in rev 3", "Changed in rev 3"]);
});

test("new messages replace marks, empty marks and count mismatches clear them", () => {
  const b = bridge("<p>One</p><p>Two</p>");
  b.message({ type: "emend:changed", parts: 2, marks: [{ index: 0, revision: 2 }] });
  const oldLabel = b.labels()[0];
  b.message({ type: "emend:changed", parts: 2, marks: [{ index: 1, revision: 3 }] });
  expect(b.marked().map(ownText)).toEqual(["Two"]);
  expect(b.labels().map(b.labelText)).toEqual(["Changed in rev 3"]);
  expect(oldLabel?.parentNode).toBeNull();
  b.message({ type: "emend:changed", parts: 2, marks: [] });
  expect(b.marked()).toEqual([]);
  expect(b.labels()).toEqual([]);
  b.message({ type: "emend:changed", parts: 2, marks: [{ index: 0, revision: 2 }] });
  b.message({ type: "emend:changed", parts: 3, marks: [{ index: 2, revision: 3 }] });
  expect(b.marked()).toEqual([]);
  expect(b.labels()).toEqual([]);
  expect(b.window.document.adoptedStyleSheets).toHaveLength(0);
});

test("invalid messages and non-parent sources leave the previous marks untouched", () => {
  const b = bridge("<p>One</p><p>Two</p>");
  const good = { type: "emend:changed", parts: 2, marks: [{ index: 0, revision: 2 }] };
  b.message(good);
  const label = b.labels()[0];
  const bad = [
    { ...good, extra: true },
    { ...good, parts: -1 },
    { ...good, parts: 2.5 },
    { ...good, parts: LIMITS.htmlPartsPerDoc + 1 },
    { ...good, marks: {} },
    {
      ...good,
      marks: [
        { index: 1, revision: 3 },
        { index: 0, revision: 3 },
      ],
    },
    {
      ...good,
      marks: [
        { index: 0, revision: 3 },
        { index: 0, revision: 3 },
      ],
    },
    { ...good, marks: [{ index: 2, revision: 3 }] },
    { ...good, marks: [{ index: 0.5, revision: 3 }] },
    { ...good, marks: [{ index: 0, revision: 1.5 }] },
    { ...good, marks: [{ index: 0, revision: 0 }] },
    { ...good, marks: [{ index: 0, revision: Number.MAX_SAFE_INTEGER + 1 }] },
    { ...good, marks: [{ index: 0, revision: 3, extra: true }] },
    { ...good, marks: [Object.assign(new Date(), { index: 0, revision: 3 })] },
    { ...good, marks: [Object.assign(Object.create({ inherited: true }), { index: 0, revision: 3 })] },
    { ...good, marks: [null] },
    { ...good, marks: Array(1) },
    { ...good, marks: Array.from({ length: 3 }, (_, index) => ({ index, revision: 3 })) },
  ];
  for (const data of bad) {
    b.message(data);
    expect(b.marked().map(ownText)).toEqual(["One"]);
    expect(b.labels()).toEqual([label]);
  }
  b.message({ ...good, marks: [] }, {});
  expect(b.labels()).toEqual([label]);
});

test("label text never enters an anchor quote, including selection across parts", () => {
  const b = bridge("<p>First paragraph.</p> <p>Second paragraph.</p>");
  b.message({
    type: "emend:changed",
    parts: 2,
    marks: [
      { index: 0, revision: 2 },
      { index: 1, revision: 3 },
    ],
  });
  expect(b.labels().map(b.labelText)).toEqual(["Changed in rev 2", "Changed in rev 3"]);
  expect(b.select(b.window.document.body)).toEqual({
    type: "emend:anchor",
    quote: "First paragraph. Second paragraph.",
    prefix: "",
    suffix: "",
  });
});

test("hostile HTML remains inert while its static text receives marks", () => {
  const b = bridge(
    '<p>Safe<script>window.docRan = true</script><img src="x" onerror="window.docRan = true">' +
      '<a href="javascript:window.docRan=true"> link</a><svg onload="window.docRan=true"><text> SVG</text></svg></p>',
  );
  b.message({ type: "emend:changed", parts: 1, marks: [{ index: 0, revision: 2 }] });
  expect(b.marked().map(ownText)).toEqual(["Safe link SVG"]);
  expect(Reflect.get(b.window, "docRan")).toBeUndefined();
  expect(b.labels().map(b.labelText)).toEqual(["Changed in rev 2"]);
});

test("bridge cap matches the contract and over-nested documents expose no parts", () => {
  expect(script).toContain(`const HTML_PARTS_MAX = ${LIMITS.htmlPartsPerDoc};`);
  const b = bridge(Array.from({ length: LIMITS.htmlPartsPerDoc + 1 }, (_, index) => `<p>Part ${index}</p>`).join(""));
  b.message({
    type: "emend:changed",
    parts: LIMITS.htmlPartsPerDoc,
    marks: [{ index: LIMITS.htmlPartsPerDoc - 1, revision: 2 }],
  });
  expect(b.marked().map(ownText)).toEqual([`Part ${LIMITS.htmlPartsPerDoc - 1}`]);
  const deep = bridge(`${"<div>".repeat(513)}<p>Too deep</p>${"</div>".repeat(513)}`);
  deep.message({ type: "emend:changed", parts: 1, marks: [{ index: 0, revision: 2 }] });
  expect(deep.marked()).toEqual([]);
});

test("marks follow diagram hosts and return to the unchanged source pre when rendering fails", () => {
  const b = bridge('<pre class="mermaid">graph TD; A--&gt;B</pre><p>Stable</p>');
  const pre = b.window.document.querySelector("pre");
  if (!pre) throw new Error("missing diagram");
  const request = b.post.mock.calls.findLast(([data]) => data.type === "emend:diagrams")?.[0].request;
  expect(request).toBe(1);
  b.message({ type: "emend:changed", parts: 2, marks: [{ index: 0, revision: 2 }] });
  expect(b.marked()).toEqual([pre]);
  b.message({
    type: "emend:diagram",
    request,
    index: 0,
    svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    width: 100,
    height: 50,
  });
  const host = b.window.document.querySelector("[data-emend-diagram]");
  expect(host).not.toBeNull();
  expect(b.marked()).toEqual([host]);
  expect(host?.previousSibling).toBe(b.labels()[0]);
  expect(pre.textContent).toBe("graph TD; A-->B");
  b.message({ type: "emend:diagram", request, index: 0, svg: null });
  expect(b.marked()).toEqual([pre]);
  expect(pre.firstChild).toBe(b.labels()[0]);
  expect(pre.textContent).toBe("graph TD; A-->B");
});
