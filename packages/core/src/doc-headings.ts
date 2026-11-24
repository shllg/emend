import { type DocHeading, LIMITS } from "@recense/contract";
import { fromHtml } from "hast-util-from-html";
import { type DefaultTreeAdapterTypes, defaultTreeAdapter, html } from "parse5";
import { cleanDocTitle } from "./doc-title.ts";
import { docNodes, htmlPart, nodeText, parseDocHtml } from "./place/html.ts";
import type { Block } from "./render/blocks.ts";
export function htmlHeadings(source: string): DocHeading[] {
  return htmlHeadingsFromTree(parseDocHtml(source));
}
export function htmlHeadingsFromTree(tree: DefaultTreeAdapterTypes.Document | null): DocHeading[] {
  const body = tree ? htmlPart(tree, "body") : undefined;
  const headings: DocHeading[] = [];
  if (body)
    for (const node of docNodes(body)) {
      if (
        !defaultTreeAdapter.isElementNode(node) ||
        node.namespaceURI !== html.NS.HTML ||
        (node.tagName !== "h2" && node.tagName !== "h3")
      )
        continue;
      headings.push({
        level: node.tagName === "h2" ? 2 : 3,
        text: cleanDocTitle(nodeText(node, 4 * LIMITS.headingTextChars)).slice(0, LIMITS.headingTextChars),
      });
      if (headings.length === LIMITS.headingsPerDoc) break;
    }
  return headings;
}
export function markdownHeadings(blocks: readonly Block[]): DocHeading[] {
  const headings: DocHeading[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    if (block.kind !== "heading") continue;
    if (!/^<h[23](?:\s|>)/.test(block.html)) continue;
    const node = fromHtml(block.html, { fragment: true }).children[0];
    if (node?.type !== "element" || typeof node.properties.id !== "string") continue;
    if (seen.has(node.properties.id)) continue;
    seen.add(node.properties.id);
    headings.push({
      level: node.tagName === "h2" ? 2 : 3,
      text: cleanDocTitle(block.text).slice(0, LIMITS.headingTextChars),
      id: node.properties.id,
    });
    if (headings.length === LIMITS.headingsPerDoc) break;
  }
  return headings;
}
