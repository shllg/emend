// @vitest-environment node
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { RepoUrl } from "@emend/contract";
import { type Range, Window } from "happy-dom";
import { afterEach, expect, test, vi } from "vitest";

const windows: Window[] = [];
afterEach(async () => {
  await Promise.all(windows.splice(0).map((window) => window.happyDOM.close()));
  vi.restoreAllMocks();
});

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing fixture value");
  return value;
}

function bridge(html: string) {
  const window = new Window({
    url: `http://127.0.0.1:3636/content/${"k".repeat(43)}${"a".repeat(32)}/docs/seed.html`,
    settings: {
      enableJavaScriptEvaluation: false,
      disableJavaScriptFileLoading: true,
      handleDisabledFileLoadingAsSuccess: true,
    },
  });
  windows.push(window);
  window.document.write(html);
  // Unlike browsers, happy-dom's Node baseURI getter cannot run on a Document.
  const baseURI = required(
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(window.Document.prototype), "baseURI")?.get,
  );
  vi.spyOn(window.Node.prototype, "baseURI", "get").mockImplementation(() => baseURI.call(window.document));
  const post = vi.fn();
  const parent = { postMessage: post };
  Object.defineProperty(window, "parent", { value: parent });
  const source = readFileSync(new URL("../../emend/src/server/content/bridge.ts", import.meta.url), "utf8");
  const script = runInNewContext(`${source.replace("export const", "const")}; BRIDGE_SOURCE;`);
  const highlights = new Map<string, { ranges: Range[] }>();
  Object.defineProperty(window, "HighlightRegistry", { value: Map });
  runInNewContext(script, {
    window,
    document: window.document,
    Node: window.Node,
    Range: window.Range,
    Intl,
    CSS: { highlights },
    Highlight: class {
      ranges: Range[];
      constructor(...ranges: Range[]) {
        this.ranges = ranges;
      }
    },
    CSSStyleSheet: window.CSSStyleSheet,
  });
  window.document.dispatchEvent(new window.Event("DOMContentLoaded"));
  const message = (data: unknown, source: unknown = parent) =>
    window.dispatchEvent(new window.MessageEvent("message", { data, source: source as Window }));
  return { window, post, highlights, message };
}

const repoUrl = "https://github.com/o/r";

test.each([repoUrl, "https://git.example.test:8443/Owner.name/repo_name-1"])(
  "the bridge links issue text with the checked repository URL %s without changing text",
  (url) => {
    expect(RepoUrl.safeParse(url).success).toBe(true);
    const b = bridge("<body><p>See #12, #1 and #9999999.</p></body>");
    const before = b.window.document.body.textContent;
    b.message({ type: "emend:repo", url });
    const links = [...b.window.document.querySelectorAll("a")];
    expect(links.map((link) => link.textContent)).toEqual(["#12", "#1", "#9999999"]);
    for (const [index, number] of [12, 1, 9999999].entries()) {
      const link = required(links[index]);
      expect(link.getAttribute("href")).toBe(`${url}/issues/${number}`);
      expect(link.getAttribute("rel")).toBe("noopener noreferrer nofollow");
      expect(link.getAttribute("target")).toBe("_blank");
    }
    expect(b.window.document.body.textContent).toBe(before);
  },
);

test.each([
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
  "script",
  "style",
  "template",
  "noscript",
])("issue text inside %s stays unchanged", (tag) => {
  const b = bridge(`<body><${tag}>#12</${tag}><p>#13</p></body>`);
  const before = b.window.document.body.textContent;
  b.message({ type: "emend:repo", url: repoUrl });
  expect(b.window.document.querySelectorAll("a[href]")).toHaveLength(1);
  expect(b.window.document.querySelector("a[href]")?.textContent).toBe("#13");
  expect(b.window.document.querySelector(tag)?.querySelector("a")).toBeNull();
  expect(b.window.document.body.textContent).toBe(before);
});

test("issue linking skips SVG, MathML, HTML nested in SVG, and shadow roots", () => {
  const b = bridge("<body><svg><text>#12</text><foreignObject></foreignObject></svg><div></div><p>#13</p></body>");
  // happy-dom's HTML parser recognizes SVG but does not enter the MathML namespace.
  const math = b.window.document.createElementNS("http://www.w3.org/1998/Math/MathML", "math");
  const mathText = b.window.document.createElementNS("http://www.w3.org/1998/Math/MathML", "mtext");
  mathText.textContent = "#12";
  math.appendChild(mathText);
  b.window.document.body.appendChild(math);
  const foreign = required(b.window.document.querySelector("foreignObject"));
  const paragraph = b.window.document.createElement("p");
  paragraph.textContent = "#12";
  foreign.appendChild(paragraph);
  const shadow = required(b.window.document.querySelector("div")).attachShadow({ mode: "open" });
  const shadowText = b.window.document.createElement("p");
  shadowText.textContent = "#12";
  shadow.appendChild(shadowText);
  b.message({ type: "emend:repo", url: repoUrl });
  expect(b.window.document.querySelectorAll("a")).toHaveLength(1);
  expect(b.window.document.querySelector("a")?.textContent).toBe("#13");
  expect(paragraph.textContent).toBe("#12");
  expect(shadow.querySelector("a")).toBeNull();
});

test("issue linking uses the core reference boundaries within each text node", () => {
  const b = bridge("<body><p>page#12 a&amp;#12 x/#12 #012 #12345678 #12a ##12 #0 #<span>12</span> #12</p></body>");
  const before = b.window.document.body.textContent;
  b.message({ type: "emend:repo", url: repoUrl });
  expect(b.window.document.querySelectorAll("a")).toHaveLength(1);
  expect(b.window.document.querySelector("a")?.textContent).toBe("#12");
  expect(b.window.document.body.textContent).toBe(before);
});

test("without a repository message issue references stay plain text", () => {
  const b = bridge("<body><p>#12</p></body>");
  expect(b.window.document.querySelector("a")).toBeNull();
});

test.each([
  "javascript:alert(1)",
  "http://github.com/o/r",
  "https://GitHub.com/o/r",
  "https://github.com/o/r/x",
  "https://github.com/o/r?x",
  "https://github.com/o/r#x",
  "https://user:pw@github.com/o/r",
  "https://github.com/../r",
  "https://github.com/o/.",
  "https://github.com:99999/o/r",
  "https://github.com/o/r\n",
  12,
  null,
])("an invalid repository URL %s is ignored without consuming the first valid message", (url) => {
  const b = bridge("<body><p>#12</p></body>");
  expect(RepoUrl.safeParse(url).success).toBe(false);
  b.message({ type: "emend:repo", url });
  expect(b.window.document.querySelector("a")).toBeNull();
  b.message({ type: "emend:repo", url: repoUrl });
  expect(b.window.document.querySelector("a")?.getAttribute("href")).toBe(`${repoUrl}/issues/12`);
});

test("only the first valid repository message from the parent links text", () => {
  const b = bridge("<body><p>#12</p></body>");
  b.message({ type: "emend:repo", url: repoUrl }, {});
  b.message({ type: "emend:repo", url: repoUrl, extra: true });
  expect(b.window.document.querySelector("a")).toBeNull();
  b.message({ type: "emend:repo", url: repoUrl });
  const link = required(b.window.document.querySelector("a"));
  b.message({ type: "emend:repo", url: "https://example.test/other/repo" });
  expect(b.window.document.querySelectorAll("a")).toHaveLength(1);
  expect(b.window.document.querySelector("a")).toBe(link);
  expect(link.getAttribute("href")).toBe(`${repoUrl}/issues/12`);
});

test("only bridge-created issue links post a number and prevent default navigation", () => {
  const b = bridge(`<body><p>#12</p><a href="${repoUrl}/issues/12">Authored link</a></body>`);
  b.message({ type: "emend:repo", url: repoUrl });
  const link = required(b.window.document.querySelector("p a"));
  const click = new b.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
  link.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(true);
  expect(b.post.mock.calls.filter(([data]) => data.type === "emend:issue")).toEqual([
    [{ type: "emend:issue", number: 12 }, "*"],
  ]);
  b.post.mockClear();
  let prevented: boolean | undefined;
  const authored = required(b.window.document.querySelector("body > a"));
  authored.addEventListener("click", (event) => {
    prevented = event.defaultPrevented;
    event.preventDefault();
  });
  authored.dispatchEvent(new b.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  expect(prevented).toBe(false);
  expect(b.post.mock.calls.filter(([data]) => data.type === "emend:issue")).toEqual([]);
});

test("linking rebuilds earlier highlights around the same quote", () => {
  const b = bridge("<body><p>See #12 and #34 today.</p></body>");
  const quote = "#12 and #34";
  b.message({ type: "emend:highlight", anchors: [{ threadId: "t", quote, prefix: "See ", suffix: " today." }] });
  const before = required(b.highlights.get("emend-quotes"));
  expect(required(before.ranges[0]).toString()).toBe(quote);
  b.message({ type: "emend:repo", url: repoUrl });
  const after = required(b.highlights.get("emend-quotes"));
  expect(after).not.toBe(before);
  expect(required(after.ranges[0]).toString()).toBe(quote);
  expect(b.window.document.querySelectorAll("a")).toHaveLength(2);
});

test("issue linking stops at the link cap and preserves remaining text", () => {
  const b = bridge(`<body><p>${"#12 ".repeat(10001)}</p></body>`);
  const before = b.window.document.body.textContent;
  b.message({ type: "emend:repo", url: repoUrl });
  expect(b.window.document.querySelectorAll("a")).toHaveLength(10000);
  expect(b.window.document.body.textContent).toBe(before);
});

test("issue linking stops at the visited-node cap", () => {
  const b = bridge(`<body>${"<!-- skipped -->".repeat(100000)}<p>#12</p></body>`);
  b.message({ type: "emend:repo", url: repoUrl });
  expect(b.window.document.querySelector("a")).toBeNull();
});
