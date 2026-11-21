import { toString as hastText } from "hast-util-to-string";
import { isSpecialLang } from "shiki/core";
import type { Transformer } from "unified";
import { type HtmlRoot, visitElements } from "./blocks.ts";

export const HIGHLIGHT_LINE_CHARS = 400;
export const HIGHLIGHT_FENCE_BYTES = 16384;
export const HIGHLIGHT_RENDER_BYTES = 65536;

export type HighlightBudget = { highlightedBytes: number };

export function highlightLanguage(classes: readonly unknown[], loaded: ReadonlySet<string>): string | undefined {
  const languageClass = classes.find((value) => typeof value === "string" && value.startsWith("language-"));
  if (typeof languageClass !== "string") return undefined;
  const language = languageClass.slice(9);
  return loaded.has(language) || isSpecialLang(language) ? language : undefined;
}

export function spendHighlightBudget(budget: HighlightBudget, bytes: number): boolean {
  if (
    bytes > HIGHLIGHT_FENCE_BYTES ||
    budget.highlightedBytes + bytes > HIGHLIGHT_RENDER_BYTES ||
    budget.highlightedBytes >= HIGHLIGHT_RENDER_BYTES
  )
    return false;
  budget.highlightedBytes += bytes;
  return true;
}

export function limitHighlighting(languages: string[]): Transformer<HtmlRoot> {
  const loaded = new Set(languages);
  const encoder = new TextEncoder();
  return (tree, file) => {
    // The caller shares this object across a writeup's sections, never across independent renders.
    const budget = (file.data.highlightBudget as HighlightBudget | undefined) ?? { highlightedBytes: 0 };
    visitElements(tree, (element) => {
      if (element.tagName !== "pre") return;
      const code = element.children[0];
      if (code?.type !== "element" || code.tagName !== "code") return;
      const classes = code.properties.className;
      if (!Array.isArray(classes)) return;
      if (highlightLanguage(classes, loaded) === undefined) return;
      const bytes = encoder.encode(hastText(code)).byteLength;
      if (!spendHighlightBudget(budget, bytes)) {
        // Without a language Shiki leaves this code untouched. Text and therefore IDs are preserved.
        code.properties.className = classes.filter(
          (value) => typeof value !== "string" || !value.startsWith("language-"),
        );
        if (code.properties.className.length === 0) delete code.properties.className;
      }
    });
  };
}
