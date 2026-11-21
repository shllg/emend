import type { HtmlElement, HtmlNode, HtmlRoot } from "./blocks.ts";

const labels: Record<string, string> = {
  note: "Note",
  tip: "Tip",
  important: "Important",
  warning: "Warning",
  caution: "Caution",
};

const isWhitespace = (node: HtmlNode | undefined) => node?.type === "text" && node.value.trim() === "";
const hasContent = (node: HtmlNode) => node.type === "element" || (node.type === "text" && !isWhitespace(node));

/** Mark top-level GitHub alerts only after sanitizing and restoring namespaced author classes. */
export function markCallouts() {
  return (tree: HtmlRoot) => {
    for (const quote of tree.children) {
      if (quote.type !== "element" || quote.tagName !== "blockquote") continue;
      const index = quote.children.findIndex((child) => !isWhitespace(child));
      const paragraph = quote.children[index];
      if (paragraph?.type !== "element" || paragraph.tagName !== "p") continue;
      const first = paragraph.children[0];
      if (first?.type !== "text") continue;
      const marker = /^\[!(note|tip|important|warning|caution)\][ \t]*(\n|$)/i.exec(first.value);
      if (!marker) continue;
      const type = marker[1]?.toLowerCase() ?? "";
      const label = labels[type];
      if (!label) continue;
      const next = paragraph.children[1];
      const breakAfter = marker[2] !== "\n" && next?.type === "element" && next.tagName === "br";
      // Inline markup on the marker line is not an alert.
      if (marker[2] !== "\n" && next && !breakAfter) continue;
      const rest = paragraph.children.slice(breakAfter ? 2 : 1);
      const value = first.value.slice(marker[0].length);
      if (value) rest.unshift({ ...first, value });
      if (!rest.some(hasContent) && !quote.children.slice(index + 1).some(hasContent)) continue;

      let start = index;
      if (rest.every(isWhitespace)) {
        // Drop the empty marker paragraph and its separators without doubling whitespace.
        start++;
        while (isWhitespace(quote.children[start])) start++;
      } else paragraph.children = rest;
      const title: HtmlElement = {
        type: "element",
        tagName: "p",
        properties: { className: ["emend-callout-title"] },
        children: [{ type: "text", value: label }],
      };
      quote.children = [title, { type: "text", value: "\n" }, ...quote.children.slice(start)];
      const classes = Array.isArray(quote.properties.className) ? quote.properties.className : [];
      quote.properties.className = [...classes, "emend-callout", `emend-callout-${type}`];
    }
  };
}
