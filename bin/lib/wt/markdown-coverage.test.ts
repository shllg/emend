// remark is not GitHub's renderer (cmark-gfm plus extensions such as math, emoji
// shortcodes and alerts). Those need raw checker rules of their own; this oracle
// covers CommonMark and GFM structure only, without contacting a renderer service.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { hiddenMarkdownReason } from "./markdown.ts";

// Only this test borrows core's installed parser; bin/wt stays dependency-free.
const coreRequire = createRequire(new URL("../../../packages/core/package.json", import.meta.url));
const [{ unified }, { default: remarkParse }, { default: remarkGfm }] = await Promise.all(
  ["unified", "remark-parse", "remark-gfm"].map((name) => import(pathToFileURL(coreRequire.resolve(name)).href)),
);
const parser = unified().use(remarkParse).use(remarkGfm);

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
const screenshot = (alt: string) => `![${alt}](${asset})`;
const imageLine =
  /^!\[((?:Screenshot(?: [0-9]{1,2})?)?)\]\(https:\/\/github\.com\/user-attachments\/assets\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\)$/u;
const lettersAndDigits = (text: string) => text.match(/[\p{L}\p{N}]/gu)?.join("") ?? "";

/**
 * Coverage compares case-sensitive Unicode letters/numbers in document order,
 * including repetitions. Equality also rejects inserted visible letters, beyond
 * the required subsequence coverage. Whitespace and punctuation are outside this
 * particular invariant. Visible text is the concatenation of text,
 * inlineCode and code values, literal autolink text, and approved screenshot alts.
 * A listItem with checked === true also shows its state as a check mark: count
 * the source marker's x/X as visible before the item's text. Locate that letter
 * within the parser's list-item span; literal [x]/[X] elsewhere stays ordinary
 * text, including code and unchecked items.
 * Only AST-proven ordered-list marker digits and allowlisted fence language words
 * are removed from the source. An actual approved image contributes its alt in
 * place of its fixed screenshot envelope (including the expressly allowed asset
 * URL); a screenshot-looking string inside code keeps ALL of its source letters.
 * No global regex strips lookalikes or arbitrary destinations.
 */
function checkCoverage(body: string): void {
  const root: Node = parser.parse(body);
  const omitted: [number, number][] = [];
  const visible: string[] = [];
  const source = (node: Node) => {
    assert.ok(node.position, "parser positions are required");
    return body.slice(node.position.start.offset, node.position.end.offset);
  };
  function visit(node: Node, parent?: Node): void {
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
      assert.ok(start.offset === 0 || body[start.offset - 1] === "\n", "whole screenshot line start");
      assert.ok(end.offset === body.length || /^(?:\r?\n)/u.test(body.slice(end.offset)), "whole screenshot line end");
      assert.equal(node.alt, match[1], "screenshot alt must be literal");
      assert.equal(node.url, raw.slice(raw.indexOf("](") + 2, -1), "screenshot destination");
      assert.ok(!node.title, "screenshot title");
      omitted.push([start.offset + raw.indexOf("](") + 2, end.offset - 1]);
      visible.push(node.alt ?? "");
    }
    if (node.type === "code") {
      assert.ok(!node.meta, "code meta must be empty");
      assert.ok(!node.lang || languages.includes(node.lang.toLowerCase()), "code language must be allowlisted");
      if (node.lang) {
        const raw = source(node);
        const opening = /^[ \t]*(?:`{3,}|~{3,})[ \t]*([A-Za-z]+)[ \t]*(?:\r?\n|$)/u.exec(raw);
        assert.ok(opening, "fence info source");
        assert.equal(opening[1], node.lang, "literal fence language");
        assert.ok(node.position, "fence position");
        const start = node.position.start.offset + opening[0].indexOf(node.lang);
        omitted.push([start, start + node.lang.length]);
      }
    }
    if (node.type === "listItem" && parent?.ordered) {
      const marker = /^(\d{1,9})[.)](?:[ \t\r\n]|$)/u.exec(source(node));
      assert.ok(marker?.[1], "ordered marker source");
      assert.ok(node.position, "list marker position");
      omitted.push([node.position.start.offset, node.position.start.offset + marker[1].length]);
    }
    if (node.type === "listItem" && node.checked === true) {
      // Continuation lines can retain outer blockquote prefixes in this span.
      const marker = /^(?:[-+*]|\d{1,9}[.)])[ \t\r\n>]*\[([xX])\]/u.exec(source(node));
      assert.ok(marker, "checked task marker source");
      assert.ok(node.position, "checked task marker position");
      const start = node.position.start.offset + marker[0].length - 2;
      visible.push(body.slice(start, start + 1));
    }
    if (["text", "inlineCode", "code"].includes(node.type)) visible.push(node.value ?? "");
    for (const child of node.children ?? []) visit(child, node);
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

// Accepted examples from markdown-security.test.ts, including its fence matrix,
// size boundary and Unicode-space cases. Keep historical inputs here if a newly
// discovered gap moves one from acceptance to refusal in the raw-rule tests.
const examples = [
  "Text\n---\nText",
  "A | B\n\n---",
  "$5\n \t\n$6",
  "10:30:00",
  "x".repeat(200),
  "😀".repeat(200),
  `a${" \t".repeat(8)}b`,
  ["", "Screenshot", "Screenshot 0", "Screenshot 09", "Screenshot 99"].map(screenshot).join("\n"),
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
      examples.push(`${prefix}${fence}\t ${language.toUpperCase()} \t\ncode\n${prefix}${fence}`);
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
    "&amp;",
    "---",
    ":-",
    "| a |",
    screenshot("Screenshot"),
    screenshot(""),
    screenshot("Screenshot 09"),
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
    if (i % 4 === 0) {
      const prefix = pick(prefixes);
      bodies.push(`${prefix}| a |\n${prefix}${pick(["---", ":-", "| --- |"])}\n${prefix}visible | HIDDEN`);
    } else if (i % 4 === 1) {
      bodies.push(`${pick(prefixes)}- ${pick(["[ ]", "[x]", "[X]"])} ${pick(["a", "é1", "task"])}\n${body}`);
    } else if (i % 4 === 2) {
      const fence = pick(["```", "~~~"]);
      const prefix = pick(prefixes);
      bodies.push(`${prefix}${fence}${pick(["", "ts", "TEXT", "math", "ts hidden"])}\n${body}\n${prefix}${fence}`);
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
    "123. a\n456. b",
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
    screenshot("Screenshot 12"),
    `~~~text\n${screenshot("Screenshot")}\n~~~`,
  ])
    checkCoverage(body);
});

test("checked task state covers its source marker without exempting literal x/X", () => {
  for (const body of [
    "- [x] done",
    "- [X] done",
    "- [x]\n~",
    "> 12. [X] done\n>     - [x] nested",
    "-\n  [x] done",
    "> -\n>   [X] done",
    "- [x] a[x]",
    "- [ ] a[x]",
    "`a[x]`",
    "    - [X] done",
    "\\[x]",
  ]) {
    assert.equal(hiddenMarkdownReason(body), null, JSON.stringify(body));
    assert.doesNotThrow(() => checkCoverage(body), JSON.stringify(body));
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
