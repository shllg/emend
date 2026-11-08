// remark is not GitHub's renderer (cmark-gfm plus extensions such as math, emoji
// shortcodes and alerts). Those need raw checker rules of their own; this oracle
// covers CommonMark and GFM structure only, without contacting a renderer service.
// GitHub also shortens recognized commit hashes, which remark does not model.
// Only hashes naming real commits are shortened, so an author cannot choose the
// hidden suffix beyond the few bits a brute-forced commit buys. No refusal is needed.
// remark expands a tab inside a task box according to its column; GitHub reads
// the raw tab. GitHub may also find boxes in rendered text after escape handling,
// which the raw checker refuses conservatively without claiming renderer parity.
// GitHub's text filters skip code: a canonical box-shaped line inside a fence
// stays literal. This oracle does not apply task transforms to code.
// cmark also accepts digit-plus-any-character task markers and sets checked state
// from any [x]/[X] on the raw line. remark models neither; explicit raw refusals
// cover those cases instead of treating an oracle pass as GitHub equivalence.
// The later-line box guards also cover that rendered-text model, including code
// inside a non-one ordered item. Nested roman/alpha marker width is a raw limit;
// remark's tree retains only the numeric start and cannot measure that width.
// Ordered context is detected even in code; any fence-shaped line in that
// context makes later boxes fail closed until a structural boundary ends it.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire, stripTypeScriptTypes } from "node:module";
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
 * letters/numbers in order and count after these AST-positioned deductions:
 * list digits must be the rendered start + item index or use the allowance for 1,
 * with no leading zero. GitHub hides a task item's ordered number, checked or
 * unchecked, so only literal 1 is allowed there. A loaded screenshot's unseen
 * alt must be empty, Screenshot, or Screenshot <its 1-based screenshot-line
 * ordinal>. The exact approved image envelope is excluded, never arbitrary URLs.
 * The ordinal counts screenshot lines, fenced ones included: their source line
 * order is visible in the code block, so the digit remains determined.
 * A checked item's visible check mark contributes the canonical source x; X is
 * refused in that position, while literal a[X] remains text. Screenshots and list
 * markers inside code keep their source letters rather than these deductions.
 * The first allowance: a fenced code block may hide its one allowlisted info
 * word. Inside a quote or list item this holds even when empty, because the code
 * box stays visible and the word comes from the fixed allowlist. The tree and
 * parser position identify the container and opener's prefix. Top-level fences,
 * including those with up to three leading spaces, need non-whitespace content;
 * an empty fence without an info word hides no letters or digits.
 * The second allowance: an ordered marker may be 1 even when the page shows n
 * or hides the marker for a task item.
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
      if (typeof node.checked === "boolean") {
        assert.equal(marker[1], "1", "task list number must be 1");
      } else {
        assert.ok(marker[1] === "1" || Number(marker[1]) === (parent.start ?? 1) + index, "rendered list number");
      }
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

// The structural policy also applies to literal numbered code examples.
const newlyRefusedBodies = [
  "-\n ```text\n2. a\n   [\n   ] x\n ```",
  ">-\n   ```text\n2. a\n   [\n   ] x\n```",
  "1. a\n2. b\n ```text\n [\n ] literal\n ```",
  "```text\n104. a\n     - [ ] b\n```",
  "```text\n104. a\n     [\n     ] x\n```",
];

const hostile = [
  ...newlyRefusedBodies.map((body) => ["task marker", body, "checker only"] as const),
  ...[
    "- a\n  ```\n2. a\n   [\n   ] x",
    "2. a\n   >- ```\n   >  ```\n   > - [ ] x",
    "2. a\n      ```\n        ```\n   - [ ] x",
    "2. a\n   ```\n   code\n   ```\n   - [ ] x",
    "2. a\n   -\n       ```\n   [\n   ] x",
    "2. a\n   - \n       - [ ] x",
    "2. a\n   - b\nwrapped\n       - [ ] x",
    "2. a\n   ```\n   code\n   ```\n\n text\n   - [ ] x",
    "2. a\n   ```\n   code\n   ```\n> # h\n> - [ ] x",
    "- [x\\] Done",
    "- [\\x] Done",
    "- [\n  \\] Done",
  ].map((body) => ["task marker", body, "checker only"] as const),
  ["link destination", "[abc](def)"],
  ["alt text", screenshot("Hidden")],
  ["alt text", screenshot("Screenshot 99")],
  ["alt text", Array(30).fill(screenshot("Screenshot 12")).join("\n")],
  ["alt text", `\`\`\`md\n${screenshot("Screenshot 1")}\n\`\`\`\n${screenshot("Screenshot 1")}`],
  ["reference definition", "[abc]: def"],
  ["character reference", "&amp;"],
  ["table", "| a |\n| - |\n| a | HIDDEN |"],
  ["raw HTML", "<!-- hidden -->"],
  ["fence info", "```hidden\ncode\n```"],
  ["list number", "1. a\n9. b"],
  ["list number", "1. a\n2.    \n   ## h\n2. c"],
  ["list number", "00001. a"],
  ["list number", "- 1. a\n- 1. b\n  3. c"],
  ["list number", "a\n2. b\n1. c\n4. d"],
  ["list number", "1.\n1.\n2."],
  ["list number", "1. a\n2. b\nlazy\n1. c\n2. d"],
  ["list number", "1. a\n2. b\n\n   indented\n1. c\n2. d"],
  ["list number", "1. a\n\u00a0\nb\n1.\n2."],
  ["list number", "1. a\n\n9. b"],
  ["list number", "- 00000001. x"],
  ["list number", "1. 007. x"],
  ["list number", "> - 0009. x"],
  ["list number", "- 0."],
  ["list number", "1. 01) a"],
  ["list number", "* 011. "],
  ["list number", "+ 01. x"],
  ["list number", "987654321. [x] Done"],
  ["list number", "- 987654321. [x] Done"],
  ["list number", "987654321. [ ] Done"],
  ["list number", "- 987654321. [ ] Done"],
  ["list number", "2) [ ] step"],
  ["list number", "1. 9. [x] Done"],
  ["list number", "> - 9. [ ] Done"],
  ["task marker", "2. [X] Done"],
  ["list number", "2.\t[x] Done"],
  ["list number", "1. [x] a\n2. [ ] b"],
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
  ["list number", "1234. [\t] Done"],
  ["task marker", "2.    [\t] Done"],
  ["list number", "- 12. [\t] a"],
  ["list number", "- 987654. [\t] Done"],
  ["list number", "12345678. [\t] Done"],
  ["task marker", "2. [\n   ] Done"],
  ["task marker", "2.\n   [\n   ] Done"],
  ["task marker", "2)\n   [\n   ] Done"],
  ["task marker", "2.\n   [\n] Done"],
  ["task marker", "- 2.\n     [\n     ] Done"],
  ["task marker", "1. 2.\n      [\n      ] Done"],
  ["task marker", "> - 2.\n>      [\n>      ] Done"],
  [
    "task marker",
    "Steps\n\n104.\n     [\n     ] a\n\ntext\n\n101.\n     [\n     ] b\n\ntext\n\n108.\n     [\n     ] c",
  ],
  // These are required raw refusals beyond remark's model. Keep them in the
  // hostile corpus and assert refusals, without claiming the oracle detects them.
  ["task marker", "-\n  ```\n2. a\n   [\n   ] x", "checker only"],
  ["task marker", "-    \n  ```\n2. a\n   [\n   ] x", "checker only"],
  ["task marker", "1.\n   ```\n2. a\n   [\n   ] x", "checker only"],
  ["task marker", "1)    \n   ```\n2) a\n   [\n   ] x", "checker only"],
  ["task marker", "2. a\n   > -\n   >   ```\n   > ```\n   > - [ ] x", "checker only"],
  ["task marker", "2. a\n   >> -\n   >>   ```\n   >> ```\n   >> - [ ] x", "checker only"],
  ["task marker", "2. a\n   >-\n   >   ```\n   >  ```\n   > - [ ] x", "checker only"],
  ["task marker", "2. a\n   >>-\n   > >   ```\n   >>  ```\n   >> - [ ] x", "checker only"],
  ["task marker", "2. a\n   > -\n   >   ```\n   >\n   >   - [ ] x\n   >   ```", "checker only"],
  // The requested blank-start restart refusals are stricter than the oracle's
  // bounded literal-one allowance, which still covers their final marker.
  ["list number", "1. a\n2.    \n   ## h\n1. c", "checker only"],
  ["list number", "1. a\n2.    \n   ***\n1. c", "checker only"],
  ["list number", "1. a\n2.\n   ## h\n1. c", "checker only"],
  ["task marker", "2.    \n   text\n       - [ ] x", "checker only"],
  ["task marker", "2.    \n   ```text\n   - [ ] x\n   ```", "checker only"],
  ["list number", "1. a\n2.\t\n   ## h\n1. c", "checker only"],
  ["task marker", "2.\t\n   text\n       - [ ] x", "checker only"],
  ["list number", "1. a\r\n2.    \r\n   ## h\r\n1. c", "checker only"],
  ["list number", "Steps\n\n104101108. [\t] a\n\ntext\n\n108111032. [\t] b", "checker only"],
  ["task marker", "2. [\t] Done", "checker only"],
  ["list number", "- 987654321. [\t] Done", "checker only"],
  ["task marker", "1. [\t] a\n2. [\t] b", "checker only"],
  ["list number", "2. -[x] Done", "checker only"],
  ["list number", "987654321. +[x] Done", "checker only"],
  ["list number", "2. 3.[x] Done", "checker only"],
  ["list number", "2. 1.[x] Done", "checker only"],
  ["list number", "2. \\[x] Done", "checker only"],
  ["list number", "2. [x\\] Done", "checker only"],
  ["task marker", "2. [\u00a0] Done", "checker only"],
  ["task marker", "2. [\u3000] Done", "checker only"],
  ["task marker", "2. a\n-[x] b", "checker only"],
  ["task marker", "-[x] Done", "checker only"],
  ["task marker", "1.[x] Done", "checker only"],
  ["task marker", "1. [\n   ] Done", "checker only"],
  ["task marker", "\\[x]", "checker only"],
  ["list number", "1000. a", "checker only"],
  ["list number", "- 1234. a", "checker only"],
  ["task marker", "2. a\n\n   9x [ ] b", "checker only"],
  ["task marker", "1. Steps\n\n   1h [ ] a\n\n   1i [ ] b", "checker only"],
  ["task marker", "2.\n   12 [ ] b", "checker only"],
  ["list number", "2. a\n\n   1234567890. [ ] b", "checker only"],
  ...["2. Steps\n\n   1h [ ]\n\n   1i [ ]", "- a\n\n  1h [x]\n\nend"].flatMap((body) =>
    [body, body.replaceAll("\n", "\r\n")].map((input) => ["task marker", input, "checker only"] as const),
  ),
  ["list number", "2. a\n\n   1234567890. [ ]\n\nx", "checker only"],
  ["list number", "2. a\r\n\r\n   1234567890. [ ]\r\n\r\nx", "checker only"],
  ["list number", "- 1234567890.[ ] x", "checker only"],
  ["list number", `- ${"9".repeat(190)}.[ ] x`, "checker only"],
  ["list number", "1. 104101108108111032.[x] x", "checker only"],
  ["list number", "-\n  1234567890.[ ] x", "checker only"],
  ["task marker", "2. 1234567890.\n   [\n   ] x", "checker only"],
  ["task marker", "1234567890.\n   [\n   ] x", "checker only"],
  ["task marker", "1234567890. 1.\n   [\n   ] x", "checker only"],
  ["task marker", "2. a\n   - b\n   ---\n       - [ ] x", "checker only"],
  ["task marker", "2. a\n   - b\n     - c\n   ---\n       - [ ] x", "checker only"],
  ["task marker", "2. a\n   - b\n\n   text\n       - [ ] x", "checker only"],
  ["task marker", "2. a\n   - b\n\n   \u00a0\n       - [ ] x", "checker only"],
  ["task marker", "2. a\n   - b\n   ## Next\n       - [ ] x", "checker only"],
  ["task marker", "2. a\n   - b\n   ```text\n   code\n   ```\n       - [ ] x", "checker only"],
  ["task marker", "2. a\n   -\n       - [ ] x", "checker only"],
  ["task marker", "104. a\n    ```\n         - [ ] x", "checker only"],
  ["task marker", "2. a\n   ```text\n   - [ ]\n   ```", "checker only"],
  ["task marker", "2. a\n   ```text\n   - [x] done\n   ```", "checker only"],
  ["task marker", "2. a\n\n   1h [x]\n\nx", "checker only"],
  ["task marker", "2. a\n   ```text\n   [ ]\n   ```", "checker only"],
  ["task marker", "2. a\n   ```text\n   [x] done\n   ```", "checker only"],
  ["task marker", "2. a\n   - [ ] b\n           - [ ] c", "checker only"],
  ["task marker", "2. a\n   - [ ] b\n     text\n         - [ ] c", "checker only"],
  ["task marker", "2. a\n   - - -\n        - [ ] c", "checker only"],
  ["task marker", "104. a\n     \\- [ ] x", "checker only"],
  ["task marker", "104. a\n     1\\. [ ] x", "checker only"],
  ["task marker", "104. a\n         - [ ] x", "checker only"],
  ["task marker", "104. a\n     ```text\n     x\n     - [ ] bar\n     ```", "checker only"],
  ["task marker", "104. a\n     [\n     ] Done", "checker only"],
  ["list number", "- 888. x", "checker only"],
  ["list number", "- 999. a", "checker only"],
  ["list number", "- 10. x", "checker only"],
  ["list number", "1. 100. x", "checker only"],
  ["task marker", "- a\n\n  1h [ ] b", "checker only"],
  ["task marker", "> - Steps\n>\n>   9x [ ] Continue", "checker only"],
  ["task marker", "> 1. Steps\n>\n>   9x [ ] Continue", "checker only"],
  ["task marker", "- Steps\n\n   9x [ ] Continue", "checker only"],
  ["task marker", "- 9x [ ] Continue", "checker only"],
  ["task marker", "> - 9x [ ] Continue", "checker only"],
  ["task marker", "1. 9x [ ] Continue", "checker only"],
  ["task marker", "> 1. 9x [ ] Continue", "checker only"],
  ["task marker", "- > 1. 1h [ ] Continue", "checker only"],
  ["task marker", "- [ ] Remove the auth check [x]", "checker only"],
  ["task marker", "1. [ ] Ship it [X]", "checker only"],
  ["task marker", "- [ ] a\\[x]", "checker only"],
  ["task marker", "- [ ] a[x]", "checker only"],
  ["task marker", "> - [ ] text [X]\n- [ ] text [X]", "checker only"],
] as const;
const oracleHostile = hostile.filter(([, , scope]) => scope !== "checker only");

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

// These owner forms must stay accepted; markdown-security.test.ts also asserts
// them through issue evaluation. The mixed corpus below retains refusal cases too.
const ownerBodies = [
  "1. a\n2. b\n   ```text\n   code\n   ```\n   More text",
  "- [x] path\\name",
  "2. a\n   ```\n   code\n   ```\n## Expected\n- [ ] x",
  "-\n  ```text\n  code\n  - [ ] x\n  ```",
  "1.\n   ```text\n   code\n   - [x] x\n   ```",
  ">-\n>   ```text\n>   code\n>   - [ ] x\n>   ```",
  "1. a\n2. b\n## h\n1. c",
  "1.  a\n2.  b\n   ## H\n3.  c",
  "2.    \n   text\n   - [ ] x",
  "1. a\n2.    \n## h\n1. c",
  "1. a\n2.    \n   ## h\n1) c",
  "1. a\n2.    \n       ## h\n1. c",
  "-\n  text",
  "-    \n  text",
  "2. a\n   - b\n     - c\n     ---\n       - [ ] x",
  ...["## Expected", "---", "  ## Expected", "  * * *", "___"].map((boundary) => `1. a\n2. b\n${boundary}\n1. c\n2. d`),
  "104. a\n   ## Expected\n1. c\n2. d",
  "104. a\n## Expected\n[\n] literal",
  "104. a\n\nExpected\n\n[\n] literal",
  '1. Create\n2. Set:\n\n   ```json\n   [\n     "a"\n   ]\n   ```',
  "1. a\n2. b\n```json\n[\n1\n]\n```",
  "1. a\n2. b\n```text\n[\n] literal\n```",
  "1. a\n2. Step\n   - [ ] a\n     - [ ] b\n       - [ ] c",
  "2. Step\n    - [ ] a\n        - [ ] b",
  "104. a\n\n## Expected\n\n[\n] literal",
  "Steps\n\n1. a\n2. b\n\n## Expected\n\n- [ ] Pending",
  "2. a\n   - [ ] b",
  "104. a\n     - [ ] b",
  "104. a\n        - [ ] b",
  "104. a\n\n```text\n- [ ] b\n```",
  "104. a\n\n## Expected\n\n```json\n[\n1\n]\n```",
  "104. a\n\t\t- [ ] b",
  "2.    a\n         - [ ] b",
  "2. a\n1. b\n   [\n   ] x",
  "> - [ ] Pending",
  "> 1. [x] Done",
  "> - 1) [ ] Pending",
  "- > 1. [ ] Pending",
  "- [ ] Pending",
  "- [x] Done",
  "1. [x] Done\n1. [ ] Pending",
  "[1] ref",
  "- [Optional]",
  "- [x86]",
  "- [ 1, 2 ]",
  "- [x] Done\n  - [ ] Pending",
  "> - [x] Done\n> - [ ] Pending",
  "```python\nprint([1, 2])\n```",
  "```sh\nprintf '%s\\n' pending\n```",
  "- [a] item",
  "1. [1] reference",
  "[!] Note",
  "2. [a] b",
  "```text\n[1] 42\n```",
  "- [😀] Done",
  "1. [x] Done",
  "- 1. [ ] a",
  "1) [ ] step",
  "> - [ ] quoted",
  "- [ ] Pending\n- [x] Complete",
  "```text\n- [x] Done\n1. [ ] Pending\n```",
  "```json\n[\n  1,\n  2\n]\n```",
  "999. a",
  "```text\n\t```\n```",
  "```text\n    ```\n```",
  "```text\n \t```\n```",
  "- a\n  ```text\n      ```\n  ```",
  "```text\n> ```\n```",
  "Steps\n\n1. a\n2. b\n\nExpected\n\n1. c\n2. d\n3. e",
  "1. a\n2. b\n\n```text\n1. first\n2. second\n```",
  "1. Steps\n2. More\n\nExpected\n\n1. c\n2. d",
  "1. a\n2. b\n\ntext\n\n1. c\n2. d",
  "1. a\n2. b\n\n## Expected\n\n1. c\n2. d",
  "1. a\n2. b\n \t\nExpected\n1. c\n2. d",
  "1. a\n2. b\n\n- divider\n1. c\n2. d",
  "1. a\n2. b\n\n> divider\n1. c\n2. d",
  "1. a\n2. b\n\n```text\ncode\n```\n1. c\n2. d",
  Array.from({ length: 30 }, (_, i) => screenshot(`Screenshot ${i + 1}`)).join("\n"),
  `\`\`\`md\n${screenshot("Screenshot 1")}\n\`\`\`\n${screenshot("Screenshot 2")}`,
];

// Mixed accepted, refused and historical fixtures, including the raw-rule fence
// matrix and size boundaries. Acceptance is asserted separately for owner forms.
const examples = [
  ...hostile.map(([, body]) => body),
  ...containerFences,
  ...ownerBodies,
  "```text\n2. [x] Done\n```",
  "- a\n  ```go\n\t```",
  "- a\n  ```go\n     ```",
  "- a\n  ```go\n \t```",
  "````text\n```go\n```\n````",
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
    "2.\n",
    "9x [ ] ",
    "1h [ ] ",
    "1234. ",
    "12345678. ",
    "- 12. ",
    "- 0",
    "01. ",
    "1. 007. ",
    "* 011. ",
    "+ 01. ",
    "1. [x] ",
    "2. [ ] ",
    "1) [ ] ",
    "2) [x] ",
    "987654321. [x] ",
    "- 987654321. [x] ",
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
    "[a]",
    "[1]",
    "[!]",
    "[Optional]",
    "[x86]",
    "[ ] a[x]",
    "[\t]",
    "[\u00a0]",
    "[\u3000]",
    "\\[x]",
    "[x\\]",
    "-[x]",
    "+[x]",
    "3.[x]",
    "1.[x]",
    "[\n   ]",
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
  const prefixes = [
    "",
    "> ",
    "> > ",
    ">   ",
    "- ",
    "* ",
    "+ ",
    "1. ",
    "2) ",
    "> - ",
    "> 1. ",
    "> 1) ",
    "> - 1. ",
    "- 1. ",
    "- > ",
    "- - ",
    "  ",
    "\t",
  ];
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
    if (i % 13 === 0) {
      const prefix = pick(prefixes);
      bodies.push(`${prefix}| a |\n${prefix}${pick(["---", ":-", "| --- |"])}\n${prefix}visible | HIDDEN`);
    } else if (i % 13 === 1) {
      const marker = pick(["-", "1.", "2.", "1234.", "12345678.", "- 12.", "987654321."]);
      const spacing = pick([" ", "    ", "\t"]);
      const box = pick(["[ ]", "[x]", "[X]", "[\t]", "[\u00a0]", "[\u3000]", "\\[x]", "[x\\]", "[\n   ]"]);
      bodies.push(
        `${pick(prefixes)}${marker}${spacing}${pick(["", "-", "+", "3.", "1."])}${box} ${pick(["a", "é1", "task"])}\n${body}`,
      );
    } else if (i % 13 === 2) {
      const fence = pick(["```", "~~~"]);
      const prefix = pick(["", "> ", "- "]);
      const continuation = prefix === "- " ? "  " : prefix;
      bodies.push(
        `${prefix}${fence}${pick(["", "ts", "TEXT", "math", "ts hidden"])}\n${continuation}${pick(["", " \t", "code", "const x = 1;"])}\n${continuation}${fence}`,
      );
    } else if (i % 13 === 3) {
      bodies.push(
        `${pick(prefixes)}${pick(["[abc](def)", "![abc](def)", "[abc][def]\n\n[def]: /hidden", '[abc](def "hidden")'])}`,
      );
    } else if (i % 13 === 4) {
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
    } else if (i % 13 === 5) {
      const prefix = pick(["", "> ", "  "]);
      const markers = pick(["1,2,3", "1,1,1", "7,8,9", "1,9,3", "00001,2,3", "1,1,2"]).split(",");
      bodies.push(markers.map((marker) => `${prefix}${marker}. visible`).join("\n"));
    } else if (i % 13 === 6) {
      bodies.push(pick(["Plain text.", "- [x] done", "- [ ] pending", "a[X]", "https://example.com/a", "#12 @user"]));
    } else if (i % 13 === 7) {
      const container = pick(["> -", "> 1.", "-"]);
      const quote = container.startsWith(">") ? ">" : "";
      bodies.push(
        pick([
          "2. a\n-[x] b",
          "1. [\t] a\n2. [\t] b",
          "Steps\n\n104101108. [\t] a\n\ntext\n\n108111032. [\t] b",
          "2. [\n   ] Done",
          "2. a\n\n   9x [ ] b",
          "1. Steps\n\n   1h [ ] a\n\n   1i [ ] b",
          "2.\n   12 [ ] b",
          "2. a\n\n   1234567890. [ ] b",
          "- a\n\n  1h [ ] b",
          `${container} Steps\n${quote}\n${quote}   ${pick(["9x", "1h", "12", "1234567890."])} [ ] Continue`,
          `- [ ] text ${pick(["[x]", "[X]", "a\\[x]"])}`,
          "```text\n- [x] Done\n1. [ ] Pending\n```",
          "```json\n[\n  1,\n  2\n]\n```",
          `${pick(prefixes)}${pick(pieces)}\n${body}\n${pick(pieces)}`,
        ]),
      );
    } else if (i % 13 === 8) {
      const prefix = pick(["", "> ", "  "]);
      const delimiter = pick([".", ")"]);
      bodies.push(`${prefix}a\n${prefix}2${delimiter} b\n${prefix}1${delimiter} c\n${prefix}4${delimiter} d`);
    } else if (i % 13 === 9) {
      const fence = pick(["```", "~~~"]);
      const prefix = pick(["", ">", "> ", ">> ", "- > ", "   "]);
      const continuation = pick([
        "",
        ">",
        "> ",
        ">   ",
        ">\t",
        ">>    ",
        "  >    ",
        "    ",
        "\t",
        " \t",
        "     ",
        "      ",
      ]);
      const content = pick(["", "\n", `${continuation} \t\n`, `${continuation}code\n`]);
      bodies.push(`${prefix}${fence}${pick(["go", "ts", "text"])}\n${content}${continuation}${fence}${fence[0]}`);
    } else if (i % 13 === 10) {
      bodies.push(
        `${pick(["-", "> -", ">> -", "- > -", "2.", "2)", "- 2.", "1. 2.", "> - 2."])}\n${pick(["", " ", "   ", "\t", "> ", " >   ", ">\t", ">>    "])}${pick(["[X]", "[x]", "[ ]", "[\n   ]"])} done`,
      );
    } else if (i % 13 === 11) {
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
    } else if (i % 13 === 12) {
      const between = pick([
        "\n\nExpected\n\n",
        "\nExpected\n\n",
        "\nlazy\n",
        "\n\u00a0\nlazy\n",
        "\n\n   indented\n",
        "\n\n- divider\n",
        "\n\n> divider\n",
        "\n\n```text\ncode\n```\n",
      ]);
      bodies.push(`1. a\n2. b${between}1. c\n2. d`);
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
    ...oracleHostile.map(([, body]) => body),
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

test("owner bodies remain accepted and preserve renderer coverage", () => {
  for (const body of ownerBodies) {
    assert.equal(hiddenMarkdownReason(body), null, JSON.stringify(body));
    assert.doesNotThrow(() => checkCoverage(body), JSON.stringify(body));
  }
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
    "`a[x]`",
    "    a[X]",
    "a\\[x]",
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
// The checker-only hostile cases likewise cover GitHub text filters and clipping.
test("coverage catches each observable refusal-class mutation", (t) => {
  for (const [kind, body] of hostile) {
    assert.equal(hiddenMarkdownReason(body), `hidden Markdown in the body: ${kind}`, body);
  }
  for (const kind of new Set(oracleHostile.map(([kind]) => kind))) {
    const mutated = (body: string) => {
      const reason = hiddenMarkdownReason(body);
      return reason === `hidden Markdown in the body: ${kind}` ? null : reason;
    };
    const released = oracleHostile.map(([, body]) => body).filter((body) => mutated(body) === null);
    assert.ok(released.length > 0, `${kind}: mutation must release a hostile body`);
    for (const body of released) assert.notEqual(violation(body), null, `${kind}: ${JSON.stringify(body)}`);
    t.diagnostic(`mutation ${kind}: caught=yes`);
  }
});

test("each individual rule has a mutation witness", async (t) => {
  // Mutate this checkout's checker in memory, without runtime test switches or
  // editing its file. Each replacement must name exactly one existing guard.
  const checkerSource = await readFile(new URL("./markdown.ts", import.meta.url), "utf8");
  const mutations = [
    {
      name: "ordered markers ignore fence guesses",
      from: "const markerColumn = columns(line.slice(0, marker.index));",
      to: "if (fenceRun) break; const markerColumn = columns(line.slice(0, marker.index));",
      body: "- a\n  ```\n2. a\n   [\n   ] x",
      kind: "task marker",
      checkerOnly: true,
    },
    {
      name: "fence flag survives apparent closers",
      from: "orderedItem?.sawFence || ",
      to: "",
      body: "2. a\n   ```\n   code\n   ```\n   - [ ] x",
      kind: "task marker",
      checkerOnly: true,
    },
    {
      name: "context beginning inside a fence",
      from: " || fenceRun !== null",
      to: "",
      body: "```text\n104. a\n     - [ ] b\n```",
      kind: "task marker",
      checkerOnly: true,
    },
    {
      name: "ordered boundary needs column zero",
      from: "/^\\S/u.test(boundaryLine) &&",
      to: "",
      body: "2. a\n   ```\n   code\n   ```\n\n text\n   - [ ] x",
      kind: "task marker",
      checkerOnly: true,
    },
    {
      name: "deeper quote cannot end context",
      from: "quoteDepth <= orderedItem.quoteDepth &&",
      to: "",
      body: "2. a\n   ```\n   code\n   ```\n> # h\n> - [ ] x",
      kind: "task marker",
      checkerOnly: true,
    },
    {
      name: "literal-one sibling ends context",
      from: "markerColumn <= orderedItem.markerColumn",
      to: "false",
      body: "2. a\n1. b\n   [\n   ] x",
      kind: null,
    },
    {
      name: "escape before closing bracket",
      from: 'line.slice(0, boxEnd < 0 ? line.length : boxEnd + 1).includes("\\\\")',
      to: 'line.slice(0, line.indexOf("[")).includes("\\\\")',
      body: "- [x\\] Done",
      kind: "task marker",
      checkerOnly: true,
    },
    {
      name: "escaped split closing bracket",
      from: '(lines[index + 1] ?? "").replaceAll("\\\\", "")',
      to: 'lines[index + 1] ?? ""',
      body: "- [\n  \\] Done",
      kind: "task marker",
      checkerOnly: true,
    },
    {
      name: "empty marker content lookahead",
      from: "([ \\t]+)(?=\\S)/u.exec(line)",
      to: "([ \\t]+)/u.exec(line)",
      body: "2. a\n   - \n       - [ ] x",
      kind: "task marker",
      checkerOnly: true,
    },
    {
      name: "margin wrap retires nested levels",
      from: "if (orderedItem && content)",
      to: "if (orderedItem && content && indent > 0)",
      body: "2. a\n   - b\nwrapped\n       - [ ] x",
      kind: "task marker",
      checkerOnly: true,
    },
    {
      name: "blank-start numbering padding",
      from: "blankStart ? 1 : columns(marker[0] + spacing) - markerEnd",
      to: "columns(marker[0] + spacing) - markerEnd",
      body: "1. a\n2.    \n   ## h\n2. c",
      kind: "list number",
    },
    {
      name: "blank-start ordered context padding",
      from: "end === line.length ? 1 : columns(line.slice(0, end)) - markerEnd",
      to: "columns(line.slice(0, end)) - markerEnd",
      body: "2.    \n   text\n       - [ ] x",
      kind: "task marker",
      checkerOnly: true,
    },
    {
      name: "blank-start block restart",
      from: 'if (number === 1 && previous !== 1 && blankItemBlock) return refusal("list number");',
      to: "",
      body: "1. a\n2.\n   ## h\n1. c",
      kind: "list number",
      checkerOnly: true,
    },
    {
      name: "block at content column stays in item",
      from: "prefix.length >= contentColumn",
      to: "prefix.length > contentColumn",
      body: "1. a\n2.\n   ## h\n1. c",
      kind: "list number",
      checkerOnly: true,
    },
    {
      name: "only ASCII whitespace is a blank line",
      from: "if (orderedItem && content)",
      to: "if (orderedItem && content.trim())",
      body: "2. a\n   - b\n\n   \u00a0\n       - [ ] x",
      kind: "task marker",
      checkerOnly: true,
    },
    {
      name: "retire every ended level",
      from: "while (indent < (orderedItem.levels.at(-1) ?? 0))",
      to: "if (indent < (orderedItem.levels.at(-1) ?? 0))",
      body: "2. a\n   - b\n     - c\n   ---\n       - [ ] x",
      kind: "task marker",
      checkerOnly: true,
    },
    {
      name: "retain the open parent level",
      from: "orderedItem.levels.pop();",
      to: "orderedItem.levels.length = 0;",
      body: "2. a\n   - b\n     - c\n     ---\n       - [ ] x",
      kind: null,
    },
    ...[
      ["thematic break", "2. a\n   - b\n   ---\n       - [ ] x"],
      ["dedented paragraph", "2. a\n   - b\n\n   text\n       - [ ] x"],
      ["heading", "2. a\n   - b\n   ## Next\n       - [ ] x"],
    ].map(([boundary, body]) => ({
      name: `retire nested level at ${boundary}`,
      from: "while (indent < (orderedItem.levels.at(-1) ?? 0)) orderedItem.levels.pop();",
      to: "",
      body: body as string,
      kind: "task marker",
      checkerOnly: true,
    })),
    {
      name: "nested marker needs content",
      from: String.raw`/^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)(?=\S)/u`,
      to: String.raw`/^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+|$)/u`,
      body: "2. a\n   -\n       - [ ] x",
      kind: "task marker",
      checkerOnly: true,
    },
    {
      name: "block boundary resets numbering",
      from: "flat && endsList(line, sequenceContentColumn)",
      to: "false",
      body: "1. a\n2. b\n## Expected\n1. c\n2. d",
      kind: null,
    },
    {
      name: "thematic boundary resets numbering",
      from: " || thematicBreak(content)",
      to: "",
      body: "1. a\n2. b\n---\n1. c\n2. d",
      kind: null,
    },
    {
      name: "block boundary must precede item content",
      from: "prefix.length >= contentColumn",
      to: "false",
      body: "1. a\n2. b\n   ## Expected\n1. c\n2. d",
      kind: "list number",
    },
    {
      name: "block boundary clears task context",
      from: "headingOrBreak(boundaryLine)",
      to: "false",
      body: "104. a\n## Expected\n[\n] literal",
      kind: null,
    },
    ...["- [ ]", "- [x] done"].map((box) => ({
      name: `canonical fenced task ${box}`,
      from: "const fencedContext = orderedItem?.sawFence || fenceRun !== null;",
      to: "const fencedContext = false;",
      body: `2. a\n   \`\`\`text\n   ${box}\n   \`\`\``,
      kind: "task marker",
      checkerOnly: true,
    })),
    {
      name: "digit-letter checked box at end of line",
      from: String.raw`\[[ xX]\](?:[ \t]|$)`,
      to: String.raw`\[[ xX]\][ \t]`,
      body: "2. a\n\n   1h [x]\n\nx",
      kind: "task marker",
      checkerOnly: true,
    },
    {
      name: "split box closing line",
      from: String.raw`if (split && !/^[\s>]*\]/u.test((lines[index + 1] ?? "").replaceAll("\\", ""))) continue;`,
      to: "",
      body: '1. Create\n2. Set:\n\n   ```json\n   [\n     "a"\n   ]\n   ```',
      kind: null,
    },
    {
      name: "column-zero fence ends ordered context",
      from: "(fence !== null && /^[`~]/u.test(boundaryLine))",
      to: "false",
      body: "1. a\n2. b\n```text\n[\n] literal\n```",
      kind: null,
    },
    {
      name: "nearest list content column",
      from: "indent >= (orderedItem.levels.at(-1) ?? orderedItem.contentColumn) + 4",
      to: "indent >= orderedItem.contentColumn + 4",
      body: "1. a\n2. Step\n   - [ ] a\n     - [ ] b\n       - [ ] c",
      kind: null,
    },
    {
      name: "list content column advances",
      from: "orderedItem.levels.push(markerEnd + (padding > 0 && padding <= 4 ? padding : 1));",
      to: "",
      body: "2. Step\n    - [ ] a\n        - [ ] b",
      kind: null,
    },
    {
      name: "thematic break is not a list item",
      from: "!thematicBreak(content)",
      to: "true",
      body: "2. a\n   - - -\n        - [ ] c",
      kind: "task marker",
      checkerOnly: true,
    },
    {
      name: "long marker-only predecessor",
      from: String.raw`/^(?:[\s>]|[-*+]|\d+[.)])*(?:[-*+]|\d+[.)])[ \t]*$/u`,
      to: String.raw`/^(?:[\s>]|[-*+]|\d{1,9}[.)])*(?:[-*+]|\d{1,9}[.)])[ \t]*$/u`,
      body: "1234567890.\n   [\n   ] x",
      kind: "task marker",
      checkerOnly: true,
    },
    {
      name: "end-of-line scanner box",
      from: String.raw`\[[ xX]\](?:[ \t]|$)`,
      to: String.raw`\[[ xX]\][ \t]`,
      body: "- a\n\n  1h [x]\n\nend",
      kind: "task marker",
      checkerOnly: true,
    },
    {
      name: "long task chain",
      from: String.raw`/^((?:[\s>]|[-*+]|\d+[.)])*)\[(?:([\sxX])\]|\s*$)/u`,
      to: String.raw`/^((?:[\s>]|[-*+]|\d{1,9}[.)])*)\[(?:([\sxX])\]|\s*$)/u`,
      body: "- 1234567890.[ ] x",
      kind: "list number",
      checkerOnly: true,
    },
    {
      name: "escaped box chain",
      from: 'line.slice(0, boxEnd < 0 ? line.length : boxEnd + 1).includes("\\\\")',
      to: "false",
      body: "104. a\n     \\- [ ] x",
      kind: "task marker",
      checkerOnly: true,
    },
    {
      name: "later bare split box",
      from: " || orderedItem)",
      to: ")",
      body: "104. a\n     [\n     ] Done",
      kind: "task marker",
      checkerOnly: true,
    },
    {
      name: "later indented box",
      from: " || indent >= (orderedItem.levels.at(-1) ?? orderedItem.contentColumn) + 4",
      to: "",
      body: "104. a\n         - [ ] x",
      kind: "task marker",
      checkerOnly: true,
    },
    {
      name: "later fenced box",
      from: "const fencedContext = orderedItem?.sawFence || fenceRun !== null;",
      to: "const fencedContext = false;",
      body: "104. a\n     ```text\n     x\n     - [ ] bar\n     ```",
      kind: "task marker",
      checkerOnly: true,
    },
    {
      name: "ordered item boundary",
      from: " || followsContextBlank",
      to: "",
      body: "104. a\n\nExpected\n\n[\n] literal",
      kind: null,
    },
    {
      name: "nested number width",
      from: String.raw`/^(?:[\s>]|[-*+]|\d{1,9}[.)])+\d{2,9}[.)](?=[ \t]|$)/u`,
      to: "/a^/u",
      body: "- 888. x",
      kind: "list number",
      checkerOnly: true,
    },
    {
      name: "nested-chain zero",
      from: String.raw`/^(?:[\s>]|[-*+]|\d{1,9}[.)])*0\d{0,8}[.)](?=[ \t]|$)/u`,
      to: String.raw`/^[\s>]*0\d{0,8}[.)](?=[ \t]|$)/u`,
      body: "- 0. x",
      kind: "list number",
    },
    { name: "onesOnly", from: "onesOnly || ", to: "", body: "1.\n1.\n2.", kind: "list number" },
    { name: "flat numbering", from: "!flat || ", to: "", body: "1. a\n   2. b\n3. c", kind: "list number" },
    {
      name: "numbered task item",
      from: 'number[1] !== "1"',
      to: "false",
      // The inner literal-one marker is exempt from the cmark scanner; the
      // rendered-text policy still forbids a non-one number earlier in the chain.
      body: "2. 1. [x] a",
      kind: "list number",
      checkerOnly: true,
    },
    {
      name: "task box alphabet",
      from: String.raw`[\sxX]`,
      to: String.raw`[\s\S]`,
      body: "- [a] item",
      kind: null,
    },
    {
      name: "marker-only box continuation",
      from: "if (followsMarker)",
      to: "if (false)",
      body: "1.\n   [\n   ] Done",
      kind: "task marker",
      checkerOnly: true,
    },
    {
      name: "cmark digit task scanner",
      from: String.raw`/^(?:[\s>]|[-*+]|\d{1,9}[.)])*\d+[^\n][ \t]+\[[ xX]\](?:[ \t]|$)/u`,
      to: "/a^/u",
      body: "2. a\n\n   9x [ ] b",
      kind: "task marker",
      checkerOnly: true,
    },
    {
      name: "cmark task container prefixes",
      from: String.raw`/^(?:[\s>]|[-*+]|\d{1,9}[.)])*\d+[^\n][ \t]+\[[ xX]\](?:[ \t]|$)/u`,
      to: String.raw`/^[ \t]*\d+[^\n][ \t]+\[[ xX]\](?:[ \t]|$)/u`,
      body: "> - Steps\n>\n>   9x [ ] Continue",
      kind: "task marker",
      checkerOnly: true,
    },
    {
      name: "cmark task container exception",
      from: String.raw`/^(?:[\s>]|[-*+]|\d{1,9}[.)])*1[.)][ \t]+\[/u`,
      to: String.raw`/^[ \t]*1[.)][ \t]+\[/u`,
      body: "> 1. [x] Done",
      kind: null,
    },
    {
      name: "raw-line checked state",
      from: String.raw`task[2] === " " && /\[[xX]\]/u.test(line)`,
      to: "false",
      body: "- [ ] a[x]",
      kind: "task marker",
      checkerOnly: true,
    },
    {
      name: "restart availability",
      from: "flat && followsBlank",
      to: "false",
      body: "Steps\n\n1. a\n2. b\n\nExpected\n\n1. c\n2. d\n3. e",
      kind: null,
    },
    {
      name: "restart requires blank line",
      from: "followsBlank && ",
      to: "",
      body: "1. a\n2. b\nlazy\n1. c\n2. d",
      kind: "list number",
    },
    {
      name: "restart requires Markdown blank",
      from: String.raw`const followsBlank = index > 0 && /^[ \t]*$/u.test(lines[index - 1] ?? "")`,
      to: String.raw`const followsBlank = index > 0 && /^\s*$/u.test(lines[index - 1] ?? "")`,
      body: "1. a\n\u00a0\nb\n1.\n2.",
      kind: "list number",
    },
    {
      name: "restart requires column zero",
      from: String.raw`/^\S/u.test(line) && `,
      to: "",
      body: "1. a\n2. b\n\n   indented\n1. c\n2. d",
      kind: "list number",
    },
    {
      name: "restart excludes ordered markers",
      from: String.raw`/^\S/u.test(line) && !marker`,
      to: String.raw`/^\S/u.test(line)`,
      body: "1. a\n\n9. b",
      kind: "list number",
    },
    {
      name: "closer character",
      from: "closer[0] === needsContent[0] && ",
      to: "",
      body: "```go\n~~~",
      kind: null,
    },
    {
      name: "closer length",
      from: " && closer.length >= needsContent.length",
      to: "",
      body: "````go\n```",
      kind: null,
    },
    {
      name: "closer suffix",
      from: String.raw`[ \t]*$/u.exec(content)`,
      to: "/u.exec(content)",
      body: "```go\n```text\ncode",
      kind: null,
    },
    {
      name: "closer indentation",
      from: " && indent <= openerIndent + 3",
      to: "",
      body: "```text\n\t```\n```",
      kind: null,
    },
    {
      name: "opener indentation",
      from: "const opener = /^ {0,3}",
      to: "const opener = /^",
      body: " ```go\n ``` ",
      kind: "empty code block",
    },
    {
      name: "empty fence at EOF",
      from: 'return needsContent ? refusal("empty code block") : null;',
      to: "return null;",
      body: "```ts",
      kind: "empty code block",
    },
  ] as const;
  for (const mutation of mutations) {
    const { name, from, to, body, kind } = mutation;
    const checkerOnly = "checkerOnly" in mutation && mutation.checkerOnly;
    await t.test(name, async (caseTest) => {
      const parts = checkerSource.split(from);
      assert.equal(parts.length, 2, `${name}: exactly one mutation target must exist`);
      const source = stripTypeScriptTypes(parts.join(to));
      const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
      const mutated = (input: string): string | null => module.hiddenMarkdownReason(input);
      assert.equal(hiddenMarkdownReason(body), kind === null ? null : `hidden Markdown in the body: ${kind}`, name);
      if (kind === null) {
        // Broadening a refusal or removing an acceptance guard makes the checker
        // stricter. An oracle-approved owner form must catch that loss.
        assert.equal(violation(body), null, `${name}: witness must preserve coverage`);
        assert.notEqual(mutated(body), null, `${name}: mutation must falsely refuse its witness`);
      } else {
        assert.equal(mutated(body), null, `${name}: mutation must release its hostile witness`);
        if (checkerOnly) {
          assert.equal(violation(body), null, `${name}: remark does not model this cmark behavior`);
        } else {
          assert.notEqual(violation(body), null, `${name}: oracle must flag the released witness`);
        }
      }
      const evidence = kind === null ? "acceptance" : checkerOnly ? "raw refusal" : "oracle";
      caseTest.diagnostic(`rule mutation ${name}: caught=yes (${evidence})`);
    });
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
