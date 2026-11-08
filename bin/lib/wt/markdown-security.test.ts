import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { evaluateIssue } from "./issues.ts";
import { hiddenMarkdownReason } from "./markdown.ts";
import { issueEdits, READY_LABEL, readyIssue } from "./test-support.ts";

// A checkbox save is an owner revision of text originally supplied by an outsider.
const evaluate = (body: string, extra: Record<string, unknown> = {}, scanMarkdown = hiddenMarkdownReason) =>
  evaluateIssue(
    readyIssue(42, {
      body,
      author: { login: "outsider" },
      userContentEdits: issueEdits(
        [{ editedAt: "2026-01-01T00:00:00Z", editor: { login: "owner" } }],
        false,
        "outsider",
      ),
      ...extra,
    }),
    "owner",
    new Map(),
    READY_LABEL,
    scanMarkdown,
  ).row;
const reason = (kind: string) => `hidden Markdown in the body: ${kind}`;
const asset = "https://github.com/user-attachments/assets/01234567-89ab-cdef-0123-456789abcdef";
const screenshot = (alt: string, url = asset) => `![${alt}](${url})`;

for (const [name, body, kind] of [
  ["zero-led marker after dash", "- 00000001. x", "list number"],
  ["zero-led marker after ordered marker", "1. 007. x", "list number"],
  ["zero-led marker after quote and bullet", "> - 0009. x", "list number"],
  ["zero-only nested marker", "- 0.", "list number"],
  ["zero-led parenthesized nested marker", "1. 01) a", "list number"],
  ["zero-led marker after star", "* 011. ", "list number"],
  ["zero-led marker after plus", "+ 01. x", "list number"],
  ["zero-led marker inside code", "```text\n- 01. x\n```", "list number"],
  ["one-space empty fence", " ```go\n ``` ", "empty code block"],
  ["three-space empty fence", "   ```go\n   ``` ", "empty code block"],
  ["three-space empty fence at EOF", "   ```ts", "empty code block"],
  ["indented empty fence in list", "1. a\n   ```ts\n   ```", "empty code block"],
  ["longer matching fence closer", "```go\n```` \t", "empty code block"],
  ["matching tilde closer", "~~~go\n~~~~", "empty code block"],
  ["counting restart in later list", "1. Steps\n2. More\n\nExpected\n\n1. c\n2. d", "list number"],
  ["flat counts with later nesting", "1. a\n2. b\n\n- x\n  1. y\n  1. z", "list number"],
] as const) {
  test(`raw Markdown Round 4 refuses ${name}`, () => {
    assert.equal(evaluate(body).reason, reason(kind), body);
  });
}

for (const [name, body] of [
  ["ten as list start", "10. x"],
  ["hundred as list start", "100. x"],
  ["nonzero nested list start", "- 7. x"],
  ["nonzero start after ordered marker", "1. 7. x"],
  ["nonzero start after quote and bullet", "> - 9. x"],
  ["nested ten", "- 10. x"],
  ["nested hundred", "1. 100. x"],
  ["zero-led digits after text", "Text 01. x"],
  ["tilde content in backtick fence", "```go\n~~~"],
  ["backtick content in tilde fence", "~~~go\n```"],
  ["short backtick run as content", "````go\n```"],
  ["short tilde run as content", "~~~~go\n~~~"],
  ["fence run with info as content", "```go\n```text\ncode"],
  ["quoted empty fence allowance", "> ```go\n> ```"],
  ["list fence with content", "1. a\n   ```ts\n   code\n   ```"],
  ["deep list fence allowance", "1. a\n    ```ts\n    ```"],
  ["ones in later list", "1. Steps\n2. More\n\nExpected\n\n1. c\n1. d"],
] as const) {
  test(`raw Markdown Round 4 permits ${name}`, () => {
    assert.equal(evaluate(body).status, "pickable", body);
  });
}

// Bounded container-fence allowance: its empty code box stays visible, and the
// hidden info word comes from the fixed allowlist even when the container ends.
for (const [name, body] of [
  ["leaving tight quote fence", ">```ts\ne"],
  ["blank line ends quote fence", ">```ts\n\n>a"],
  ["indented line ends quote fence", ">```ts\n    >a"],
  ["leaving indented list fence", "1. a\n   ```ts\ncode"],
  ["leaving list opener fence", "- ```ts\ne"],
  ["losing one quote marker", ">> ```ts\n> code"],
  ["losing quote indentation", ">   ```ts\n> code"],
  ["losing list before quote", "- > ```ts\n> code"],
  ["quoted empty tilde fence", "> ~~~go\n>    ~~~~"],
  ["quoted empty backtick fence", "> ```go\n>    ````"],
  ["nested quoted empty fence", ">> ~~~go\n>>    ~~~~"],
  ["list quote empty fence", "- > ~~~go\n  >    ~~~~"],
  ["tabbed quote empty fence", "> ~~~go\n>\t~~~~"],
  ["empty quote fence", "> ```ts\noutside"],
  ["empty list fence", "- ```ts\noutside"],
  ["whitespace-only quote fence", "> ```ts\n> \t\n> ```"],
  ["ordered opener at EOF", "1. ```ts"],
  ["CRLF quote fence", " > ```ts\r\n\r\n>a"],
] as const) {
  test(`raw Markdown Round 3c permits ${name}`, () => {
    assert.equal(evaluate(body).status, "pickable", body);
  });
}

for (const [name, body] of [
  ["empty column-zero go fence", "```go\n```"],
  ["blank column-zero ts fence", "```ts\n\n```"],
  ["empty column-zero fence after quote", "> outside\n\n```ts\n```"],
] as const) {
  test(`raw Markdown Round 3c refuses ${name}`, () => {
    assert.equal(evaluate(body).reason, reason("empty code block"), body);
  });
}

for (const [name, body, kind] of [
  ["increment after repeated one", "1.\n1.\n2.", "list number"],
  ["same-delimiter restart then increment", "1. a\n2. b\n\ntext\n\n1. c\n2. d", "list number"],
  ["bare lowercase task marker", "-\n[x] e", "task marker"],
  ["bare uppercase task marker", "-\n[X] e", "task marker"],
  ["bare unchecked task marker", "-\n[ ] e", "task marker"],
  ["indented task continuation", "-\n  [x] done", "task marker"],
  ["quoted task continuation", "> -\n>   [x] done", "task marker"],
  ["tabbed lowercase continuation", "> -\n>\t[x] done", "task marker"],
] as const) {
  test(`raw Markdown Round 3b refuses ${name}`, () => {
    assert.equal(evaluate(body).reason, reason(kind), body);
  });
}

for (const [name, body] of [
  ["ones after free start", "5.\n1.\n1."],
  ["sequential numbers across text", "1.\n2.\n\ntext\n\n3."],
  ["changed-delimiter restart then increment", "1. a\n2. b\n\ntext\n\n1) c\n2) d"],
  ["non-one first marker", "7. a\n8. b\n9. c"],
  ["retained quote fence", "> ```ts\n> code\n> ```"],
  ["retained indented list fence", "1. a\n   ```ts\n   code\n   ```"],
  ["retained list before quote", "- > ```ts\n  > code\n  > ```"],
  ["checked list marker", "- [x] done"],
  ["unchecked ordered marker", "1. [ ] step"],
] as const) {
  test(`raw Markdown Round 3b permits ${name}`, () => {
    assert.equal(evaluate(body).status, "pickable", body);
  });
}

for (const [name, body, kind] of [
  ["shifted quote task continuation", "> -\n >   [X] done", "task marker"],
  ["tabbed quote task continuation", "> -\n>\t[X] done", "task marker"],
  ["nested task continuation", "> > -\n > >   [X] done", "task marker"],
  ["paragraph then list", "a\n2. b\n1. c\n4. d", "list number"],
  ["parenthesized paragraph then list", "a\n2) b\n1) c\n4) d", "list number"],
  ["quoted paragraph then list", "> a\n> 2. b\n> 1. c\n> 4. d", "list number"],
  ["nested paragraph then list", "- a\n  2. b\n  1. c\n  4. d", "list number"],
  ["nested sequential numbers", "1. a\n   1. b\n   2. c", "list number"],
  ["later quoted marker", "1. a\n2. b\n> 1. c", "list number"],
  ["indented marker inside code", "1. a\n2. b\n```text\n  1. code\n```", "list number"],
  ["uppercase marker without list prefix", "[X]", "task marker"],
] as const) {
  test(`raw Markdown Round 3 refuses ${name}`, () => {
    assert.equal(evaluate(body).reason, reason(kind), body);
  });
}

for (const [name, body] of [
  ["loose sequential list", "1. a\n\n2. b"],
  ["list after indented fence", "1. a\n   ```ts\n   code\n   ```\n2. b"],
  ["nested all-one list", "1. a\n   1. b\n   1. c"],
  ["quoted all-one list", "> 1. a\n> 1. b"],
  ["mixed delimiters", "1. a\n2) b\n3) c"],
  ["uppercase after text", "> text [X]\n- text [X]\n    a[X]"],
  ["empty fence without info", "```\n```"],
] as const) {
  test(`raw Markdown Round 3 permits ${name}`, () => {
    assert.equal(evaluate(body).status, "pickable", body);
  });
}

for (const [name, body, kind] of [
  ["skipping list number", "1. visible\n987654321. visible", "list number"],
  ["leading-zero list number", "00001. visible", "list number"],
  ["zero list start", "0. visible", "list number"],
  ["mixed list numbering", "1. a\n1. b\n2. c", "list number"],
  ["ambiguous list boundary", "1. a\n\nprose\n\n1. b\n3. c", "list number"],
  ["changed list indentation", "1. a\n  9. b", "list number"],
  ["numbering across parent items", "- 1. a\n- 1. b\n  3. c", "list number"],
  ["wrong screenshot ordinal", screenshot("Screenshot 99"), "alt text"],
  ["zero screenshot ordinal", screenshot("Screenshot 0"), "alt text"],
  ["padded screenshot ordinal", screenshot("Screenshot 01"), "alt text"],
  ["repeated screenshot ordinal", `${screenshot("Screenshot 1")}\n${screenshot("Screenshot 1")}`, "alt text"],
  ["empty word fences", "```go\n```\n```sh\n```", "empty code block"],
  ["whitespace-only fence", "```ts\n \t\n```", "empty code block"],
  ["empty unclosed fence", "~~~ts", "empty code block"],
  ["uppercase task marker", "- [X] done", "task marker"],
  ["uppercase empty task marker", "- [X]", "task marker"],
  ["uppercase ordered task marker", "1. [X] done", "task marker"],
  ["uppercase nested task marker", "> - [X] done", "task marker"],
  ["uppercase continued task marker", "> -\n>   [X] done", "task marker"],
] as const) {
  test(`raw Markdown Round 2 refuses ${name}`, () => {
    assert.equal(evaluate(body).reason, reason(kind), body);
  });
}

for (const [name, body] of [
  ["all-one list", "1. a\n1. b\n1. c"],
  ["sequential list", "1. a\n2. b\n3. c"],
  ["checked task", "- [x] done"],
  ["unchecked task", "- [ ] done"],
  ["literal uppercase brackets", "a[X] [X]\n`a[X]`\n    a[X]"],
  ["numbered screenshot", screenshot("Screenshot 1")],
  ["mixed screenshot labels", ["", "Screenshot", "Screenshot 3"].map((alt) => screenshot(alt)).join("\n")],
  ["non-empty ts fence", "```ts\nconst x = 1;\n```"],
  ["non-empty unclosed fence", "~~~ts\ncode"],
  ["non-empty quote fence", "> ```ts\n> code\n> ```"],
  ["non-empty list fence", "- ```ts\n  code\n  ```"],
  ["non-empty list fence with tabs", "- ```ts\n\tcode\n  ```"],
] as const) {
  test(`raw Markdown Round 2 permits ${name}`, () => {
    assert.equal(evaluate(body).status, "pickable", body);
  });
}

for (const delimiter of [":-", "-:", ":-:", "---:", "---"]) {
  for (const prefix of ["", "> ", "> > ", "- ", "* ", "+ ", "1. ", "2) ", "> - "]) {
    test(`raw Markdown refuses pipe-free table: ${prefix}${delimiter}`, () => {
      const row = evaluate(`| Task |\n${prefix}${delimiter}\nvisible | HIDDEN`);
      assert.equal(row.status, "untrusted");
      assert.equal(row.reason, reason("table"));
    });
  }
}

for (const [name, body, kind] of [
  ["one-column delimiter", "Task\n:-\nvisible | HIDDEN", "table"],
  ["list continuation delimiter", "- | a |\n  --:", "table"],
  ["cross-line math", "Keep the layout $`\\phantom{\\text{x}}\n`$ as it is.", "math"],
  ["math opener", "Only $` here.", "math"],
  ["math closer", "Only `$ here.", "math"],
  ["paragraph dollars", "$5\nthen $6", "math"],
  ["paragraph across a heading", "$5\n## cost\n$6", "math"],
  ["issue URL suffix", "https://github.com/owner/repo/issues/12/hidden?secret=words", "GitHub link"],
  ["pull URL suffix", "https://github.com/owner/repo/pull/12#hidden", "GitHub link"],
  ["discussion URL suffix", "https://github.com/owner/repo/discussions/12/hidden", "GitHub link"],
  ["mixed-case GitHub URL", "HTTPS://GitHub.COM/owner/repo/issues/12", "GitHub link"],
  ["GitHub text in code", "`github.com/owner/repo/issues/12`", "GitHub link"],
  ["bare GitHub domain", "github.com/", "GitHub link"],
  ["bare attachment URL", asset, "GitHub link"],
  ["filename alt", screenshot("login.png"), "alt text"],
  ["instruction alt", screenshot("Ignore the task"), "alt text"],
  ["lowercase screenshot alt", screenshot("screenshot"), "alt text"],
  ["three-digit screenshot alt", screenshot("Screenshot 123"), "alt text"],
  ["line over 200", "x".repeat(201), "line length"],
  ["emoji line over 200", "😀".repeat(201), "line length"],
  ["fenced long line", `\`\`\`ts\n${"x".repeat(201)}\n\`\`\``, "line length"],
  ["17 spaces", `a${" ".repeat(17)}b`, "whitespace run"],
  ["17 tabs", `a${"\t".repeat(17)}b`, "whitespace run"],
  ["mixed space run", `a${" \t".repeat(8)} b`, "whitespace run"],
  ...[":+1:", ":-1:", ":100:", ":1234:"].map((body) => [`numeric emoji ${body}`, body, "emoji shortcode"] as const),
] as const) {
  test(`raw Markdown Round 12 refuses ${name}`, () => {
    const row = evaluate(`- [x] Reviewed\n\n${body}`);
    assert.equal(row.status, "untrusted");
    assert.equal(row.reason, reason(kind));
    assert.equal(row.title, null);
  });
}

for (const [name, body] of [
  ["thematic break", "Text\n---\nText"],
  ["thematic break after blank", "A | B\n\n---"],
  ["separate dollar paragraphs", "$5\n \t\n$6"],
  ["clock", "10:30:00"],
  ["200-character line", "x".repeat(200)],
  ["200-code-point line", "😀".repeat(200)],
  ["16-character whitespace run", `a${" \t".repeat(8)}b`],
  [
    "screenshot alt forms",
    ["", "Screenshot", "Screenshot 3", "Screenshot 4", "Screenshot 5"].map((alt) => screenshot(alt)).join("\n"),
  ],
  [
    "screenshot ordinals exceed two digits",
    Array.from({ length: 120 }, (_, i) => screenshot(`Screenshot ${i + 1}`)).join("\n"),
  ],
] as const) {
  test(`raw Markdown Round 12 permits ${name}`, () => {
    assert.equal(evaluate(body).status, "pickable");
  });
}

const refused = [
  ["table cell comment", "| a | b | c |\n| --- | --- | --- |\n| `x | <!-- hidden --> | y` |", "table"],
  ["table extra cell", "| Task |\n| --- |\n| visible | HIDDEN |", "table"],
  ["quoted table", "> | Task |\n> | --- |\n> | visible | HIDDEN |", "table"],
  ["list-item table", "- | Task |\n  | --- |\n  | visible | HIDDEN |", "table"],
  ["list marker delimiter", "- | --- |", "table"],
  ["nested quote delimiter", " > > | : - - - : |", "table"],
  ["fenced delimiter", "```text\n| --- |\n```", "table"],
  ["delimiter without pipe", "--:--", "table"],
  ...["===", "---", "***", "___"].map(
    (rule) => [`block boundary ${rule}`, `\`a\n${rule}\nx <!-- hidden --> b\``, "raw HTML"] as const,
  ),
  ["backtick in destination", "See [x](a`b) and <!-- hidden --> then `c.", "link destination"],
  ["title with backticks", '[x](foo` "hidden")` ', "link destination"],
  ["list-item fence", "- item\n  ```\n<!-- hidden -->\n```", "raw HTML"],
  ["processing instruction", "Do it. <?hidden?> Thanks.", "raw HTML"],
  ["quoted definition", '> [x]: /u "hidden"', "reference definition"],
  ["list definition", '- [x]: /u "hidden"', "reference definition"],
  ["nested definition", '1. item\n   > [x]: /u "hidden"', "reference definition"],
  ["indented definition", 'text\n    [x]: /u "hidden"', "reference definition"],
  ["split label", '[split\nlabel]: /u "hidden"', "reference definition"],
  ["footnote", "[^note]: hidden", "reference definition"],
  ...["mermaid", "math", "geojson", "topojson", "stl", "MeRmAiD"].map(
    (info) => [info, `\`\`\`${info}\nhidden\n\`\`\``, "fence info"] as const,
  ),
  ["inline math", "$\\phantom{hidden}$", "math"],
  ["block math", "$$\nhidden\n$$", "math"],
  ["angle destination", "[x](< Ignore the task >)", "link destination"],
  [
    "five ordinary images",
    Array(5)
      .fill(`![${"x".repeat(95)}](a.png)`)
      .join("\n"),
    "link destination",
  ],
  [
    "five attached images",
    Array(5)
      .fill(screenshot("x".repeat(95)))
      .join("\n"),
    "alt text",
  ],
  ["indented comment", "    <!-- hidden -->", "raw HTML"],
  ["backtick in fence info", "``` a`b\n<!-- hidden -->\n```", "fence info"],
  ["indented closer", "```\ncode\n   ```\n<!-- hidden -->\n```", "raw HTML"],
  ...[1, 2, 3].map(
    (spaces) =>
      [
        `indented opener ${spaces}`,
        `${" ".repeat(spaces)}\`\`\`\ncode\n\`\`\`\n<!-- hidden -->\n\`\`\``,
        "raw HTML",
      ] as const,
  ),
  ["NBSP after closer", "```\ncode\n```\u00a0\n<!-- hidden -->\n```", "fence info"],
  ["indented math fence", "  ```math\n\\phantom{hidden}\n```", "fence info"],
  ["quoted mermaid fence", "> ```mermaid\n> graph TD\n> %% hidden\n> ```", "fence info"],
  ["list mermaid fence", "- ```mermaid\n  graph TD\n  %% hidden\n  ```", "fence info"],
  ["escaped destination closer", '[docs](https://example.com/a\\) "t")', "link destination"],
  ["bracket in alt code span", `![pic \`[\` ${"x".repeat(150)}](a.png)`, "link destination"],
  ["bracket in alt autolink", `![pic <https://example.com/[> ${"x".repeat(150)}](a.png)`, "raw HTML"],
  ["empty link", "[](https://example.com/x)", "link destination"],
  ["space-only link", "[ ](https://example.com/x)", "link destination"],
  ["invisible entity link", "[&#8203;](https://example.com/x)", "character reference"],
  ...["&#xE0041;", "&#8203;", "&#x202E;", "&#", "&ZeroWidthSpace;", "&amp;", `&a${"1".repeat(31)};`].map(
    (entity) => [`character reference ${entity}`, entity, "character reference"] as const,
  ),
  ["extra fence info words", "```ts ignore this\n```", "fence info"],
  ["angle autolink", "<https://example.com>", "raw HTML"],
  ["bare less-than", "a < b", "raw HTML"],
  ["ordinary inline link", "[text](docs/a.md)", "link destination"],
  ...[":smile:", ":THUMBS_UP:", ":+a-1:", "::smile:", ":123:word:"].map(
    (shortcode) => [`emoji ${shortcode}`, shortcode, "emoji shortcode"] as const,
  ),
] as const;

for (const [name, body, kind] of refused) {
  test(`raw Markdown refuses ${name} after an owner checkbox save`, () => {
    const row = evaluate(`- [x] Reviewed\n\n${body}`);
    assert.equal(row.status, "untrusted");
    assert.equal(row.title, null);
    assert.equal(row.reason, reason(kind));
  });
}

for (const [kind, payload] of [
  ["raw HTML", "<!-- hidden -->"],
  ["reference definition", "[x]: /u"],
  ["link destination", "[x](a.md)"],
  ["character reference", "&#8203;"],
  ["math", "$x$"],
  ["emoji shortcode", ":smile:"],
  ["fence info", "~~~mermaid"],
  ["GitHub link", "github.com/owner/repo/issues/12/hidden"],
  ["whitespace run", `a${" ".repeat(17)}b`],
  ["line length", "x".repeat(201)],
] as const) {
  test(`raw Markdown never exempts ${kind} in code or containers`, () => {
    for (const body of [
      payload,
      `\`${payload}\``,
      `\`\`\`text\n${payload}\n\`\`\``,
      `    ${payload}`,
      `> ${payload}`,
      `- ${payload}`,
    ]) {
      const row = evaluate(body);
      assert.equal(row.status, "untrusted", body);
      assert.equal(row.reason, reason(kind), body);
    }
  });
}

for (const [name, body] of [
  ["plain prose", "Plain instructions."],
  ["headings and lists", "## Summary\n- First item\n1. Second item"],
  ["task list", "- [ ] Pending\n- [x] Complete"],
  ["quote and emphasis", "> quote\n**bold**"],
  ["inline code", "Use `const x = 1;` here."],
  ["ts code", "```ts\nconst x = 1;\n```"],
  ["bare URL", "https://example.com/a?q=1&x=2"],
  ["bare email", "synthetic@example.com"],
  ["issue and mention", "#12 @user"],
  ["pipes in prose", "Choose A | B."],
  ["delimiter without dash", "| : |"],
  ["screenshot", screenshot("Screenshot")],
  ["empty screenshot alt", screenshot("")],
  ["screenshot UUID", screenshot("Screenshot")],
  ["CRLF screenshot", `Before.\r\n${screenshot("Screenshot")}\r\nAfter.`],
  ["clock", "10:30:00"],
  ["numeric colon tokens", ":123: :12: :_-+:"],
  ["unpaired shortcode", ":word :word"],
  ["single dollars in separate paragraphs", "$5\n\n$6"],
  ["incomplete named reference", "&amp"],
  ["named reference beyond limit", `&a${"1".repeat(32)};`],
  ...["0", "9", "#", "*"].map((base) => [`keycap ${base}`, `${base}\ufe0f\u20e3`] as const),
] as const) {
  test(`raw Markdown permits ${name}`, () => {
    assert.equal(evaluate(body).status, "pickable");
  });
}

for (const [name, body, kind] of [
  ["underscore filename", screenshot("login_screen.png"), "alt text"],
  ["alt over 100", screenshot("x".repeat(101)), "alt text"],
  ["alt punctuation", screenshot("Login 12 .,:;'-"), "alt text"],
  ["unapproved 100-character alts", `${screenshot("x".repeat(100))}\n${screenshot("y".repeat(100))}`, "alt text"],
  [
    "unapproved alts exceeding the former total",
    `${screenshot("x".repeat(100))}\n${screenshot("y".repeat(100))}\n${screenshot("z")}`,
    "alt text",
  ],
  ["alt shortcode", screenshot(":smile:"), "alt text"],
  ["leading space", ` ${screenshot("Screenshot")}`, "link destination"],
  ["trailing space", `${screenshot("Screenshot")} `, "link destination"],
  ["quote", `> ${screenshot("Screenshot")}`, "link destination"],
  ["list", `- ${screenshot("Screenshot")}`, "link destination"],
  ["inline prose", `See ${screenshot("Screenshot")}`, "link destination"],
  ["two on one line", `${screenshot("Screenshot 1")}${screenshot("Screenshot 2")}`, "link destination"],
  ["split alt", screenshot("Screen\nshot"), "link destination"],
  ["ordinary link", `[Screenshot](${asset})`, "link destination"],
  ["different host", screenshot("Screenshot", asset.replace("github.com", "example.com")), "link destination"],
  ["host suffix", screenshot("Screenshot", asset.replace("github.com", "github.com.example.com")), "link destination"],
  ["http", screenshot("Screenshot", asset.replace("https:", "http:")), "link destination"],
  ["query", screenshot("Screenshot", `${asset}?x=1`), "link destination"],
  ["fragment", screenshot("Screenshot", `${asset}#x`), "link destination"],
  ["slash", screenshot("Screenshot", `${asset}/`), "link destination"],
  ["empty ID", screenshot("Screenshot", asset.replace("01234567-89ab-cdef-0123-456789abcdef", "")), "link destination"],
  [
    "ID over 64",
    screenshot("Screenshot", asset.replace("01234567-89ab-cdef-0123-456789abcdef", "a".repeat(65))),
    "link destination",
  ],
  [
    "underscore ID",
    screenshot("Screenshot", asset.replace("01234567-89ab-cdef-0123-456789abcdef", "asset_1")),
    "link destination",
  ],
] as const) {
  test(`screenshot exception refuses ${name}`, () => {
    const row = evaluate(body);
    assert.equal(row.status, "untrusted");
    assert.equal(row.reason, reason(kind));
  });
}

const languages =
  "text plaintext console sh bash shell zsh diff json jsonc yaml yml toml ini md markdown ts typescript tsx js javascript jsx mjs css html xml sql python py ruby rb go rust rs http".split(
    " ",
  );
test("raw fence info permits only blank or an allowlisted word with ASCII spaces and tabs", () => {
  for (const prefix of ["", "   ", "> ", "- "]) {
    for (const fence of ["```", "~~~~"]) {
      for (const language of ["", ...languages]) {
        const continuation = prefix === "- " ? "  " : prefix;
        assert.equal(
          evaluate(`${prefix}${fence}\t ${language.toUpperCase()} \t\n${continuation}code\n${continuation}${fence}`)
            .status,
          "pickable",
        );
      }
    }
  }
});

test("Markdown runs only after body ownership and ready trust pass", () => {
  const scan = mock.fn(hiddenMarkdownReason);
  const row = evaluate(
    "<!-- hidden -->",
    {
      author: { login: "outsider" },
      lastEditedAt: null,
      userContentEdits: { nodes: [], pageInfo: { hasNextPage: false } },
    },
    scan,
  );
  assert.equal(row.reason, "current body was not written by the repository owner");
  assert.equal(scan.mock.callCount(), 0, "an untrusted body must never reach the Markdown scanner");
  assert.equal(evaluate("<!-- hidden -->", {}, scan).reason, reason("raw HTML"));
  assert.equal(scan.mock.callCount(), 1, "the spy must observe the trusted-body scan");
  assert.deepEqual(scan.mock.calls[0]?.arguments, ["<!-- hidden -->"]);
});

const size = 65_536;
for (const [name, body, expected] of [
  ["split reference", `${"[\n".repeat(size / 4)}]:${" ".repeat(size / 2 - 2)}`, "line length"],
  ["backticks", "`".repeat(size), "line length"],
  ["angle openers", "<".repeat(size), "line length"],
  ["link openers", "](".repeat(size / 2), "line length"],
  ["shortcode", `:${"1".repeat(size - 3)}a:`, "line length"],
  ["colons", ":".repeat(size), "line length"],
  ["fence info spaces", `\`\`\`${" ".repeat(size - 4)}x`, "line length"],
  ["bounded lines", "abc\n".repeat(size / 4), null],
] as const) {
  test(`64k raw Markdown correctness: ${name}`, () => {
    assert.equal(body.length, size);
    const row = evaluate(body);
    assert.equal(row.status, expected === null ? "pickable" : "untrusted");
    assert.equal(row.reason, expected === null ? null : reason(expected));
  });
}

for (const id of [
  "Synthetic-123",
  "a",
  "a".repeat(64),
  "01234567-89AB-cdef-0123-456789abcdef",
  "0123456789abcdef0123456789abcdef",
]) {
  test(`screenshot requires a lowercase UUID asset id: ${id}`, () => {
    const row = evaluate(`![Screenshot](https://github.com/user-attachments/assets/${id})`);
    assert.equal(row.status, "untrusted");
    assert.equal(row.reason, reason("link destination"));
  });
}
for (const space of ["\u00a0", "\u1680", "\u2000", "\u2003", "\u202f", "\u205f", "\u3000"]) {
  test(`Unicode space does not split a math paragraph: ${space.codePointAt(0)?.toString(16)}`, () => {
    assert.equal(evaluate(`$5\n${space}\n$6`).reason, reason("math"));
    assert.equal(evaluate(`~~~${space}\ncode\n~~~`).reason, reason("fence info"));
    assert.equal(evaluate(`| text |\n${space}\n---`).status, "pickable");
  });
}
