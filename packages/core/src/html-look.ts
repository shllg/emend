import { type DefaultTreeAdapterTypes, defaultTreeAdapter, html } from "parse5";
import { parseDocHtml } from "./place/html.ts";

export type HtmlLook = "emend" | "custom";
export type HtmlLookReason = "default" | "marked-emend" | "marked-custom" | "unreadable";
export type HtmlColorScheme = "light" | "auto";
type HtmlLookResult = {
  look: HtmlLook;
  reason: HtmlLookReason;
  ownStyles: boolean;
  colorScheme: HtmlColorScheme;
  outside: string[];
  otherOutside: boolean;
};

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
const svgColorAttributes = new Set(["fill", "stroke", "color", "stop-color", "flood-color", "lighting-color"]);
const colorKeywords = new Set([
  "",
  "inherit",
  "initial",
  "unset",
  "revert",
  "revert-layer",
  "currentcolor",
  "transparent",
  "none",
]);
// Each comment character matches exactly one branch; an unclosed comment consumes the remainder.
const withoutComments = (css: string) => css.replace(/\/\*(?:[^*]|\*(?!\/))*(?:\*\/|$)/g, "");
const setsColor = (value: string) => !colorKeywords.has(lower(value.replace(/!\s*important/gi, "").trim()));
function colorDeclarations(css: string): boolean {
  for (const match of css.matchAll(/(?:^|[{;])\s*([-a-zA-Z]+)\s*:\s*([^;{}]*)/g)) {
    const property = lower(match[1] ?? "");
    if (
      !property.startsWith("--") &&
      (property === "color" ||
        property === "background" ||
        property === "fill" ||
        property === "stroke" ||
        property.endsWith("-color")) &&
      setsColor(match[2] ?? "")
    )
      return true;
  }
  return false;
}

export function htmlLook(source: string): HtmlLookResult {
  return htmlLookFromTree(parseDocHtml(source));
}

/** Shares the bounded parse with headings. Lazy iterators keep even wide documents inexpensive to walk. */
export function htmlLookFromTree(tree: DefaultTreeAdapterTypes.Document | null): HtmlLookResult {
  if (!tree)
    return {
      look: "custom",
      reason: "unreadable",
      ownStyles: false,
      colorScheme: "auto",
      outside: [],
      otherOutside: false,
    };
  let mark: HtmlLook | undefined;
  let ownStyles = false;
  let colors = false;
  let darkRule = false;
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
    const stylesheet =
      isHtml &&
      name === "link" &&
      lower(attr("rel"))
        .split(/[\t\n\f\r ]+/)
        .includes("stylesheet");
    if (
      name === "style" ||
      (isHtml && !frame.foreign && node.attrs.some((attr) => styleAttributes.has(attr.name))) ||
      stylesheet
    )
      ownStyles = true;
    if (name === "style" && (isHtml || node.namespaceURI === html.NS.SVG)) {
      const css = withoutComments(
        node.childNodes
          .filter(defaultTreeAdapter.isTextNode)
          .map((text) => text.value)
          .join(""),
      );
      colors ||= /@import\b/i.test(css) || colorDeclarations(css);
      darkRule ||= /prefers-color-scheme|light-dark\(/i.test(css);
    }
    if (name === "style" || stylesheet) darkRule ||= /prefers-color-scheme/i.test(attr("media"));
    colors ||= stylesheet;
    const inline = withoutComments(attr("style"));
    colors ||= colorDeclarations(`;${inline}`);
    darkRule ||= /light-dark\(/i.test(inline);
    if (isHtml && !frame.foreign)
      colors ||= node.attrs.some(
        ({ name, value }) => name !== "style" && styleAttributes.has(name) && value.trim() !== "",
      );
    if (node.namespaceURI === html.NS.SVG)
      colors ||= node.attrs.some(({ name, value }) => svgColorAttributes.has(name) && setsColor(value));
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
  const look = mark ?? "emend";
  return {
    look,
    reason: mark ? (mark === "emend" ? "marked-emend" : "marked-custom") : "default",
    ownStyles,
    colorScheme: look === "emend" && colors && !darkRule ? "light" : "auto",
    outside: [...outside].sort(),
    otherOutside,
  };
}
