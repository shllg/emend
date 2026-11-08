// remark is not GitHub's renderer (cmark-gfm plus extensions such as math, emoji
// shortcodes and alerts). Those need raw checker rules of their own; this oracle
// covers CommonMark and GFM structure only, without contacting a renderer service.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { hiddenMarkdownReason } from "./markdown.ts";

// Only this test borrows core's installed parser; bin/wt stays dependency-free.
// createRequire resolves with the require condition, which works because these
// packages export a plain default rather than different import/require entries.
const coreRequire = createRequire(new URL("../../../packages/core/package.json", import.meta.url));
async function loadParser(resolve: (name: string) => string = coreRequire.resolve) {
  try {
    const [{ unified }, { default: remarkParse }, { default: remarkGfm }] = await Promise.all(
      ["unified", "remark-parse", "remark-gfm"].map((name) => import(pathToFileURL(resolve(name)).href)),
    );
    return unified().use(remarkParse).use(remarkGfm);
  } catch (error) {
    if (["MODULE_NOT_FOUND", "ERR_MODULE_NOT_FOUND"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw new Error("run pnpm install: this test borrows packages/core's remark parser", { cause: error });
    }
    throw error;
  }
}
const parser = await loadParser();

interface Node {
  type: string;
  value?: string;
  children?: Node[];
  position?: { start: { offset: number }; end: { offset: number } };
  url?: string;
  title?: string | null;
  alt?: string | null;
  lang?: string | null;
  meta?: string | null;
  ordered?: boolean;
  start?: number | null;
  checked?: boolean | null;
}

const forbidden = new Set([
  "html",
  "definition",
  "footnoteDefinition",
  "footnoteReference",
  "linkReference",
  "imageReference",
  "table",
  "tableRow",
  "tableCell",
  "yaml",
  "math",
  "inlineMath",
]);
// Kept independent of the checker so expanding an exemption cannot bless itself.
const languages =
  "text plaintext console sh bash shell zsh diff json jsonc yaml yml toml ini md markdown ts typescript tsx js javascript jsx mjs css html xml sql python py ruby rb go rust rs http".split(
    " ",
  );
const asset = "https://github.com/user-attachments/assets/01234567-89ab-cdef-0123-456789abcdef";
const screenshot = (alt: string, url = asset) => `![${alt}](${url})`;
const imageLine =
  /^!\[([^\]\r\n]*)\]\(https:\/\/github\.com\/user-attachments\/assets\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\)$/u;
const lettersAndDigits = (text: string) => text.match(/[\p{L}\p{N}]/gu)?.join("") ?? "";

/**
 * Every source letter/number the tree does not show must be determined by what
 * it does show, subject to the two bounded allowances below. Compare Unicode
 * letters/numbers in order and count after these
 * AST-positioned deductions: list digits must be the rendered start + item index
 * or use the marker-1 allowance, with no leading zero; a loaded screenshot's unseen
 * alt must be empty, Screenshot, or Screenshot <its 1-based screenshot-line
 * ordinal>. The exact approved image envelope is excluded, never arbitrary URLs.
 * A checked item's visible check mark contributes the canonical source x; X is
 * refused in that position, while literal a[X] remains text. Screenshots and list
 * markers inside code keep their source letters rather than these deductions.
 * The first allowance: a fenced code block may hide its one allowlisted info
 * word. Inside a quote or list item this holds even when empty, because the code
 * box stays visible and the word comes from the fixed allowlist. The tree and
 * parser position identify the container and opener's prefix. Top-level fences,
 * including those with up to three leading spaces, need non-whitespace content;
 * an empty fence without an info word hides no letters or digits.
 * The second allowance: an ordered marker may be 1 even when the page shows n.
 * The hidden digits are only 1s, at most one per marker, and after the first such
 * 1 a run accepts only 1s, so they cannot spell anything.
 * Visible text is text/inlineCode/code values and literal autolink text, plus
 * canonical checked state. Whitespace and punctuation are outside this invariant.
 */
function checkCoverage(body: string): void {
  const root: Node = parser.parse(body);
  const omitted: [number, number][] = [];
  const visible: string[] = [];
  const screenshotOrdinals = new Map<number, number>();
  let lineOffset = 0;
  for (const line of body.split("\n")) {
    const raw = line.replace(/\r$/u, "");
    const match = imageLine.exec(raw);
    if (match?.[0] === raw) screenshotOrdinals.set(lineOffset, screenshotOrdinals.size + 1);
    lineOffset += line.length + 1;
  }
  const source = (node: Node) => {
    assert.ok(node.position, "parser positions are required");
    return body.slice(node.position.start.offset, node.position.end.offset);
  };
  function visit(node: Node, parent?: Node, index = 0): void {
    assert.ok(!forbidden.has(node.type), `forbidden ${node.type}`);
    if (node.type === "link") {
      const text = (node.children ?? []).map((child) => child.value ?? "").join("");
      assert.ok(
        node.children?.every((child) => child.type === "text"),
        "autolink children",
      );
      // GFM's post-parse autolink transform can synthesize positionless nodes.
      // Explicit CommonMark links retain positions and must be literal too.
      if (node.position) assert.equal(source(node), text, "literal autolink source");
      assert.ok(!node.title, "autolink title");
      // The fallback transform can leave a trailing dot outside a bare `www.`
      // link. A `www.` email local part still gets mailto, not an HTTP prefix.
      const www = /^www(?:\.|$)/iu.test(text);
      const url = node.url === `mailto:${text}` ? `mailto:${text}` : www ? `http://${text}` : text;
      assert.ok(/^https?:\/\//iu.test(text) || www || node.url === `mailto:${text}`, "literal autolink form");
      assert.equal(node.url, url, "autolink destination must be visible");
    }
    if (node.type === "image") {
      const raw = source(node);
      const match = imageLine.exec(raw);
      assert.ok(match && match[0] === raw, "screenshot form and alt");
      assert.ok(node.position, "screenshot position");
      const { start, end } = node.position;
      const ordinal = screenshotOrdinals.get(start.offset);
      assert.ok(ordinal, "screenshot line ordinal");
      assert.ok(["", "Screenshot", `Screenshot ${ordinal}`].includes(node.alt ?? ""), "determined screenshot alt");
      assert.ok(start.offset === 0 || body[start.offset - 1] === "\n", "whole screenshot line start");
      assert.ok(end.offset === body.length || /^(?:\r?\n)/u.test(body.slice(end.offset)), "whole screenshot line end");
      assert.equal(node.alt, match[1], "screenshot alt must be literal");
      assert.equal(node.url, raw.slice(raw.indexOf("](") + 2, -1), "screenshot destination");
      assert.ok(!node.title, "screenshot title");
      omitted.push([start.offset, end.offset]);
    }
    if (node.type === "code") {
      const raw = source(node);
      assert.ok(!node.meta, "code meta must be empty");
      assert.ok(!node.lang || languages.includes(node.lang.toLowerCase()), "code language must be allowlisted");
      if (node.lang) {
        const opening = /^[ \t]*(?:`{3,}|~{3,})[ \t]*([A-Za-z]+)[ \t]*(?:\r?\n|$)/u.exec(raw);
        assert.ok(opening, "fence info source");
        assert.equal(opening[1], node.lang, "literal fence language");
        assert.ok(node.position, "fence position");
        const fenceStart = node.position.start.offset + opening[0].search(/[`~]/u);
        const lineStart = body.lastIndexOf("\n", fenceStart - 1) + 1;
        const containerPrefix = body.slice(lineStart, fenceStart);
        const inContainer = parent?.type === "blockquote" || parent?.type === "listItem";
        assert.ok(
          node.value?.trim() || (inContainer && /[\s>]/u.test(containerPrefix)),
          "non-empty top-level fenced code block",
        );
        const start = node.position.start.offset + opening[0].indexOf(node.lang);
        omitted.push([start, start + node.lang.length]);
      }
    }
    if (node.type === "listItem" && parent?.ordered) {
      const marker = /^(\d{1,9})[.)](?:[ \t\r\n]|$)/u.exec(source(node));
      assert.ok(marker?.[1], "ordered marker source");
      assert.match(marker[1], /^[1-9]\d{0,8}$/u, "canonical list number");
      assert.ok(marker[1] === "1" || Number(marker[1]) === (parent.start ?? 1) + index, "rendered list number");
      assert.ok(node.position, "list marker position");
      omitted.push([node.position.start.offset, node.position.start.offset + marker[1].length]);
    }
    if (node.type === "listItem" && node.checked === true) {
      // Continuation lines can retain outer blockquote prefixes in this span.
      const marker = /^(?:[-+*]|\d{1,9}[.)])[ \t\r\n>]*\[([xX])\]/u.exec(source(node));
      assert.ok(marker, "checked task marker source");
      assert.equal(marker[1], "x", "canonical task marker");
      assert.ok(node.position, "checked task marker position");
      const start = node.position.start.offset + marker[0].length - 2;
      visible.push(body.slice(start, start + 1));
    }
    if (["text", "inlineCode", "code"].includes(node.type)) visible.push(node.value ?? "");
    for (const [childIndex, child] of (node.children ?? []).entries()) visit(child, node, childIndex);
  }
  visit(root);
  omitted.sort(([a], [b]) => a - b);
  let offset = 0;
  const expected: string[] = [];
  for (const [start, end] of omitted) {
    assert.ok(start >= offset, "coverage exclusions must not overlap");
    expected.push(body.slice(offset, start));
    offset = end;
  }
  expected.push(body.slice(offset));
  assert.equal(lettersAndDigits(visible.join("")), lettersAndDigits(expected.join("")), "visible-text coverage");
}

const hostile = [
  ["link destination", "[abc](def)"],
  ["alt text", screenshot("Hidden")],
  ["alt text", screenshot("Screenshot 99")],
  ["reference definition", "[abc]: def"],
  ["character reference", "&amp;"],
  ["table", "| a |\n| - |\n| a | HIDDEN |"],
  ["raw HTML", "<!-- hidden -->"],
  ["fence info", "```hidden\ncode\n```"],
  ["list number", "1. a\n9. b"],
  ["list number", "00001. a"],
  ["list number", "- 1. a\n- 1. b\n  3. c"],
  ["list number", "a\n2. b\n1. c\n4. d"],
  ["list number", "1.\n1.\n2."],
  ["list number", "- 00000001. x"],
  ["list number", "1. 007. x"],
  ["list number", "> - 0009. x"],
  ["list number", "- 0."],
  ["list number", "1. 01) a"],
  ["list number", "* 011. "],
  ["list number", "+ 01. x"],
  ["task marker", "- [X] done"],
  ["task marker", "> -\n >   [X] done"],
  ["task marker", "> -\n>\t[X] done"],
  ["task marker", "-\n[x] e"],
  ["empty code block", "```go\n```"],
  ["empty code block", "```ts\n\n```"],
  ["empty code block", "> outside\n\n```ts\n```"],
  ["empty code block", " ```go\n ``` "],
  ["empty code block", "   ```go\n   ``` "],
  ["empty code block", "   ```ts"],
] as const;

const containerFences = [
  ">```ts\ne",
  ">```ts\n\n>a",
  ">```ts\n    >a",
  "1. a\n   ```ts\ncode",
  "- ```ts\ne",
  ">> ```ts\n> code",
  ">   ```ts\n> code",
  "- > ```ts\n> code",
  "> ~~~go\n>    ~~~~",
  "> ```go\n>    ````",
  ">> ~~~go\n>>    ~~~~",
  "- > ~~~go\n  >    ~~~~",
  "> ~~~go\n>\t~~~~",
  "> ```ts\noutside",
  "- ```ts\noutside",
  "> ```ts\n> \t\n> ```",
  "1. ```ts",
  " > ```ts\r\n\r\n>a",
];

// Accepted examples from markdown-security.test.ts, including its fence matrix,
// size boundary and Unicode-space cases. Keep historical inputs here if a newly
// discovered gap moves one from acceptance to refusal in the raw-rule tests.
const examples = [
  ...hostile.map(([, body]) => body),
  ...containerFences,
  "10. x",
  "100. x",
  "- 7. x",
  "1. 7. x",
  "> - 9. x",
  "- 10. x",
  "1. 100. x",
  "Text 01. x",
  "```go\n~~~",
  "~~~go\n```",
  "````go\n```",
  "~~~~go\n~~~",
  "```go\n```text\ncode",
  "> ```go\n> ```",
  "1. a\n    ```ts\n    ```",
  "1. Steps\n2. More\n\nExpected\n\n1. c\n1. d",
  "1. Steps\n2. More\n\nExpected\n\n1. c\n2. d",
  "1. a\n2. b\n\n- x\n  1. y\n  1. z",
  "```text\n- 01. x\n```",
  "1. a\n   ```ts\n   ```",
  "```go\n```` \t",
  "~~~go\n~~~~",
  "1. a\n1. b\n1. c",
  "1. a\n2. b\n3. c",
  "7. a\n8. b\n9. c",
  "5.\n1.\n1.",
  "1.\n2.\n\ntext\n\n3.",
  "1. a\n2. b\n\ntext\n\n1. c\n2. d",
  "1. a\n2. b\n\ntext\n\n1) c\n2) d",
  "> ```ts\n> code\n> ```",
  "1. a\n   ```ts\n   code\n   ```",
  "- > ```ts\n  > code\n  > ```",
  "1. [ ] step",
  "-\n[X] e",
  "-\n[ ] e",
  "-\n  [x] done",
  "> -\n>   [x] done",
  "> -\n>\t[x] done",
  "1. a\n1. b\n2. c",
  "-\n[x] e",
  "1. a\n\n2. b",
  "1. a\n   ```ts\n   code\n   ```\n2. b",
  "1. a\n   1. b\n   2. c",
  "1. a\n   1. b\n   1. c",
  "```\n```",
  screenshot("Screenshot 1"),
  ["", "Screenshot", "Screenshot 3"].map((alt) => screenshot(alt)).join("\n"),
  "Text\n---\nText",
  "A | B\n\n---",
  "$5\n \t\n$6",
  "10:30:00",
  "x".repeat(200),
  "😀".repeat(200),
  `a${" \t".repeat(8)}b`,
  ["", "Screenshot", "Screenshot 0", "Screenshot 09", "Screenshot 99"].map((alt) => screenshot(alt)).join("\n"),
  Array(30).fill(screenshot("Screenshot 12")).join("\n"),
  "Plain instructions.",
  "## Summary\n- First item\n1. Second item",
  "- [ ] Pending\n- [x] Complete",
  "- [ ] Pending\n- [ ] Next",
  "- [x]\n~",
  "- [x] a",
  "- [X] a",
  "> quote\n**bold**",
  "Use `const x = 1;` here.",
  "```ts\nconst x = 1;\n```",
  "https://example.com/a?q=1&x=2",
  "synthetic@example.com",
  "#12 @user",
  "Choose A | B.",
  "| : |",
  screenshot("Screenshot"),
  screenshot(""),
  `Before.\r\n${screenshot("Screenshot")}\r\nAfter.`,
  ":123: :12: :_-+:",
  ":word :word",
  "$5\n\n$6",
  "&amp",
  `&a${"1".repeat(32)};`,
  ...["0", "9", "#", "*"].map((base) => `${base}\ufe0f\u20e3`),
  ...["\u00a0", "\u1680", "\u2000", "\u2003", "\u202f", "\u205f", "\u3000"].map((space) => `| text |\n${space}\n---`),
  "abc\n".repeat(65_536 / 4),
  // Accepted issue bodies: test-support, issue-trust, issue-security and
  // issue-boundaries (including snapshots with CRLF and no final newline).
  "Approved task.\n",
  "  Exact body\r\n\nNo final newline  ",
  "Visible\r\nNo final newline",
  "👩‍💻",
  "👩️‍💻️",
  "👩‍👩‍👧‍👦",
  "❤️",
  "Visible\r\n\ttext",
  `Visible.\r\n~~~md\n**Visible instruction**  \n- [ ] Keep spacing\n~~~\n${screenshot("Screenshot")}`,
  "```ts\nconst example = true;\n```",
  `Owner text.\r\nhttps://example.com/docs/example.txt#L1-L40\n${screenshot("Screenshot")}\n~~~md\n**Visible instructions**  \n~~~`,
];
for (const prefix of ["", "   ", "> ", "- "]) {
  for (const fence of ["```", "~~~~"]) {
    for (const language of ["", ...languages]) {
      const continuation = prefix === "- " ? "  " : prefix;
      examples.push(`${prefix}${fence}\t ${language.toUpperCase()} \t\n${continuation}code\n${continuation}${fence}`);
    }
  }
}

function generatedBodies(): string[] {
  let state = 0x5eedc0de;
  const next = (limit: number) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % limit;
  };
  const pieces = [
    ..."[]():*_`~$!#>-+|\\&^=@<0123456789abcXYZ",
    " ",
    "\t",
    "\n",
    "\r\n",
    "\n\n",
    "é",
    "中",
    "١",
    "- ",
    "* ",
    "+ ",
    "1. ",
    "2) ",
    "- 0",
    "01. ",
    "1. 007. ",
    "* 011. ",
    "+ 01. ",
    "> ",
    "> > ",
    "> - ",
    "- > ",
    "- - ",
    "```",
    "~~~",
    "```ts",
    "~~~text",
    "```hidden",
    "~~~math",
    "```ts hidden",
    "https://",
    "https://example.com/a?q=1",
    "www.",
    "www.example.com",
    "synthetic@example.com",
    "#12",
    "[^1]",
    "> [!NOTE]",
    "[x]",
    "[X]",
    "[ ]",
    "[a]: /b",
    "](",
    "[abc](",
    "![abc](",
    "(abc)",
    "[abc][def]",
    "[abc](def)",
    "github.com/x/y",
    "&amp;",
    "---",
    ":-",
    "| a |",
    screenshot("Screenshot"),
    screenshot(""),
    screenshot("Screenshot 09"),
    screenshot("Hidden"),
    screenshot("Screenshot 99"),
    screenshot("Screenshot", asset.replace("01234567-89ab-cdef-0123-456789abcdef", "bad-id")),
    screenshot("Screenshot", asset.replace("abcdef", "ABCDEF")),
  ];
  const prefixes = ["", "> ", "> > ", "- ", "* ", "+ ", "1. ", "2) ", "> - ", "- > ", "- - ", "  ", "\t"];
  const pick = (values: string[]): string => {
    const value = values[next(values.length)];
    assert.ok(value !== undefined, "generator choices must not be empty");
    return value;
  };
  const bodies: string[] = [];
  for (let i = 0; i < 4_000; i++) {
    let body = "";
    const count = 1 + next(24);
    for (let j = 0; j < count; j++) body += pick(pieces);
    bodies.push(body);
    // Correlated lines reach block constructs that independent punctuation
    // almost never produces: nested tables, task boxes and fenced paragraphs.
    if (i % 12 === 0) {
      const prefix = pick(prefixes);
      bodies.push(`${prefix}| a |\n${prefix}${pick(["---", ":-", "| --- |"])}\n${prefix}visible | HIDDEN`);
    } else if (i % 12 === 1) {
      bodies.push(`${pick(prefixes)}- ${pick(["[ ]", "[x]", "[X]"])} ${pick(["a", "é1", "task"])}\n${body}`);
    } else if (i % 12 === 2) {
      const fence = pick(["```", "~~~"]);
      const prefix = pick(["", "> ", "- "]);
      const continuation = prefix === "- " ? "  " : prefix;
      bodies.push(
        `${prefix}${fence}${pick(["", "ts", "TEXT", "math", "ts hidden"])}\n${continuation}${pick(["", " \t", "code", "const x = 1;"])}\n${continuation}${fence}`,
      );
    } else if (i % 12 === 3) {
      bodies.push(
        `${pick(prefixes)}${pick(["[abc](def)", "![abc](def)", "[abc][def]\n\n[def]: /hidden", '[abc](def "hidden")'])}`,
      );
    } else if (i % 12 === 4) {
      bodies.push(
        pick([
          screenshot("Hidden"),
          screenshot("Screenshot 99"),
          screenshot("Screenshot 1"),
          `${screenshot("Screenshot 1")}\n${screenshot("Screenshot 2")}`,
          screenshot("Screenshot", asset.replace("01234567-89ab-cdef-0123-456789abcdef", "bad-id")),
          screenshot("Screenshot", asset.replace("abcdef", "ABCDEF")),
        ]),
      );
    } else if (i % 12 === 5) {
      const prefix = pick(["", "> ", "  "]);
      const markers = pick(["1,2,3", "1,1,1", "7,8,9", "1,9,3", "00001,2,3", "1,1,2"]).split(",");
      bodies.push(markers.map((marker) => `${prefix}${marker}. visible`).join("\n"));
    } else if (i % 12 === 6) {
      bodies.push(pick(["Plain text.", "- [x] done", "- [ ] pending", "a[X]", "https://example.com/a", "#12 @user"]));
    } else if (i % 12 === 8) {
      const prefix = pick(["", "> ", "  "]);
      const delimiter = pick([".", ")"]);
      bodies.push(`${prefix}a\n${prefix}2${delimiter} b\n${prefix}1${delimiter} c\n${prefix}4${delimiter} d`);
    } else if (i % 12 === 9) {
      const fence = pick(["```", "~~~"]);
      const prefix = pick(["", ">", "> ", ">> ", "- > ", "   "]);
      const continuation = pick(["", ">", "> ", ">   ", ">\t", ">>    ", "  >    ", "    "]);
      const content = pick(["", "\n", `${continuation} \t\n`, `${continuation}code\n`]);
      bodies.push(`${prefix}${fence}${pick(["go", "ts", "text"])}\n${content}${continuation}${fence}${fence[0]}`);
    } else if (i % 12 === 10) {
      bodies.push(
        `${pick(["-", "> -", ">> -", "- > -"])}\n${pick(["", " ", "\t", "> ", " >   ", ">\t", ">>    "])}${pick(["[X]", "[x]", "[ ]"])} done`,
      );
    } else if (i % 12 === 11) {
      bodies.push(
        pick([
          "1. a\n   1. b\n   2. c",
          "1. a\n   1. b\n   1. c",
          "> 1. a\n> 2. b",
          "1. a\n2) b\n3) c",
          "1. a\n\n2. b",
          "1. a\n   ```ts\n   code\n   ```\n2. b",
        ]),
      );
    } else {
      bodies.push(`${pick(prefixes)}${pick(pieces)}\n${body}\n${pick(pieces)}`);
    }
  }
  return bodies;
}

function violation(body: string): string | null {
  try {
    checkCoverage(body);
    return null;
  } catch (error) {
    if (!(error instanceof assert.AssertionError)) throw error;
    return error.message.split("\n")[0] ?? error.message;
  }
}

// Failure-only delta debugging: keep the same violation and shorten until no
// single-character deletion preserves it. Keep CRLF intact: issue validation
// rejects bare CR before Markdown, so shrinking must not introduce one.
function minimize(body: string, reason: string): string {
  for (let width = Math.ceil(body.length / 2); width >= 1; width = Math.floor(width / 2)) {
    for (let start = 0; start + width <= body.length; ) {
      const candidate = body.slice(0, start) + body.slice(start + width);
      if (!/\r(?!\n)/u.test(candidate) && hiddenMarkdownReason(candidate) === null && violation(candidate) === reason) {
        body = candidate;
        start = 0;
      } else start++;
    }
  }
  return body;
}

test("coverage oracle detects lost text and unsafe structure independently of the checker", () => {
  for (const body of [
    ...hostile.map(([, body]) => body),
    "<!-- hidden -->",
    "[a]: /hidden",
    "[a]\n\n[a]: /hidden",
    "![a]\n\n[a]: /hidden",
    "[^1]\n\n[^1]: hidden",
    "| a |\n| - |\n| a | HIDDEN |",
    "[a](hidden)",
    "[https://example.com](https://example.com)",
    "<https://example.com>",
    "![hidden](image.png)",
    "```ts hidden\na\n```",
    "```mermaid\na\n```",
    "&amp;",
  ])
    assert.notEqual(violation(body), null, JSON.stringify(body));
  for (const body of [
    "123. a\n124. b",
    "> 123. a",
    "```TS\n123. a\n```",
    "    123. a",
    "`123. a`",
    "é中١",
    "https://example.com/a",
    "www.example.com",
    "www.",
    "www.@.c",
    "synthetic@example.com",
    screenshot("Screenshot 1"),
    `~~~text\n${screenshot("Screenshot")}\n~~~`,
  ])
    checkCoverage(body);
});

test("container fences retain the bounded info-word allowance even when empty", () => {
  for (const body of containerFences) {
    assert.equal(hiddenMarkdownReason(body), null, JSON.stringify(body));
    assert.doesNotThrow(() => checkCoverage(body), JSON.stringify(body));
  }
});

test("checked task state covers canonical x while literal X remains text", () => {
  for (const body of [
    "- [x] done",
    "- [x]\n~",
    "> 1. [x] done\n>    - [x] nested",
    "1. [ ] step",
    "- [x] a[x]",
    "- [ ] a[x]",
    "`a[x]`",
    "    a[X]",
    "\\[x]",
  ]) {
    assert.equal(hiddenMarkdownReason(body), null, JSON.stringify(body));
    assert.doesNotThrow(() => checkCoverage(body), JSON.stringify(body));
  }
});

test("missing parser install has an actionable error", async () => {
  for (const code of ["MODULE_NOT_FOUND", "ERR_MODULE_NOT_FOUND"]) {
    const missing = Object.assign(new Error("synthetic missing module"), { code });
    await assert.rejects(
      loadParser(() => {
        throw missing;
      }),
      (error: unknown) =>
        error instanceof Error &&
        error.cause === missing &&
        error.message === "run pnpm install: this test borrows packages/core's remark parser",
    );
  }
});

// math, emoji shortcode, GitHub link, whitespace run and line length are not
// observable by this CommonMark/GFM oracle; markdown-security.test.ts owns them.
test("coverage catches each observable refusal-class mutation", (t) => {
  for (const [kind, body] of hostile) {
    assert.equal(hiddenMarkdownReason(body), `hidden Markdown in the body: ${kind}`, body);
  }
  for (const kind of new Set(hostile.map(([kind]) => kind))) {
    const mutated = (body: string) => {
      const reason = hiddenMarkdownReason(body);
      return reason === `hidden Markdown in the body: ${kind}` ? null : reason;
    };
    const released = hostile.map(([, body]) => body).filter((body) => mutated(body) === null);
    assert.ok(released.length > 0, `${kind}: mutation must release a hostile body`);
    for (const body of released) assert.notEqual(violation(body), null, `${kind}: ${JSON.stringify(body)}`);
    t.diagnostic(`mutation ${kind}: caught=yes`);
  }
});

test("accepted Markdown preserves CommonMark/GFM structure and visible letters and digits", (t) => {
  const generated = generatedBodies();
  const corpus = [...examples, ...generated];
  const failures = new Map<string, string>();
  let accepted = 0;
  const started = performance.now();
  for (const body of corpus) {
    if (hiddenMarkdownReason(body) !== null) continue;
    accepted++;
    const reason = violation(body);
    if (reason && body.length < (failures.get(reason)?.length ?? Infinity)) failures.set(reason, body);
  }
  t.diagnostic(
    `${corpus.length} bodies (${examples.length} fixtures, ${generated.length} generated); ${accepted} accepted; ${(performance.now() - started).toFixed(0)} ms`,
  );
  assert.ok(accepted > 1_000, "the accepted corpus must not become vacuous");
  assert.deepEqual(
    [...failures].map(([reason, body]) => ({ reason, minimalBody: minimize(body, reason) })),
    [],
    "accepted bodies must preserve renderer coverage",
  );
});
