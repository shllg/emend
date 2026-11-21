import type { HtmlElement, HtmlNode, HtmlRoot } from "./blocks.ts";

const isWhitespace = (node: HtmlNode) => node.type === "text" && node.value.trim() === "";
const isBreak = (node: HtmlNode | undefined) => node?.type === "element" && node.tagName === "br";
const hasContent = (node: HtmlNode) =>
  (node.type === "element" && !isBreak(node)) || (node.type === "text" && !isWhitespace(node));

function hasDiagram(quote: HtmlElement): boolean {
  const pending: HtmlNode[] = [quote];
  for (let node = pending.pop(); node; node = pending.pop()) {
    if (
      node.type === "element" &&
      node.tagName === "code" &&
      Array.isArray(node.properties.className) &&
      node.properties.className.includes("language-mermaid")
    )
      return true;
    if ("children" in node) for (const child of node.children) pending.push(child);
  }
  return false;
}

/** Wrap top-level alert markers after sanitize without changing quote text or block identities. */
export function markCallouts() {
  return (tree: HtmlRoot) => {
    for (const quote of tree.children) {
      if (quote.type !== "element" || quote.tagName !== "blockquote") continue;
      const index = quote.children.findIndex((child) => !isWhitespace(child));
      const paragraph = quote.children[index];
      if (paragraph?.type !== "element" || paragraph.tagName !== "p") continue;
      const first = paragraph.children[0];
      if (first?.type !== "text") continue;
      const match = /^(\[!(note|tip|important|warning|caution)\])[ \t]*(\n|$)/i.exec(first.value);
      const marker = match?.[1];
      const type = match?.[2]?.toLowerCase();
      if (!match || !marker || !type) continue;
      const next = paragraph.children[1];
      const breakAfter = match[3] !== "\n" && isBreak(next);
      // Inline markup on the marker line is not an alert.
      if (match[3] !== "\n" && next && !breakAfter) continue;
      if (
        !first.value.slice(match[0].length).trim() &&
        !paragraph.children.slice(breakAfter ? 2 : 1).some(hasContent) &&
        !quote.children.slice(index + 1).some(hasContent)
      )
        continue;
      // Diagram splitting copies quote classes to each text piece, so leave the whole quote plain.
      if (hasDiagram(quote)) continue;

      if (breakAfter && next?.type === "element") {
        const classes = Array.isArray(next.properties.className) ? next.properties.className : [];
        next.properties.className = [...classes, "emend-callout-marker-break"];
      }
      const span: HtmlElement = {
        type: "element",
        tagName: "span",
        properties: { className: ["emend-callout-marker"] },
        children: [{ type: "text", value: marker }],
      };
      const value = first.value.slice(marker.length);
      paragraph.children.splice(0, 1, span, ...(value ? [{ ...first, value }] : []));
      if (paragraph.children.slice(1).every((child) => isWhitespace(child) || isBreak(child))) {
        const classes = Array.isArray(paragraph.properties.className) ? paragraph.properties.className : [];
        paragraph.properties.className = [...classes, "emend-callout-marker-line"];
      }
      const classes = Array.isArray(quote.properties.className) ? quote.properties.className : [];
      quote.properties.className = [...classes, "emend-callout", `emend-callout-${type}`];
    }
  };
}
