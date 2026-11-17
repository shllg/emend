import { type DefaultTreeAdapterTypes, defaultTreeAdapter, html } from "parse5";
import { parseDocHtml } from "./place/html.ts";

export type HtmlLook = "emend" | "custom";
export type HtmlLookReason = "marked-emend" | "marked-custom" | "own-styles" | "structure" | "unreadable";

/** The documented page structure; this is styling advice, never an HTML allowlist. */
export const HTML_STRUCTURE: ReadonlySet<string> = new Set(
  (
    "html head body title meta link style main article section header footer nav aside div span " +
    "h1 h2 h3 h4 h5 h6 p br wbr hr ul ol li dl dt dd a strong em b i u s small sub sup mark abbr " +
    "cite q dfn time data kbd samp var code pre blockquote del ins address figure figcaption img " +
    "picture source table caption colgroup col thead tbody tfoot tr th td details summary svg math"
  ).split(" "),
);
const lower = (value: string) => value.replace(/[A-Z]/g, (char) => char.toLowerCase());

export function htmlLook(source: string): { look: HtmlLook; reason: HtmlLookReason; outside: string[] } {
  return htmlLookFromTree(parseDocHtml(source));
}

/** Shares the bounded parse with headings. Lazy iterators keep even wide documents inexpensive to walk. */
export function htmlLookFromTree(tree: DefaultTreeAdapterTypes.Document | null): {
  look: HtmlLook;
  reason: HtmlLookReason;
  outside: string[];
} {
  if (!tree) return { look: "custom", reason: "unreadable", outside: [] };
  let mark: HtmlLook | undefined;
  let ownStyles = false;
  const outside = new Set<string>();
  const pending = [{ nodes: tree.childNodes[Symbol.iterator](), foreign: false }];
  while (pending.length) {
    const frame = pending.at(-1);
    const next = frame?.nodes.next();
    if (!frame || !next || next.done) {
      pending.pop();
      continue;
    }
    const node = next.value;
    if (!defaultTreeAdapter.isElementNode(node)) continue;
    const name = node.tagName.toLowerCase();
    const isHtml = node.namespaceURI === html.NS.HTML;
    const attr = (key: string) => node.attrs.find((attr) => attr.name === key)?.value ?? "";
    if (isHtml && name === "meta" && mark === undefined && lower(attr("name").trim()) === "emend-look") {
      const value = lower(attr("content").trim());
      if (value === "emend" || value === "custom") mark = value;
    }
    if (
      name === "style" ||
      (isHtml &&
        name === "link" &&
        lower(attr("rel"))
          .split(/[\t\n\f\r ]+/)
          .includes("stylesheet"))
    )
      ownStyles = true;
    if (!frame.foreign && isHtml && !HTML_STRUCTURE.has(name)) {
      outside.add(name);
      // Keep the lexically first twenty names without retaining an unbounded set of hostile names.
      if (outside.size > 20) outside.delete([...outside].sort().at(-1) ?? "");
    }
    const children =
      isHtml && name === "template"
        ? defaultTreeAdapter.getTemplateContent(node as DefaultTreeAdapterTypes.Template).childNodes
        : node.childNodes;
    pending.push({
      nodes: children[Symbol.iterator](),
      foreign: frame.foreign || name === "svg" || name === "math",
    });
  }
  return {
    look: mark ?? (ownStyles ? "custom" : "emend"),
    reason: mark ? (mark === "emend" ? "marked-emend" : "marked-custom") : ownStyles ? "own-styles" : "structure",
    outside: [...outside].sort(),
  };
}
