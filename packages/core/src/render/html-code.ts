import { LIMITS } from "@emend/contract";
import { toString as hastText } from "hast-util-to-string";
import { type DefaultTreeAdapterTypes, defaultTreeAdapter, html as parse5Html } from "parse5";
import { hastToHtml } from "shiki/core";
import { docNodes, HTML_ELEMENT_LIMIT, parseDocHtml } from "../place/html.ts";
import type { HtmlElement, HtmlRoot } from "./blocks.ts";
import {
  HIGHLIGHT_FENCE_BYTES,
  HIGHLIGHT_LINE_CHARS,
  type HighlightBudget,
  highlightLanguage,
  spendHighlightBudget,
} from "./highlight.ts";
import { sharedHighlighter } from "./highlighter.ts";

export type HtmlCodeColour = { start: number; end: number; markup: string };

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

export function htmlCodeCandidate(html: string): boolean {
  return html.length <= LIMITS.markdownDocBytes && /<code[\t\n\f\r />]/i.test(html);
}

export async function htmlCodeColours(html: string): Promise<HtmlCodeColour[]> {
  if (!htmlCodeCandidate(html)) return [];
  const encoder = new TextEncoder();
  if (encoder.encode(html).byteLength > LIMITS.markdownDocBytes) return [];
  const tree = parseDocHtml(html, HTML_ELEMENT_LIMIT, true);
  if (!tree) return [];
  const candidates: { start: number; end: number; text: string; classes: string[]; bytes: number }[] = [];
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
      const classes = classTokens(node);
      if (!classes.some((token) => token.startsWith("language-")) || node.childNodes.length === 0) continue;
      const texts = node.childNodes.filter(defaultTreeAdapter.isTextNode);
      if (texts.length !== node.childNodes.length) continue;
      const { startTag, endTag } = node.sourceCodeLocation ?? {};
      if (!startTag || !endTag) continue;
      let offset = startTag.endOffset;
      const contiguous = texts.every((child) => {
        const location = child.sourceCodeLocation;
        if (!location || location.startOffset !== offset) return false;
        offset = location.endOffset;
        return true;
      });
      if (!contiguous || offset !== endTag.startOffset) continue;
      if (/<[A-Za-z!/?]/.test(html.slice(startTag.endOffset, endTag.startOffset))) continue;
      const text = texts.map((child) => child.value).join("");
      const bytes = encoder.encode(text).byteLength;
      if (!text || text.includes("\r") || bytes > HIGHLIGHT_FENCE_BYTES) continue;
      candidates.push({ start: startTag.endOffset, end: endTag.startOffset, text, classes, bytes });
    }
  }
  if (candidates.length === 0) return [];
  const highlighter = await sharedHighlighter();
  const loaded = new Set(highlighter.getLoadedLanguages());
  const budget: HighlightBudget = { highlightedBytes: 0 };
  const colours: HtmlCodeColour[] = [];
  for (const { start, end, text, classes, bytes } of candidates) {
    const lang = highlightLanguage(classes, loaded);
    if (lang === undefined || !spendHighlightBudget(budget, bytes)) continue;
    const highlighted = highlighter.codeToHast(text, {
      lang,
      theme: "emend",
      tokenizeMaxLineLength: HIGHLIGHT_LINE_CHARS,
      // The colour worker's job timeout bounds work; per-line limits truncate colours on cold or busy workers.
      tokenizeTimeLimit: 0,
    });
    const highlightedPre = highlighted.children.find((child) => child.type === "element" && child.tagName === "pre");
    if (highlightedPre?.type !== "element") continue;
    const code = highlightedPre.children.find((child) => child.type === "element" && child.tagName === "code");
    if (code?.type !== "element") continue;
    const tokens = tokenTree(code);
    if (hastText(tokens) !== text) continue;
    colours.push({ start, end, markup: hastToHtml(tokens) });
  }
  return colours;
}

export function applyHtmlCodeColours(html: string, colours: readonly HtmlCodeColour[]): string {
  const parts: string[] = [];
  let offset = 0;
  for (const { start, end, markup } of [...colours].sort((a, b) => a.start - b.start)) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < offset || end < start || end > html.length)
      continue;
    parts.push(html.slice(offset, start), markup);
    offset = end;
  }
  parts.push(html.slice(offset));
  return parts.join("");
}

export async function highlightHtmlCode(html: string): Promise<string> {
  try {
    return applyHtmlCodeColours(html, await htmlCodeColours(html));
  } catch {
    // A highlighting failure leaves the doc plain.
    return html;
  }
}
