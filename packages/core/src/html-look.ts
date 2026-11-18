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
const cssWhitespace = (char: string | undefined) =>
  char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f";
const cssNewline = (char: string | undefined) => char === "\n" || char === "\r" || char === "\f";
const cssEscape = (css: string, i: number) => css[i] === "\\" && i + 1 < css.length && !cssNewline(css[i + 1]);
function cssHexDigit(code: number): number {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 65 && code <= 70) return code - 55;
  if (code >= 97 && code <= 102) return code - 87;
  return -1;
}
function cssIdentifierChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95 ||
    code === 45 ||
    code >= 128
  );
}

/** Ignore CSS data without recursion or a regexp stack proportional to the document size. */
function cssCodeOnly(css: string): string {
  const parts: string[] = [];
  let start = 0;
  let i = 0;
  while (i < css.length) {
    const char = css[i];
    if (char === "/" && css[i + 1] === "*") {
      parts.push(css.slice(start, i), " ");
      const end = css.indexOf("*/", i + 2);
      i = end === -1 ? css.length : end + 2;
      start = i;
    } else if (char === '"' || char === "'") {
      parts.push(css.slice(start, i), char, char);
      i++;
      while (i < css.length) {
        if (css[i] === "\\") {
          i = Math.min(i + (css[i + 1] === "\r" && css[i + 2] === "\n" ? 3 : 2), css.length);
        } else if (css[i] === char) {
          i++;
          break;
        } else if (cssNewline(css[i])) break;
        else i++;
      }
      start = i;
    } else if (cssIdentifierChar(css.charCodeAt(i)) || cssEscape(css, i)) {
      // Decode only to compare with "url", keeping long identifiers out of intermediate strings.
      let length = 0;
      let url = true;
      while (i < css.length) {
        let code = css.charCodeAt(i);
        if (cssEscape(css, i)) {
          i++;
          const hexStart = i;
          let value = 0;
          while (i - hexStart < 6) {
            const digit = cssHexDigit(css.charCodeAt(i));
            if (digit < 0) break;
            value = value * 16 + digit;
            i++;
          }
          if (i > hexStart) {
            code = value;
            if (cssWhitespace(css[i])) {
              if (css[i] === "\r" && css[i + 1] === "\n") i++;
              i++;
            }
          } else {
            code = css.codePointAt(i) ?? 0;
            i += code > 0xffff ? 2 : 1;
          }
        } else if (cssIdentifierChar(code)) i++;
        else break;
        const folded = code >= 65 && code <= 90 ? code + 32 : code;
        if (length >= 3 || folded !== "url".charCodeAt(length)) url = false;
        length++;
      }
      if (!url || length !== 3 || css[i] !== "(") continue;
      let value = i + 1;
      while (cssWhitespace(css[value])) value++;
      if (css[value] === '"' || css[value] === "'") {
        // Keep the function; the next iteration strips its quoted string.
        i = value;
      } else {
        parts.push(css.slice(start, i + 1), ")");
        i = value;
        while (i < css.length) {
          if (cssEscape(css, i)) i += 2;
          else if (css[i] === ")") {
            i++;
            break;
          } else i++;
        }
        start = i;
      }
    } else i++;
  }
  parts.push(css.slice(start));
  return parts.join("");
}
const setsColor = (value: string) => !colorKeywords.has(lower(value.replace(/!\s*important/gi, "").trim()));
function colorDeclarations(css: string): boolean {
  // Only cleaned code reaches this scan; the repetitions are simple character classes.
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
      const css = cssCodeOnly(
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
    const inline = cssCodeOnly(attr("style"));
    colors ||= colorDeclarations(`;${inline}`);
    darkRule ||= /light-dark\(/i.test(inline);
    if (isHtml && !frame.foreign)
      colors ||= node.attrs.some(
        ({ name, value }) => name !== "style" && styleAttributes.has(name) && value.trim() !== "",
      );
    if (node.namespaceURI === html.NS.SVG)
      for (const { name, value } of node.attrs) {
        if (!svgColorAttributes.has(name)) continue;
        const code = cssCodeOnly(value);
        colors ||= setsColor(code);
        darkRule ||= /light-dark\(/i.test(code);
      }
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
