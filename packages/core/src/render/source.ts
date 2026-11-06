import type { SourceContent, SourceToken } from "@emend/contract";
import { splitLines } from "../place/linemap.ts";
import { HIGHLIGHT_LINE_CHARS } from "./highlight.ts";
import { sharedHighlighter } from "./highlighter.ts";

// Synthetic TS, Node 26: 64 KiB 379 ms, 256 KiB 997 ms, 1 MiB 3879 ms.
export const HIGHLIGHT_SOURCE_BYTES = 256 * 1024;
export const HIGHLIGHT_SOURCE_REVISION_BYTES = 1024 * 1024;
const languages: Record<string, SourceContent["language"]> = {
  ts: "ts",
  mts: "ts",
  cts: "ts",
  tsx: "tsx",
  js: "js",
  mjs: "js",
  cjs: "js",
  jsx: "jsx",
  json: "json",
  css: "css",
  html: "html",
  htm: "html",
  md: "md",
  markdown: "md",
  yaml: "yaml",
  yml: "yaml",
  sh: "sh",
  bash: "sh",
  zsh: "sh",
  go: "go",
  py: "py",
  sql: "sql",
  diff: "diff",
  patch: "diff",
};
export function sourceLanguage(path: string): SourceContent["language"] {
  const extension = /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase() ?? "";
  return Object.hasOwn(languages, extension) ? (languages[extension] ?? "text") : "text";
}
/** Raw tokens only. Line coordinates use precisely the same split as placement. */
export async function renderSource(text: string, path: string, highlight = true): Promise<SourceContent> {
  const raw = splitLines(text);
  const language =
    !highlight || new TextEncoder().encode(text).byteLength > HIGHLIGHT_SOURCE_BYTES ? "text" : sourceLanguage(path);
  const plain = () => raw.map((text) => [{ text }]);
  if (language === "text" || !raw.length) return { language, lines: plain() };
  const highlighter = await sharedHighlighter();
  const tokens = highlighter.codeToTokensWithThemes(raw.join("\n"), {
    lang: language,
    themes: { light: "github-light", dark: "github-dark" },
    tokenizeMaxLineLength: HIGHLIGHT_LINE_CHARS,
  });
  // Shiki may split lone CRs; placement deliberately does not. Preserve the original lines.
  if (tokens.length !== raw.length) return { language, lines: plain() };
  const lines = tokens.map((line, index) => {
    if (line.map((token) => token.content).join("") !== raw[index]) return [{ text: raw[index] ?? "" }];
    const merged: SourceToken[] = [];
    for (const token of line) {
      const light = token.variants.light?.color;
      const dark = token.variants.dark?.color;
      const previous = merged.at(-1);
      if (previous && previous.light === light && previous.dark === dark) previous.text += token.content;
      else merged.push({ text: token.content, ...(light ? { light } : {}), ...(dark ? { dark } : {}) });
    }
    return merged;
  });
  return { language, lines };
}
