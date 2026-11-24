import { RepoUrl } from "@recense/contract";
import type { Transformer } from "unified";
import type { HtmlElement, HtmlNode, HtmlRoot } from "./blocks.ts";

// Never inside code, a fence (which also holds Mermaid sources) or an existing link.
const skipped = new Set(["code", "pre", "a"]);
// One to seven digits after a non-word character; `page#12`, `x/#12`, `a&#12` and `#012` stay text.
const reference = /(?<![\w&/#])#([1-9]\d{0,6})(?!\w)/g;

function link(href: string, number: string, text: string): HtmlElement {
  return {
    type: "element",
    tagName: "a",
    properties: { href, dataRecenseIssue: number },
    children: [{ type: "text", value: text }],
  };
}

function split(value: string, repoUrl: string): HtmlNode[] | null {
  const parts: HtmlNode[] = [];
  let last = 0;
  for (const match of value.matchAll(reference)) {
    if (match.index > last) parts.push({ type: "text", value: value.slice(last, match.index) });
    parts.push(link(String(new URL(`${repoUrl}/issues/${match[1]}`)), match[1] as string, match[0]));
    last = match.index + match[0].length;
  }
  if (last === 0) return null;
  if (last < value.length) parts.push({ type: "text", value: value.slice(last) });
  return parts;
}

/**
 * Runs after sanitize and before hardenLinks, so the new anchors get the same rel and target as every
 * other link. The base comes from the render's file data, never from a closure: the processor is shared.
 * A link wraps the same text, so block text and ids do not change. Each anchor also carries
 * `data-recense-issue="<number>"`; sanitize ran before and drops author `data-*`, so only these server-made
 * anchors have it, and the app reads it to attach a stored title and state.
 */
export function linkIssueRefs(): Transformer<HtmlRoot> {
  return (tree, file) => {
    const base = file.data.repoUrl;
    if (typeof base !== "string" || !RepoUrl.safeParse(base).success) return;
    const stack: HtmlNode[] = [tree];
    for (let node = stack.pop(); node; node = stack.pop()) {
      if (!("children" in node) || (node.type === "element" && skipped.has(node.tagName))) continue;
      const children = node.children as HtmlNode[];
      const next: HtmlNode[] = [];
      let changed = false;
      for (const child of children) {
        const parts = child.type === "text" ? split(child.value, base) : null;
        if (parts) {
          next.push(...parts);
          changed = true;
        } else {
          next.push(child);
          if (child.type === "element") stack.push(child);
        }
      }
      if (changed) node.children = next as typeof node.children;
    }
  };
}
