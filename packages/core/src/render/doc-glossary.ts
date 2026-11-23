import { GlossaryForm, LIMITS, normalizeGlossaryForm } from "@emend/contract";
import { type HtmlElement, type HtmlRoot, renderData } from "./blocks.ts";
import { limitDefinition } from "./glossary-definition.ts";
import { normalizeText } from "./normalize.ts";
import { runBreaks, termMatcher } from "./terms.ts";

export type DocGlossaryEntry = { term: string; aliases: string[]; definition: string };

type Child = HtmlElement["children"][number];

const headingTags = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
// Aliases sit in "(also: a, b)" at the end of the head, or after the bold term.
// Both patterns run in linear time on any input, so neither needs a length bound: no free whitespace
// run sits next to another one or a lazy quantifier, and a group cannot span a parenthesis.
const alsoAtEnd = /\(\s*also\s*:([^()]*)\)\s*$/iu;
const alsoAfterTerm = /^\s*(?:\(\s*also\s*:([^()]*)\)\s*)?:/iu;

/** Text of nodes, with a space around block elements so adjacent paragraphs and items do not run together. */
function textOf(nodes: Child[]): string {
  const parts: string[] = [];
  const pending: (Child | string)[] = nodes.toReversed();
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (typeof next === "string") parts.push(next);
    else if (next.type === "text") parts.push(next.value);
    else if (next.type === "element") {
      const breaks = runBreaks.has(next.tagName);
      if (breaks) pending.push(" ");
      for (const child of next.children.toReversed()) pending.push(child);
      if (breaks) pending.push(" ");
    }
  }
  return parts.join("");
}

const blank = (node: HtmlRoot["children"][number]) => node.type === "text" && node.value.trim() === "";

/** The inline content of an item, and whatever follows it (later paragraphs, nested lists). */
function itemParts(item: HtmlElement): { inline: Child[]; rest: Child[] } | undefined {
  const start = item.children.findIndex((child) => !blank(child));
  if (start < 0) return;
  const first = item.children[start];
  const skipBlank = (nodes: Child[]) =>
    nodes.slice(
      Math.max(
        0,
        nodes.findIndex((child) => !blank(child)),
      ),
    );
  if (first?.type === "element" && first.tagName === "p")
    return { inline: skipBlank(first.children), rest: item.children.slice(start + 1) };
  return { inline: item.children.slice(start), rest: [] };
}

function parseItem(item: HtmlElement): DocGlossaryEntry | undefined {
  const parts = itemParts(item);
  if (!parts) return;
  const { inline, rest } = parts;
  const strong = inline[0];
  if (strong?.type !== "element" || strong.tagName !== "strong") return;
  const strongText = textOf(strong.children).trim();
  let head: string;
  let definition: Child[];
  let lead = "";
  if (strongText.endsWith(":")) {
    head = strongText.slice(0, -1);
    definition = inline.slice(1);
  } else {
    const after = inline[1];
    if (after?.type !== "text") return;
    const match = alsoAfterTerm.exec(after.value);
    if (!match) return;
    head = match[1] === undefined ? strongText : `${strongText} (also: ${match[1]})`;
    lead = after.value.slice(match[0].length);
    definition = inline.slice(2);
  }
  head = head.trim();
  let term = head;
  let aliases: string[] = [];
  const split = alsoAtEnd.exec(head);
  if (split) {
    term = head.slice(0, split.index).trim();
    aliases = (split[1] ?? "")
      .split(",")
      .map((alias) => alias.trim())
      .filter((alias) => alias !== "");
  }
  const text = limitDefinition(normalizeText(`${lead}${textOf(definition)} ${textOf(rest)}`));
  return { term, aliases, definition: text };
}

/**
 * The entries of the doc's own glossary: the first top-level heading named "Glossary" followed by one
 * list. Each entry carries the list item it came from, in the same order as the returned entries.
 */
export function extractDocGlossary(tree: HtmlRoot): { entries: DocGlossaryEntry[]; items: HtmlElement[] } | undefined {
  const at = tree.children.findIndex(
    (node) =>
      node.type === "element" &&
      headingTags.has(node.tagName) &&
      normalizeText(textOf(node.children)).toLowerCase() === "glossary",
  );
  if (at < 0) return;
  const list = tree.children.slice(at + 1).find((node) => !blank(node));
  if (list?.type !== "element" || (list.tagName !== "ul" && list.tagName !== "ol")) return;
  renderData(list).emendGlossary = true;
  const entries: DocGlossaryEntry[] = [];
  const items: HtmlElement[] = [];
  const seen = new Set<string>();
  const key = (form: string) => normalizeGlossaryForm(form).toLowerCase();
  for (const item of list.children) {
    if (entries.length >= LIMITS.glossaryTerms) break;
    if (item.type !== "element" || item.tagName !== "li") continue;
    const parsed = parseItem(item);
    if (!parsed || parsed.definition === "") continue;
    // Whitespace is collapsed first, as the bridge does, so a soft break inside a term does not skip it.
    const term = normalizeGlossaryForm(parsed.term);
    if (!GlossaryForm.safeParse(term).success) continue;
    if (seen.has(key(term))) continue;
    seen.add(key(term));
    const aliases: string[] = [];
    for (const raw of parsed.aliases) {
      if (aliases.length >= LIMITS.glossaryAliases) break;
      const alias = normalizeGlossaryForm(raw);
      if (!GlossaryForm.safeParse(alias).success || seen.has(key(alias))) continue;
      seen.add(key(alias));
      aliases.push(alias);
    }
    renderData(item).emendGlossaryItem = entries.length;
    entries.push({ ...parsed, term, aliases });
    items.push(item);
  }
  return { entries, items };
}

/** A no-op unless `renderDoc` asks for it, because the processor is shared with the writeup. */
export function docGlossary() {
  return (tree: HtmlRoot, file: { data: Record<string, unknown> }) => {
    if (file.data.docGlossary !== true) return;
    const found = extractDocGlossary(tree);
    if (!found?.entries.length) return;
    file.data.docGlossaryEntries = found.entries;
    file.data.terms = termMatcher(found.entries);
  };
}
