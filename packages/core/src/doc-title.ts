import { LIMITS } from "@emend/contract";
import { defaultTreeAdapter, html } from "parse5";
import { docNodes, htmlPart, nodeText, parseDocHtml } from "./place/html.ts";
import type { Block } from "./render/blocks.ts";
import { renderMetadataBlocks } from "./render/markdown.ts";

export const TITLE_PREFIX_BYTES = 64 * 1024;

// Terminal and bidi controls, and characters that render as nothing or reorder text.
// It matches the CLI's terminal escape set (apps/emend/src/cli/escape.ts), except U+2028 and U+2029,
// which the whitespace step turns into spaces first.
const discardedRanges: readonly (readonly [number, number])[] = [
  [0, 0x1f],
  [0x7f, 0x9f],
  [0x34f, 0x34f],
  [0x61c, 0x61c],
  [0x115f, 0x1160],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff9, 0xfffb],
  [0xe0000, 0xe007f],
  [0xe0100, 0xe01ef],
];

export function cleanDocTitle(value: string): string {
  return Array.from(value.replace(/[\s\x85]/gu, " "))
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return !discardedRanges.some(([from, to]) => code >= from && code <= to);
    })
    .join("")
    .replace(/ +/g, " ")
    .trim()
    .toWellFormed()
    .slice(0, LIMITS.titleChars)
    .replace(/[\uD800-\uDBFF]$/, "")
    .trim();
}

function htmlTitle(bytes: Uint8Array): string | undefined {
  const tree = parseDocHtml(new TextDecoder().decode(bytes.subarray(0, TITLE_PREFIX_BYTES)));
  if (!tree) return undefined;
  const head = htmlPart(tree, "head");
  if (head && defaultTreeAdapter.isElementNode(head)) {
    const title = head.childNodes.find(
      (node) =>
        defaultTreeAdapter.isElementNode(node) && node.namespaceURI === html.NS.HTML && node.tagName === "title",
    );
    const cleaned = title ? cleanDocTitle(nodeText(title, 4 * LIMITS.titleChars)) : "";
    if (cleaned) return cleaned;
  }
  const body = htmlPart(tree, "body");
  if (body)
    for (const node of docNodes(body)) {
      if (defaultTreeAdapter.isElementNode(node) && node.namespaceURI === html.NS.HTML && node.tagName === "h1")
        return cleanDocTitle(nodeText(node, 4 * LIMITS.titleChars)) || undefined;
    }
  return undefined;
}

export function markdownTitle(blocks: readonly Block[]): string | undefined {
  const heading = blocks.find((block) => block.kind === "heading" && /^<h1(?:\s|>)/.test(block.html));
  return heading ? cleanDocTitle(heading.text) || undefined : undefined;
}

/** HTML title parsing sees only a bounded byte prefix; Markdown uses the sanitized block renderer. */
export async function inferDocTitle(kind: "html" | "markdown", bytes: Uint8Array): Promise<string | undefined> {
  return kind === "html"
    ? htmlTitle(bytes)
    : markdownTitle(await renderMetadataBlocks(new TextDecoder().decode(bytes)));
}
