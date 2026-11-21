import { toString as hastText } from "hast-util-to-string";
import { type DefaultTreeAdapterTypes, defaultTreeAdapter, html as parse5Html } from "parse5";
import { hastToHtml } from "shiki/core";
import { docNodes, parseDocHtml } from "../place/html.ts";
import type { HtmlElement, HtmlRoot } from "./blocks.ts";
import { HIGHLIGHT_LINE_CHARS, type HighlightBudget, highlightLanguage, spendHighlightBudget } from "./highlight.ts";
import { sharedHighlighter } from "./highlighter.ts";

function classTokens(element: DefaultTreeAdapterTypes.Element): string[] {
  return (element.attrs.find((attr) => attr.name === "class")?.value ?? "").split(/[\t\n\f\r ]+/);
}

function tokenTree(code: HtmlElement): HtmlRoot {
  const children: HtmlRoot["children"] = [];
  for (const line of code.children) {
    if (line.type === "text") {
      children.push({ type: "text", value: line.value });
      continue;
    }
    if (line.type !== "element" || line.tagName !== "span" || line.properties.class !== "line") continue;
    for (const token of line.children) {
      if (token.type === "text") children.push({ type: "text", value: token.value });
      else if (token.type === "element") {
        children.push({
          type: "element",
          tagName: "span",
          properties: typeof token.properties.style === "string" ? { style: token.properties.style } : {},
          children: token.children
            .filter((child) => child.type === "text")
            .map((child) => ({ type: "text", value: child.value })),
        });
      }
    }
  }
  return { type: "root", children };
}

export async function highlightHtmlCode(html: string): Promise<string> {
  if (!html.includes("language-")) return html;
  try {
    const tree = parseDocHtml(html, Infinity, true);
    if (!tree) return html;
    const highlighter = await sharedHighlighter();
    const loaded = new Set(highlighter.getLoadedLanguages());
    const budget: HighlightBudget = { highlightedBytes: 0 };
    const encoder = new TextEncoder();
    const replacements: { start: number; end: number; markup: string }[] = [];
    for (const root of tree.childNodes) {
      for (const node of docNodes(root)) {
        if (
          !defaultTreeAdapter.isElementNode(node) ||
          node.tagName !== "code" ||
          node.namespaceURI !== parse5Html.NS.HTML
        )
          continue;
        const pre = node.parentNode;
        if (
          !pre ||
          !defaultTreeAdapter.isElementNode(pre) ||
          pre.tagName !== "pre" ||
          pre.namespaceURI !== parse5Html.NS.HTML ||
          classTokens(pre).includes("mermaid")
        )
          continue;
        const lang = highlightLanguage(classTokens(node), loaded);
        if (lang === undefined || node.childNodes.length === 0) continue;
        const texts = node.childNodes.filter(defaultTreeAdapter.isTextNode);
        if (texts.length !== node.childNodes.length) continue;
        const { startTag, endTag } = node.sourceCodeLocation ?? {};
        if (!startTag || !endTag) continue;
        const text = texts.map((child) => child.value).join("");
        if (!text || !spendHighlightBudget(budget, encoder.encode(text).byteLength)) continue;
        const highlighted = highlighter.codeToHast(text, {
          lang,
          theme: "emend",
          tokenizeMaxLineLength: HIGHLIGHT_LINE_CHARS,
        });
        const highlightedPre = highlighted.children.find(
          (child) => child.type === "element" && child.tagName === "pre",
        );
        if (highlightedPre?.type !== "element") continue;
        const code = highlightedPre.children.find((child) => child.type === "element" && child.tagName === "code");
        if (code?.type !== "element") continue;
        const tokens = tokenTree(code);
        if (hastText(tokens) !== text) continue;
        replacements.push({ start: startTag.endOffset, end: endTag.startOffset, markup: hastToHtml(tokens) });
      }
    }
    const parts: string[] = [];
    let offset = 0;
    for (const replacement of replacements.sort((a, b) => a.start - b.start)) {
      parts.push(html.slice(offset, replacement.start), replacement.markup);
      offset = replacement.end;
    }
    parts.push(html.slice(offset));
    return parts.join("");
  } catch {
    // A highlighting failure leaves the doc plain instead of failing to load.
    return html;
  }
}
