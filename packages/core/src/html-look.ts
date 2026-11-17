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
const styleAttributes = new Set(["style", "bgcolor", "color", "text", "link", "vlink", "alink"]);

export function htmlLook(source: string): {
  look: HtmlLook;
  reason: HtmlLookReason;
  outside: string[];
  otherOutside: boolean;
} {
  return htmlLookFromTree(parseDocHtml(source));
}

/** Shares the bounded parse with headings. Lazy iterators keep even wide documents inexpensive to walk. */
export function htmlLookFromTree(tree: DefaultTreeAdapterTypes.Document | null): {
  look: HtmlLook;
  reason: HtmlLookReason;
  outside: string[];
  otherOutside: boolean;
} {
  if (!tree) return { look: "custom", reason: "unreadable", outside: [], otherOutside: false };
  let mark: HtmlLook | undefined;
  let ownStyles = false;
  const outside = new Set<string>();
  let otherOutside = false;
  const pending = [{ nodes: tree.childNodes[Symbol.iterator](), foreign: false, shadow: false }];
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
    if (
      !frame.shadow &&
      isHtml &&
      name === "meta" &&
      mark === undefined &&
      lower(attr("name").trim()) === "emend-look"
    ) {
      const value = lower(attr("content").trim());
      if (value === "emend" || value === "custom") mark = value;
    }
    if (
      name === "style" ||
      (isHtml && !frame.foreign && node.attrs.some((attr) => styleAttributes.has(attr.name))) ||
      (isHtml &&
        name === "link" &&
        lower(attr("rel"))
          .split(/[\t\n\f\r ]+/)
          .includes("stylesheet"))
    )
      ownStyles = true;
    if (!frame.shadow && !frame.foreign && isHtml && !HTML_STRUCTURE.has(name)) {
      if (!/^[a-z][a-z0-9._-]{0,31}$/.test(name)) otherOutside = true;
      else if (!outside.has(name)) {
        if (outside.size < 20) outside.add(name);
        else {
          otherOutside = true;
          const last = [...outside].sort().at(-1);
          if (last && name < last) {
            outside.delete(last);
            outside.add(name);
          }
        }
      }
    }
    let children = node.childNodes;
    let shadow = frame.shadow;
    if (isHtml && name === "template") {
      const mode = lower(attr("shadowrootmode"));
      if (mode !== "open" && mode !== "closed") continue;
      children = defaultTreeAdapter.getTemplateContent(node as DefaultTreeAdapterTypes.Template).childNodes;
      shadow = true;
    }
    pending.push({
      nodes: children[Symbol.iterator](),
      foreign: frame.foreign || name === "svg" || name === "math",
      shadow,
    });
  }
  return {
    look: mark ?? (ownStyles ? "custom" : "emend"),
    reason: mark ? (mark === "emend" ? "marked-emend" : "marked-custom") : ownStyles ? "own-styles" : "structure",
    outside: [...outside].sort(),
    otherOutside,
  };
}
