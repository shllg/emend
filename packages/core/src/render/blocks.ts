import { type BlockId, LIMITS, type RenderedBlockKind } from "@recense/contract";
import { fromHtml } from "hast-util-from-html";
import { toString as hastText } from "hast-util-to-string";
import { blockHash } from "./hash.ts";
import { normalizeText } from "./normalize.ts";

export type Block = {
  id: BlockId;
  section: string;
  kind: RenderedBlockKind;
  html: string;
  text: string;
  source?: string;
};

const sectionBlockId = (section: string, identity: string) => `${section}-${identity}`;
/** Keep content identities and duplicate suffixes when a shared render gets its own section. */
export function resectionBlocks(blocks: Block[], section: string): Block[] {
  return blocks.map((block) => ({
    ...block,
    section,
    id: sectionBlockId(section, block.id.slice(block.section.length + 1)),
  }));
}

export type HtmlRoot = ReturnType<typeof fromHtml>;
export type HtmlElement = Extract<HtmlRoot["children"][number], { type: "element" }>;
export type HtmlNode = HtmlRoot | HtmlRoot["children"][number];

type RenderData = NonNullable<HtmlElement["data"]> & {
  recenseDiagram?: string;
  recenseChart?: boolean;
  recenseMixedPre?: boolean;
  recenseClasses?: string[];
  recenseFootnoteMarker?: boolean;
  /** The doc's glossary list: terms are never marked inside it. */
  recenseGlossary?: boolean;
  /** A glossary list item, numbered like the entries the doc's glossary yielded. */
  recenseGlossaryItem?: number;
  recenseMedia?: string;
  recenseMediaPath?: string;
  recenseUnlistedMediaPath?: string;
};

export function renderData(element: HtmlElement): RenderData {
  element.data ??= { position: {} };
  return element.data as RenderData;
}

export function fenceCode(node: HtmlNode): HtmlElement | undefined {
  if (node.type !== "element" || node.tagName !== "pre" || renderData(node).recenseMixedPre) return;
  let code: HtmlElement | undefined;
  for (const child of node.children) {
    if (child.type === "text" && child.value.trim() === "") continue;
    if (code || child.type !== "element" || child.tagName !== "code") return;
    code = child;
  }
  return code;
}

export function blockText(html: string): string {
  return hastText(fromHtml(html, { fragment: true }));
}

export function visitElements(node: HtmlNode, visit: (element: HtmlElement) => void): void {
  if (node.type === "element") visit(node);
  if ("children" in node) for (const child of node.children) visitElements(child, visit);
}

type Fragment = { kind: Block["kind"]; node: HtmlNode; source?: string };
const MAX_BLOCK_DEPTH = 64;

const blockTags = new Set([
  "blockquote",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "li",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "ul",
]);

export function hasBlockChildren(node: HtmlNode): boolean {
  return (
    "children" in node &&
    node.children.some((child) => child.type === "element" && (blockTags.has(child.tagName) || hasBlockChildren(child)))
  );
}

const isElement = (node: HtmlRoot["children"][number]): node is HtmlElement => node.type === "element";

function isDiagram(node: HtmlNode): boolean {
  return node.type === "element" && renderData(node).recenseDiagram !== undefined;
}

function hasDiagram(node: HtmlNode): boolean {
  return isDiagram(node) || ("children" in node && node.children.some(hasDiagram));
}

function hasContent(nodes: HtmlRoot["children"]): boolean {
  return nodes.some((node) => node.type === "element" || (node.type === "text" && normalizeText(node.value) !== ""));
}

/** Keep surrounding quote/item markup, but emit each nested diagram at its original position. */
function* divideAtDiagrams(node: HtmlElement): Generator<HtmlElement> {
  if (isDiagram(node) || !hasDiagram(node)) {
    yield node;
    return;
  }
  let children: HtmlElement["children"] = [];
  for (const child of node.children) {
    if (child.type !== "element") {
      children.push(child);
      continue;
    }
    for (const piece of divideAtDiagrams(child)) {
      if (isDiagram(piece)) {
        if (hasContent(children)) yield { ...node, children };
        children = [];
        yield piece;
      } else children.push(piece);
    }
  }
  if (hasContent(children)) yield { ...node, children };
}

function diagramFragment(node: HtmlElement): Fragment | undefined {
  const { recenseDiagram: source, recenseChart } = renderData(node);
  if (source !== undefined) return { kind: recenseChart ? "chart" : "diagram", node, source };
}

function* atomicBlock(kind: Block["kind"], node: HtmlElement): Generator<Fragment> {
  for (const piece of divideAtDiagrams(node)) {
    yield diagramFragment(piece) ?? { kind, node: piece };
  }
}

/** Shiki inserts root fragments inside elements; flatten those before classifying children. */
function flattenRoots(node: HtmlNode): HtmlRoot["children"] {
  if (node.type === "root") {
    return node.children.flatMap(flattenRoots);
  }
  if (node.type === "element") {
    node.children = node.children.flatMap(flattenRoots).filter((child) => child.type !== "doctype");
  }
  return [node];
}

function* splitChildren(children: HtmlRoot["children"], depth: number): Generator<Fragment> {
  let inline: HtmlRoot["children"] = [];
  for (const child of children) {
    if (child.type === "element" && (blockTags.has(child.tagName) || hasBlockChildren(child) || hasDiagram(child))) {
      if (hasContent(inline)) yield { kind: "paragraph", node: { type: "root", children: inline } };
      inline = [];
      yield* splitBlocks(child, depth);
    } else if (child.type !== "comment" && child.type !== "doctype") inline.push(child);
  }
  if (hasContent(inline)) yield { kind: "paragraph", node: { type: "root", children: inline } };
}

function blockKind(tag: string): Block["kind"] {
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "li" || tag === "dt" || tag === "dd") return "item";
  if (tag === "pre") return "code";
  if (tag === "table") return "table";
  if (tag === "blockquote") return "quote";
  return "paragraph";
}

function* strayListContent(children: HtmlRoot["children"], depth: number): Generator<Fragment> {
  for (const fragment of splitChildren(children, depth)) {
    yield fragment.source !== undefined ? fragment : { ...fragment, kind: "paragraph" };
  }
}

function* splitBlocks(node: HtmlNode, depth = 0): Generator<Fragment> {
  if (node.type === "root") {
    yield* splitChildren(node.children, depth + 1);
    return;
  }
  if (node.type !== "element") return;
  const diagram = diagramFragment(node);
  if (diagram) {
    yield diagram;
    return;
  }
  const tag = node.tagName;
  if (tag === "hr") return;
  const kind = blockKind(tag);
  if (depth >= MAX_BLOCK_DEPTH) {
    yield* atomicBlock(kind, node);
    return;
  }
  if (tag === "ul" || tag === "ol") {
    let ordinal = typeof node.properties.start === "number" ? node.properties.start : 1;
    let stray: HtmlRoot["children"] = [];
    for (const child of node.children) {
      if (child.type !== "element" || child.tagName !== "li") {
        stray.push(child);
        continue;
      }
      yield* strayListContent(stray, depth + 1);
      stray = [];
      // A list wrapper preserves bullets, task-list classes and ordered numbering.
      const properties = { ...node.properties };
      if (tag === "ol") properties.start = ordinal++;
      for (const fragment of atomicBlock("item", child)) {
        if (fragment.source !== undefined) yield fragment;
        else if (fragment.node.type === "element") {
          yield { ...fragment, node: { ...node, properties, children: [fragment.node] } };
        }
      }
    }
    yield* strayListContent(stray, depth + 1);
    return;
  }
  if (kind === "paragraph" && hasBlockChildren(node)) {
    yield* splitChildren(node.children, depth + 1);
    return;
  }
  yield* atomicBlock(kind, node);
}

function identityText(node: HtmlNode): string {
  // GFM reference numbers and back-reference counts change when other footnotes are inserted.
  // Exclude those generated markers only from identity; block.text keeps the full textContent.
  if (node.type === "element" && renderData(node).recenseFootnoteMarker) return "";
  // A re-shot image at the same path must show as changed.
  if (node.type === "element" && renderData(node).recenseMedia !== undefined)
    return `\u0000media${renderData(node).recenseMedia}`;
  if (node.type === "text") return node.value;
  return "children" in node ? node.children.map(identityText).join("") : "";
}

/** Serialize sanitized HTML without sending a deeply nested subtree through the compiler. */
function stringifyBlock(node: HtmlNode, stringify: (node: HtmlNode) => string): string {
  const parts: string[] = [];
  const pending: (HtmlNode | string)[] = [node];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (typeof next === "string") parts.push(next);
    else if (next.type === "root") {
      for (const child of next.children.toReversed()) pending.push(child);
    } else if (next.type === "element" && next.children.length > 0) {
      // The compiler still escapes every attribute and text node. Raw-text/foreign elements
      // have already been stripped by sanitize, so leaves need no parent-dependent escaping.
      const shell = stringify({ ...next, children: [] });
      const closing = `</${next.tagName}>`;
      if (shell.endsWith(closing)) {
        parts.push(shell.slice(0, -closing.length));
        pending.push(closing);
      } else parts.push(shell);
      for (const child of next.children.toReversed()) pending.push(child);
    } else parts.push(stringify(next));
  }
  return parts.join("");
}

export async function blocksFromTree(
  tree: HtmlRoot,
  section: string,
  stringify: (node: HtmlNode) => string,
  /** Receives the first block cut from each glossary list item, by the item's number. */
  itemIds?: Map<number, BlockId>,
): Promise<Block[]> {
  const blocks: Block[] = [];
  const elementIds = new Map<string, number>();
  visitElements(tree, (element) => {
    const id = element.properties.id;
    if (typeof id === "string") elementIds.set(id, (elementIds.get(id) ?? 0) + 1);
  });
  const occurrences = new Map<string, number>();
  const append = async ({ kind, node, source }: Fragment) => {
    let html = source !== undefined ? "" : stringifyBlock(node, stringify);
    // Diagrams and charts have no HTML; their source is the text of the whole commentable block.
    const text = source ?? blockText(html);
    if (source === undefined && normalizeText(text) === "") {
      // Even an empty chart spec has a visible code fallback.
      const classes = fenceCode(node)?.properties.className;
      if (!Array.isArray(classes) || !classes.includes("language-chart")) return;
    }
    const hash = await blockHash(normalizeText(source ?? identityText(node)));
    const count = (occurrences.get(hash) ?? 0) + 1;
    occurrences.set(hash, count);
    if (kind === "heading" && node.type === "element") {
      // Anchor identities are stable across doc paths and separate from block/thread routes.
      const authorId = node.properties.id;
      if (
        typeof authorId !== "string" ||
        !authorId.startsWith("user-content-") ||
        elementIds.get(authorId) !== 1 ||
        authorId.length > LIMITS.headingIdChars ||
        Array.from(authorId).some((char) => {
          const code = char.charCodeAt(0);
          return code < 32 || (code >= 127 && code <= 159);
        })
      )
        node.properties.id = `heading-${hash}${count === 1 ? "" : `-${count}`}`;
      html = stringifyBlock(node, stringify);
    }
    const id = sectionBlockId(section, `${hash}${count === 1 ? "" : `-${count}`}`) as BlockId;
    if (itemIds && node.type === "element") {
      // A list wrapper holds the item; pieces cut at a diagram keep the item's data.
      const item = renderData(node).recenseGlossaryItem === undefined ? node.children.find(isElement) : node;
      const number = item ? renderData(item).recenseGlossaryItem : undefined;
      if (number !== undefined && !itemIds.has(number)) itemIds.set(number, id);
    }
    blocks.push({
      id,
      section,
      kind,
      html,
      text,
      ...(source === undefined ? {} : { source }),
    });
  };
  tree.children = flattenRoots(tree);
  for (const fragment of splitBlocks(tree)) await append(fragment);
  return blocks;
}
