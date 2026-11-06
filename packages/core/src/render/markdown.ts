import { BlockId } from "@emend/contract";
import rehypeShiki from "@shikijs/rehype/core";
import { toString as hastText } from "hast-util-to-string";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import type { DocLinks } from "../links.ts";
import { type Block, blocksFromTree, type HtmlRoot, renderData, visitElements } from "./blocks.ts";
import { blockHash } from "./hash.ts";
import { HIGHLIGHT_LINE_CHARS, type HighlightBudget, limitHighlighting } from "./highlight.ts";
import { sharedHighlighter } from "./highlighter.ts";
import { linkIssueRefs } from "./issue-refs.ts";
import { commentLineBreaks } from "./line-breaks.ts";
import { limitReferences } from "./reference-limit.ts";
import {
  FOOTNOTE_NODE,
  hardenLinks,
  markFootnotes,
  namespaceClasses,
  restoreFootnotes,
  sanitizeSchema,
} from "./sanitize.ts";
import { limitTables, prepareTables } from "./tables.ts";

function isolateDiagrams() {
  return (tree: HtmlRoot) => {
    visitElements(tree, (element) => {
      if (element.tagName !== "pre") return;
      const code = element.children[0];
      if (
        code?.type !== "element" ||
        code.tagName !== "code" ||
        !Array.isArray(code.properties.className) ||
        !code.properties.className.includes("language-mermaid")
      )
        return;
      // remark-rehype adds one terminal newline to nonempty fences.
      const text = hastText(code);
      renderData(element).emendDiagram = text.endsWith("\n") ? text.slice(0, -1) : text;
      element.children = [];
    });
  };
}

const keepLines = () => undefined;

/** Everything up to and including link hardening: the part writeups, docs and comments share. */
function sanitizedPipeline(lineBreaks = false) {
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(lineBreaks ? commentLineBreaks : keepLines)
    .use(lineBreaks ? limitReferences : keepLines)
    .use(limitTables)
    .use(remarkRehype, { allowDangerousHtml: true, clobberPrefix: "" })
    .use(markFootnotes)
    .use(rehypeRaw, { passThrough: [FOOTNOTE_NODE] })
    .use(restoreFootnotes)
    .use(namespaceClasses)
    .use(rehypeSanitize, sanitizeSchema)
    .use(linkIssueRefs)
    .use(hardenLinks);
}

async function createProcessor() {
  const highlighter = await sharedHighlighter();
  return sanitizedPipeline()
    .use(isolateDiagrams)
    .use(limitHighlighting, highlighter.getLoadedLanguages())
    .use(rehypeShiki, highlighter, {
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: false,
      stripEndNewline: false,
      tokenizeMaxLineLength: HIGHLIGHT_LINE_CHARS,
      // Unknown languages stay plain; lazy loading and metadata transformers are disabled.
      lazy: false,
    })
    .use(rehypeStringify);
}

let processorPromise: ReturnType<typeof createProcessor> | undefined;

/** Internal entry point for composing sections under one highlighting budget. */
export async function renderMarkdownWithBudget(
  markdown: string,
  section: string,
  highlightBudget: HighlightBudget,
  repoUrl?: string,
  media?: ReadonlyMap<string, string>,
  docs?: DocLinks,
  docBase = "",
  effects?: { docBaseUsed?: boolean; docPathUsed?: boolean },
): Promise<Block[]> {
  // Check even an empty document: every emitted id must satisfy the contract.
  BlockId.parse(`${section}-00000000`);
  processorPromise ??= createProcessor().catch((error: unknown) => {
    processorPromise = undefined;
    throw error;
  });
  const processor = await processorPromise;
  const { source, tables } = prepareTables(markdown);
  const data = {
    highlightBudget,
    largeTables: tables,
    repoUrl,
    media,
    docs,
    docBase,
    docBaseUsed: false,
    docPathUsed: false,
  };
  const tree = await processor.run(processor.parse(source), {
    value: source,
    data,
  });
  if (effects && data.docBaseUsed) effects.docBaseUsed = true;
  if (effects && data.docPathUsed) effects.docPathUsed = true;
  return blocksFromTree(tree, section, (node) =>
    processor.stringify(node.type === "root" ? node : { type: "root", children: [node] }),
  );
}

// Comments need no highlighter or diagram frames: fences stay plain code, and loading Shiki is skipped.
const commentProcessor = sanitizedPipeline(true).use(rehypeStringify);

/** One comment's Markdown as sanitized HTML, through the same pipeline as docs, without Shiki or Mermaid. */
export async function renderCommentHtml(markdown: string, repoUrl?: string): Promise<string> {
  const { source, tables } = prepareTables(markdown);
  const tree = await commentProcessor.run(commentProcessor.parse(source), {
    value: source,
    data: { largeTables: tables, repoUrl },
  });
  return commentProcessor.stringify(tree);
}

export function renderMarkdown(markdown: string, section: string, repoUrl?: string): Promise<Block[]> {
  return renderMarkdownWithBudget(markdown, section, { highlightedBytes: 0 }, repoUrl);
}

export async function renderDoc(
  markdown: string,
  path: string,
  repoUrl?: string,
  docs?: DocLinks,
  effects?: { docBaseUsed?: boolean; docPathUsed?: boolean },
): Promise<Block[]> {
  return renderMarkdownWithBudget(
    markdown,
    `doc-${await blockHash(path)}`,
    { highlightedBytes: 0 },
    repoUrl,
    undefined,
    docs,
    path,
    effects,
  );
}

const metadataProcessor = sanitizedPipeline().use(isolateDiagrams).use(rehypeStringify);
/** The same sanitized blocks, without syntax highlighting, for publish metadata and CLI titles. */
export async function renderMetadataBlocks(markdown: string): Promise<Block[]> {
  const { source, tables } = prepareTables(markdown);
  const tree = await metadataProcessor.run(metadataProcessor.parse(source), {
    value: source,
    data: { largeTables: tables },
  });
  return blocksFromTree(tree, "metadata", (node) =>
    metadataProcessor.stringify(node.type === "root" ? node : { type: "root", children: [node] }),
  );
}
