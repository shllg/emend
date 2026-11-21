import { LIMITS } from "@emend/contract";
import { type DefaultTreeAdapterTypes, defaultTreeAdapter, html } from "parse5";
import { htmlPart } from "./place/html.ts";
import { blockHash } from "./render/hash.ts";
import { normalizeText } from "./render/normalize.ts";

const partTags = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "caption",
  "dd",
  "details",
  "dialog",
  "div",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "legend",
  "li",
  "main",
  "nav",
  "p",
  "pre",
  "section",
  "summary",
  "td",
  "th",
]);
const omitted = new Set(["script", "style", "template", "noscript"]);

// The bridge's collectParts is kept in parity by the bridge tests.
export function htmlPartTexts(tree: DefaultTreeAdapterTypes.Document | null): string[] {
  const body = tree && htmlPart(tree, "body");
  if (!body || !defaultTreeAdapter.isElementNode(body)) return [];
  const parts: string[][] = [];
  const pending: { nodes: Iterator<DefaultTreeAdapterTypes.Node>; part?: string[] }[] = [
    { nodes: body.childNodes[Symbol.iterator]() },
  ];
  while (pending.length) {
    const entry = pending.at(-1);
    if (!entry) break;
    const next = entry.nodes.next();
    if (next.done) {
      pending.pop();
      continue;
    }
    const node = next.value;
    if (defaultTreeAdapter.isTextNode(node)) entry.part?.push(node.value);
    else if (defaultTreeAdapter.isElementNode(node) && !omitted.has(node.tagName)) {
      let part = entry.part;
      if (node.namespaceURI === html.NS.HTML && partTags.has(node.tagName)) {
        part = [];
        parts.push(part);
      }
      pending.push({ nodes: node.childNodes[Symbol.iterator](), part });
    }
  }
  const texts: string[] = [];
  for (const part of parts) {
    const text = normalizeText(part.join(""));
    if (!text) continue;
    texts.push(text);
    if (texts.length === LIMITS.htmlPartsPerDoc) break;
  }
  return texts;
}

export async function htmlPartHashes(tree: DefaultTreeAdapterTypes.Document | null): Promise<string[]> {
  const counts = new Map<string, number>();
  const hashes: string[] = [];
  for (const text of htmlPartTexts(tree)) {
    const hash = await blockHash(text);
    const count = (counts.get(hash) ?? 0) + 1;
    counts.set(hash, count);
    hashes.push(count === 1 ? hash : `${hash}-${count}`);
  }
  return hashes;
}
