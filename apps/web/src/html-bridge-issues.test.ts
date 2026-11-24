// @vitest-environment node
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { RepoUrl } from "@recense/contract";
import { type Range, Window } from "happy-dom";
import { afterEach, expect, test, vi } from "vitest";
import type { HtmlRoot } from "../../../packages/core/src/render/blocks.ts";
import { linkIssueRefs } from "../../../packages/core/src/render/issue-refs.ts";

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
  const source = readFileSync(new URL("../../recense/src/server/content/bridge.ts", import.meta.url), "utf8");
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

test.each([
  repoUrl,
  "https://git.example.test:8443/Owner.name/repo_name-1",
  "HTTPS://github.com/o/r",
  "Https://git.example.test:443/Owner.name/repo_name-1",
])("the bridge links issue text with the checked repository URL %s without changing text", (url) => {
  expect(RepoUrl.safeParse(url).success).toBe(true);
  const b = bridge("<body><p>See #12, #1 and #9999999.</p></body>");
  const before = b.window.document.body.textContent;
  b.message({ type: "recense:repo", url });
  const links = [...b.window.document.querySelectorAll("a")];
  expect(links.map((link) => link.textContent)).toEqual(["#12", "#1", "#9999999"]);
  for (const [index, number] of [12, 1, 9999999].entries()) {
    const link = required(links[index]);
    expect(link.getAttribute("href")).toBe(new URL(`${url}/issues/${number}`).href);
    expect(link.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    expect(link.getAttribute("target")).toBe("_blank");
  }
  expect(b.window.document.body.textContent).toBe(before);
});

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
  b.message({ type: "recense:repo", url: repoUrl });
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
  b.message({ type: "recense:repo", url: repoUrl });
  expect(b.window.document.querySelectorAll("a")).toHaveLength(1);
  expect(b.window.document.querySelector("a")?.textContent).toBe("#13");
  expect(paragraph.textContent).toBe("#12");
  expect(shadow.querySelector("a")).toBeNull();
});

test("issue linking uses the core reference boundaries within each text node", () => {
  const b = bridge("<body><p>page#12 a&amp;#12 x/#12 #012 #12345678 #12a ##12 #0 #<span>12</span> #12</p></body>");
  const before = b.window.document.body.textContent;
  b.message({ type: "recense:repo", url: repoUrl });
  expect(b.window.document.querySelectorAll("a")).toHaveLength(1);
  expect(b.window.document.querySelector("a")?.textContent).toBe("#12");
  expect(b.window.document.body.textContent).toBe(before);
});

const referenceSamples = [
  "page#12",
  "a&#12",
  "x/#12",
  "#012",
  "#12345678",
  "#12a",
  "##12",
  "#0",
  "#",
  "#1",
  "#12",
  "#123",
  "#1234",
  "#12345",
  "#123456",
  "#1234567",
  "#9999999",
  "#10000000",
  "#1#2",
  "(#12), [#34]; #56!",
  "\"#12\" '#34' —#56.",
  "é#12",
  "#12é",
  "漢#12",
  "#12字",
  "_#12 #12_",
  "#12\n#34\t#56",
  "Before #12 and #34 after.",
];

test.each(referenceSamples)("bridge reference links match core for %s", (value) => {
  const transform = linkIssueRefs();
  const tree: HtmlRoot = { type: "root", children: [{ type: "text", value }] };
  const file = { data: { repoUrl } } as unknown as Parameters<typeof transform>[1];
  transform(tree, file, () => {});
  const expected = tree.children.flatMap((node) =>
    node.type === "element" && node.tagName === "a"
      ? [
          {
            text: node.children.map((child) => (child.type === "text" ? child.value : "")).join(""),
            href: node.properties.href,
          },
        ]
      : [],
  );
  const b = bridge("<body><p></p></body>");
  required(b.window.document.querySelector("p")).textContent = value;
  b.message({ type: "recense:repo", url: repoUrl });
  expect(
    [...b.window.document.querySelectorAll("a")].map((link) => ({
      text: link.textContent,
      href: link.getAttribute("href"),
    })),
  ).toEqual(expected);
  expect(b.window.document.body.textContent).toBe(value);
});

test("without a repository message issue references stay plain text", () => {
  const b = bridge("<body><p>#12</p></body>");
  expect(b.window.document.querySelector("a")).toBeNull();
});

const repoUrlCandidates = [
  repoUrl,
  "https://git.example.test:8443/Owner.name/repo_name-1",
  "https://git.example.test:443/o/r",
  "https://git.example.test:0/o/r",
  "https://git.example.test:65535/o/r",
  "https://git-host.example.test/owner-name/repo-name",
  "https://example.test/owner_name/repo_name",
  "https://example.test/owner.name/repo.name",
  "https://example.test/.owner/_repo",
  "HTTPS://github.com/o/r",
  "Https://git.example.test:443/Owner.name/repo_name-1",
  `https://example.test/o/${"r".repeat(2048 - "https://example.test/o/".length)}`,
  "javascript:alert(1)",
  "http://github.com/o/r",
  "https://GitHub.com/o/r",
  "HTTPS://GitHub.com/o/r",
  "https://github.com/o/r/x",
  "https://github.com/o/r/",
  "https://github.com/o",
  "https://github.com//r",
  "https://github.com/o/r?x",
  "https://github.com/o/r?",
  "https://github.com/o/r#x",
  "https://github.com/o/r#",
  "https://user:pw@github.com/o/r",
  "https://user@github.com/o/r",
  "https:///o/r",
  "https://github.com/./r",
  "https://github.com/../r",
  "https://github.com/o/.",
  "https://github.com/o/..",
  "https://github.com/%6f/r",
  "https://github.com/o/r%2fmore",
  "https://git_host.example.test/o/r",
  "https://-host.example.test/o/r",
  "https://example.test./o/r",
  "https://github.com:123456/o/r",
  "https://github.com:99999/o/r",
  " https://github.com/o/r",
  "https://github.com/o/r ",
  "https://github.com/o/r\t",
  "https://github.com/o/r\n",
  "https://github.com/o/r\u0000",
  "https://github.com/o/r\u0085",
  "https://github.com/o/r\u200b",
  "https://github.com/o/r\u200d",
  `https://example.test/o/${"r".repeat(2049 - "https://example.test/o/".length)}`,
  12,
  null,
];

test.each(repoUrlCandidates)("bridge repository URL acceptance matches RepoUrl for %s", (url) => {
  const b = bridge("<body><p>#12</p></body>");
  const checked = RepoUrl.safeParse(url);
  b.message({ type: "recense:repo", url });
  const links = [...b.window.document.querySelectorAll("a")];
  expect(links).toHaveLength(checked.success ? 1 : 0);
  if (checked.success) {
    expect(required(links[0]).getAttribute("href")).toBe(new URL(`${checked.data}/issues/12`).href);
  } else {
    b.message({ type: "recense:repo", url: repoUrl });
    expect(b.window.document.querySelector("a")?.getAttribute("href")).toBe(`${repoUrl}/issues/12`);
  }
  expect(b.window.document.body.textContent).toBe("#12");
});

test("only the first valid repository message from the parent links text", () => {
  const b = bridge("<body><p>#12</p></body>");
  b.message({ type: "recense:repo", url: repoUrl }, {});
  b.message({ type: "recense:repo", url: repoUrl, extra: true });
  expect(b.window.document.querySelector("a")).toBeNull();
  b.message({ type: "recense:repo", url: repoUrl });
  const link = required(b.window.document.querySelector("a"));
  b.message({ type: "recense:repo", url: "https://example.test/other/repo" });
  expect(b.window.document.querySelectorAll("a")).toHaveLength(1);
  expect(b.window.document.querySelector("a")).toBe(link);
  expect(link.getAttribute("href")).toBe(`${repoUrl}/issues/12`);
});

test("only bridge-created issue links post a number and prevent default navigation", () => {
  const b = bridge(`<body><p>#12</p><a href="${repoUrl}/issues/12">Authored link</a></body>`);
  b.message({ type: "recense:repo", url: repoUrl });
  const link = required(b.window.document.querySelector("p a"));
  const click = new b.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
  link.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(true);
  expect(b.post.mock.calls.filter(([data]) => data.type === "recense:issue")).toEqual([
    [{ type: "recense:issue", number: 12 }, "*"],
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
  expect(b.post.mock.calls.filter(([data]) => data.type === "recense:issue")).toEqual([]);
});

const issueClicks = [
  { name: "Ctrl click", type: "click", init: { button: 0, ctrlKey: true } },
  { name: "Meta click", type: "click", init: { button: 0, metaKey: true } },
  { name: "Shift click", type: "click", init: { button: 0, shiftKey: true } },
  { name: "Alt click", type: "click", init: { button: 0, altKey: true } },
  { name: "middle click", type: "auxclick", init: { button: 1 } },
];

test.each(issueClicks)("$name on a bridge issue link posts once and prevents default", ({ type, init }) => {
  const b = bridge("<body><p>#12</p></body>");
  b.message({ type: "recense:repo", url: repoUrl });
  b.post.mockClear();
  const event = new b.window.MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  required(b.window.document.querySelector("a")).dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(b.post.mock.calls).toEqual([[{ type: "recense:issue", number: 12 }, "*"]]);
});

test.each(issueClicks)("$name on an authored link is not handled by the bridge", ({ type, init }) => {
  const b = bridge(`<body><a href="${repoUrl}/issues/12">Authored link</a></body>`);
  b.message({ type: "recense:repo", url: repoUrl });
  b.post.mockClear();
  const link = required(b.window.document.querySelector("a"));
  let prevented: boolean | undefined;
  link.addEventListener(type, (event) => {
    prevented = event.defaultPrevented;
    event.preventDefault();
  });
  link.dispatchEvent(new b.window.MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
  expect(prevented).toBe(false);
  expect(b.post).not.toHaveBeenCalled();
});

test("a right-button auxclick is ignored on bridge and authored links", () => {
  const b = bridge(`<body><p>#12</p><a href="${repoUrl}/issues/12">Authored link</a></body>`);
  b.message({ type: "recense:repo", url: repoUrl });
  b.post.mockClear();
  for (const link of b.window.document.querySelectorAll("a")) {
    const event = new b.window.MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 2 });
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  }
  expect(b.post).not.toHaveBeenCalled();
});

test.each(issueClicks)("an already prevented $name does not post an issue", ({ type, init }) => {
  const b = bridge("<body><p>#12</p></body>");
  b.message({ type: "recense:repo", url: repoUrl });
  b.post.mockClear();
  const event = new b.window.MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  event.preventDefault();
  required(b.window.document.querySelector("a")).dispatchEvent(event);
  expect(b.post).not.toHaveBeenCalled();
});

test("linking rebuilds earlier highlights around the same quote", () => {
  const b = bridge("<body><p>See #12 and #34 today.</p></body>");
  const quote = "#12 and #34";
  b.message({ type: "recense:highlight", anchors: [{ threadId: "t", quote, prefix: "See ", suffix: " today." }] });
  const before = required(b.highlights.get("recense-quotes"));
  expect(required(before.ranges[0]).toString()).toBe(quote);
  b.message({ type: "recense:repo", url: repoUrl });
  const after = required(b.highlights.get("recense-quotes"));
  expect(after).not.toBe(before);
  expect(required(after.ranges[0]).toString()).toBe(quote);
  expect(b.window.document.querySelectorAll("a")).toHaveLength(2);
});

test("a megabyte text node with 10000 references is replaced once without splitting", () => {
  const value = `${"x".repeat(100)} #12 `.repeat(10000);
  expect(value.length).toBeGreaterThanOrEqual(1024 * 1024);
  const b = bridge(`<body><p>${value}</p></body>`);
  const paragraph = required(b.window.document.querySelector("p"));
  expect(paragraph.childNodes).toHaveLength(1);
  const original = required(paragraph.firstChild);
  const before = b.window.document.body.textContent;
  const split = vi.spyOn(b.window.Text.prototype, "splitText");
  const replace = vi.spyOn(b.window.Node.prototype, "replaceChild");
  const observer = new b.window.MutationObserver(() => {});
  observer.observe(b.window.document.body, { subtree: true, childList: true });
  b.message({ type: "recense:repo", url: repoUrl });
  const records = observer.takeRecords();
  observer.disconnect();
  expect(split).not.toHaveBeenCalled();
  expect(replace).toHaveBeenCalledExactlyOnceWith(expect.any(b.window.DocumentFragment), original);
  expect(replace.mock.contexts).toEqual([paragraph]);
  // happy-dom reports each fragment insertion separately; browsers report one replacement record.
  // Check the single replacement call above and every observed addition/removal without coalescing records.
  expect(records.length).toBeGreaterThan(0);
  expect(records.every((record) => record.type === "childList" && record.target === paragraph)).toBe(true);
  expect(records.flatMap((record) => [...record.removedNodes])).toEqual([original]);
  expect(records.flatMap((record) => [...record.addedNodes])).toEqual([...paragraph.childNodes]);
  expect(paragraph.querySelectorAll("a")).toHaveLength(10000);
  expect(b.window.document.body.textContent).toBe(before);
});

test("issue linking stops at the link cap and preserves remaining text", () => {
  const b = bridge(`<body><p>${"#12 ".repeat(10001)}</p></body>`);
  const before = b.window.document.body.textContent;
  b.message({ type: "recense:repo", url: repoUrl });
  expect(b.window.document.querySelectorAll("a")).toHaveLength(10000);
  expect(b.window.document.body.textContent).toBe(before);
});

test("the link cap is shared across text nodes and leaves the remaining suffix plain", () => {
  const b = bridge(`<body><p>${"#12 ".repeat(9999)}</p><p>#34 #56 tail</p><p>#78</p></body>`);
  const before = b.window.document.body.textContent;
  b.message({ type: "recense:repo", url: repoUrl });
  const paragraphs = b.window.document.querySelectorAll("p");
  expect(required(paragraphs[0]).querySelectorAll("a")).toHaveLength(9999);
  const second = required(paragraphs[1]);
  expect(second.querySelectorAll("a")).toHaveLength(1);
  expect(second.querySelector("a")?.textContent).toBe("#34");
  expect(second.lastChild?.nodeType).toBe(b.window.Node.TEXT_NODE);
  expect(second.lastChild?.textContent).toBe(" #56 tail");
  expect(required(paragraphs[2]).querySelector("a")).toBeNull();
  expect(b.window.document.body.textContent).toBe(before);
});

test("issue linking stops at the visited-node cap", () => {
  const b = bridge(`<body>${"<!-- skipped -->".repeat(100000)}<p>#12</p></body>`);
  b.message({ type: "recense:repo", url: repoUrl });
  expect(b.window.document.querySelector("a")).toBeNull();
});
