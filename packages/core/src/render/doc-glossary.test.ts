import { LIMITS } from "@emend/contract";
import { expect, test } from "vitest";
import { type RenderEffects, renderDoc } from "./markdown.ts";

async function render(markdown: string) {
  const effects: RenderEffects = {};
  const blocks = await renderDoc(markdown, "guide.md", undefined, undefined, effects);
  return { blocks, terms: effects.terms, html: blocks.map((block) => block.html).join("") };
}
const marks = (html: string) => [...html.matchAll(/<span class="emend-term" data-emend-term="(\d+)">([^<]*)<\/span>/g)];

const doc = (glossary: string, body = "The budget is spent on a hub. Allowance and BUDGET again.") =>
  `# Title\n\n${body}\n\n## Glossary\n\n${glossary}\n`;

test("reads both forms, aliases and a nested definition from a tight list", async () => {
  const { terms, html } = await render(
    doc(
      [
        "- **Budget** (also: allowance, quota):",
        "  Attempts a worker may spend.",
        "- **Hub:** The machine the phone reaches.",
        "  - nested detail",
        "- **Lease (also: rental):** A hand-off claim.",
      ].join("\n"),
    ),
  );
  expect(terms?.map((term) => term.term)).toEqual(["Budget", "Hub", "Lease"]);
  expect(terms?.[0]?.definition).toBe("Attempts a worker may spend.");
  expect(terms?.[1]?.definition).toBe("The machine the phone reaches. nested detail");
  expect(terms?.[2]?.definition).toBe("A hand-off claim.");
  expect(marks(html).map((m) => [m[1], m[2]])).toEqual([
    ["0", "budget"],
    ["1", "hub"],
  ]);
});

test("a first-use mark is made per entry, aliases included", async () => {
  const { html } = await render(doc("- **Budget** (also: allowance):\n  Attempts.", "An allowance is a budget."));
  expect(marks(html).map((m) => [m[1], m[2]])).toEqual([["0", "allowance"]]);
});

test("reads a loose list and keeps later paragraphs in the definition", async () => {
  const { terms } = await render(doc("- **Hub:** First part.\n\n  Second part.\n\n- **Lease:** Claim."));
  expect(terms?.map((term) => term.definition)).toEqual(["First part. Second part.", "Claim."]);
});

test("leaves the glossary list and its heading unmarked", async () => {
  const { html } = await render(doc("- **Hub:** The hub is where hubs live.", "Nothing here."));
  expect(marks(html)).toHaveLength(0);
});

test("blockIds name the blocks that hold the entries", async () => {
  const { blocks, terms } = await render(doc("- **Hub:** The machine.\n- **Lease:** A claim."));
  expect(terms).toHaveLength(2);
  for (const term of terms ?? []) {
    const block = blocks.find((candidate) => candidate.id === term.blockId);
    expect(block?.kind).toBe("item");
    expect(block?.text.startsWith(term.term)).toBe(true);
  }
  expect(new Set(terms?.map((term) => term.blockId)).size).toBe(2);
});

test("a diagram inside an entry cannot shift its block id", async () => {
  const { blocks, terms } = await render(
    doc("- **Hub:** The machine.\n\n  ```mermaid\n  graph TD; A-->B\n  ```\n\n  After.\n- **Lease:** A claim."),
  );
  const hub = blocks.find((block) => block.id === terms?.[0]?.blockId);
  expect(hub?.kind).toBe("item");
  expect(hub?.text).toContain("Hub:");
});

test("skips invalid and duplicate entries, drops duplicate aliases", async () => {
  const { terms } = await render(
    doc(
      [
        "- **Hub:** One.",
        "- **hub** (also: node, node, HUB): Two.",
        "- **Lease** (also: node, claim): Three.",
        "- **Empty:**",
        "- plain item: nope",
        "- **No colon** here",
        "- **x".concat("y".repeat(LIMITS.glossaryTermChars + 1), ":** Long."),
      ].join("\n"),
    ),
  );
  expect(terms?.map((term) => term.term)).toEqual(["Hub", "Lease"]);
});

test("applies the entry and alias limits", async () => {
  const many = Array.from({ length: LIMITS.glossaryTerms + 5 }, (_, i) => `- **Term${i}x:** Def ${i}.`).join("\n");
  expect((await render(doc(many))).terms).toHaveLength(LIMITS.glossaryTerms);
  const aliases = Array.from({ length: LIMITS.glossaryAliases + 3 }, (_, i) => `alias${i}z`).join(", ");
  const { html } = await render(
    doc(`- **Root** (also: ${aliases}):\n  Def.`, `alias${LIMITS.glossaryAliases + 1}z alias0z`),
  );
  expect(marks(html).map((m) => m[2])).toEqual(["alias0z"]);
});

test("cuts a long definition the way the writeup does", async () => {
  const { terms } = await render(doc(`- **Hub:** ${"word ".repeat(LIMITS.glossaryDefinitionChars)}`));
  const definition = terms?.[0]?.definition ?? "";
  expect(definition).toHaveLength(LIMITS.glossaryDefinitionChars);
  expect(definition.endsWith("…")).toBe(true);
});

test("uses only the first Glossary heading, at any level, and needs a list right after it", async () => {
  const first = await render("### glossary \n\n- **Hub:** A.\n\n# Glossary\n\n- **Lease:** B.\n\nhub lease");
  expect(first.terms?.map((term) => term.term)).toEqual(["Hub"]);
  expect((await render("## Glossary\n\nSome prose.\n\n- **Hub:** A.\n\nhub")).terms).toBeUndefined();
  expect((await render("## Glossary\n\n```\ncode\n```\n\n- **Hub:** A.\n\nhub")).terms).toBeUndefined();
});

test("a doc without a glossary section renders exactly as before", async () => {
  const source = "# Title\n\nThe hub and the budget.\n\n## Glossary terms\n\n- **Hub:** A thing.\n";
  const withTerms = await render(source);
  expect(withTerms.terms).toBeUndefined();
  expect(withTerms.html).not.toContain("emend-term");
  const plain = await renderDoc(source, "guide.md");
  expect(plain.map((block) => block.html)).toEqual(withTerms.blocks.map((block) => block.html));
});

test("hostile terms, definitions and raw HTML stay inert text", async () => {
  const { blocks, terms, html } = await render(
    doc(
      [
        "- **<script>alert(1)</script>Hub** (also: <img src=x onerror=alert(1)>):",
        "  Skipped: the alias group is broken by markup.",
        "- **<script>alert(1)</script>Node <b onclick=x>x</b>:** Def <script>alert(2)</script> <img src=x onerror=alert(3)> [click](javascript:alert(4)) <b onclick=x>bold</b>",
        "- **Lease:** Safe <iframe src=//evil></iframe> [link](javascript:alert(5))",
        "<div onclick=alert(6)>raw</div>",
      ].join("\n"),
      "node lease Lease hub <script>alert(7)</script>",
    ),
  );
  for (const text of [html, ...blocks.map((block) => block.html)]) {
    expect(text).not.toMatch(/<script|onerror|onclick|javascript:|<iframe/i);
  }
  // Definitions are plain text taken from the sanitized tree: nothing in them ever becomes markup.
  for (const term of terms ?? [])
    expect(term.definition).not.toMatch(/alert\(\d\)\)?\s*<\/?script|onerror=alert\(3\)>/);
  expect(terms?.map((term) => term.term)).toEqual(["Node x", "Lease"]);
  for (const term of terms ?? []) expect(term.definition).not.toContain("javascript:");
  for (const [, , text] of marks(html)) expect(text).not.toMatch(/[<>&]/);
});
