import type { HtmlSpanTarget, Placement } from "@emend/contract";
import { type DefaultTreeAdapterTypes, defaultTreeAdapter, parse } from "parse5";
import { normalizeText } from "../render/normalize.ts";
import { spanCandidates } from "./span.ts";

const omitted = new Set(["script", "style", "template", "noscript"]);

// Bound parse5's actual open-element stack, including the document's html/head/body elements.
export const HTML_NESTING_LIMIT = 512;
class HtmlNestingLimitError extends Error {}

/** Shared by placement and doc metadata. A failed or over-nested parse has no usable tree. */
export function parseDocHtml(html: string, elementLimit = Infinity): DefaultTreeAdapterTypes.Document | null {
  try {
    let openElements = 0;
    let elements = 0;
    return parse(html, {
      scriptingEnabled: true,
      treeAdapter: {
        ...defaultTreeAdapter,
        createElement(tagName, namespaceURI, attrs) {
          if (++elements > elementLimit) throw new HtmlNestingLimitError();
          return defaultTreeAdapter.createElement(tagName, namespaceURI, attrs);
        },
        onItemPush() {
          if (++openElements > HTML_NESTING_LIMIT) throw new HtmlNestingLimitError();
        },
        onItemPop() {
          openElements--;
        },
      },
    });
  } catch {
    return null;
  }
}
export function htmlPart(
  tree: DefaultTreeAdapterTypes.Document,
  tag: "head" | "body",
): DefaultTreeAdapterTypes.ChildNode | undefined {
  const root = tree.childNodes.find((node) => defaultTreeAdapter.isElementNode(node) && node.tagName === "html");
  return root && defaultTreeAdapter.isElementNode(root)
    ? root.childNodes.find((node) => defaultTreeAdapter.isElementNode(node) && node.tagName === tag)
    : undefined;
}
export function* docNodes(
  root: DefaultTreeAdapterTypes.Node,
  nodeLimit = Infinity,
): Generator<DefaultTreeAdapterTypes.Node> {
  // Lazy child iterators let bounded text readers stop without enumerating a wide subtree.
  const pending: Iterator<DefaultTreeAdapterTypes.Node>[] = [[root][Symbol.iterator]()];
  while (pending.length) {
    const next = pending.at(-1)?.next();
    if (!next || next.done) {
      pending.pop();
      continue;
    }
    if (nodeLimit-- <= 0) return;
    const node = next.value;
    if (defaultTreeAdapter.isElementNode(node) && omitted.has(node.tagName)) continue;
    yield node;
    if (defaultTreeAdapter.isElementNode(node)) pending.push(node.childNodes[Symbol.iterator]());
  }
}
export function nodeText(root: DefaultTreeAdapterTypes.Node, limit = Infinity): string {
  const parts: string[] = [];
  if (limit <= 0) return "";
  for (const node of docNodes(root, 8 * limit)) {
    if (!defaultTreeAdapter.isTextNode(node)) continue;
    const part = node.value.slice(0, limit);
    parts.push(part);
    limit -= part.length;
    if (limit <= 0) break;
  }
  return parts.join("");
}
/** Static body textContent only; parse errors or excess nesting make the document unreadable. */
export function docText(html: string): string | null {
  try {
    const tree = parseDocHtml(html);
    if (!tree) return null;
    const body = htmlPart(tree, "body");
    return body ? normalizeText(nodeText(body)) : "";
  } catch {
    return null;
  }
}

/** The caller supplies docText's normalized output, which also defines the offset space. */
export function placeHtmlSpan(text: string | null, target: HtmlSpanTarget): Placement {
  if (text === null) return { status: "unplaced", reason: "block-gone" };
  const candidates = spanCandidates(text, target);
  const match = candidates[0];
  if (candidates.length === 1 && match) {
    return { status: "placed", location: { kind: "html-span", path: target.path, ...match } };
  }
  return { status: "unplaced", reason: candidates.length > 1 ? "ambiguous" : "block-gone" };
}
