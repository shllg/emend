import {
  type GlossaryTerm,
  LIMITS,
  type NeedsYouKind,
  type NewInRevisionItem,
  type NewInRevisionSection,
  normalizeGlossaryForm,
  type PublishLinks,
  type ReviewVerdict,
  type TopicMeta,
  type WriteupInput,
} from "@emend/contract";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { DocLinks } from "../links.ts";
import type { Block } from "./blocks.ts";
import { type RenderEffects, renderMarkdownWithBudget } from "./markdown.ts";
import { normalizeText } from "./normalize.ts";
import type { MediaSize } from "./sanitize.ts";
import { termMatcher } from "./terms.ts";

export type RenderedWriteup = {
  sections: { key: string; label: string; topic: string | null; blocks: Block[] }[];
  terms?: GlossaryTerm[];
  area?: string;
  newInRevision?: { topic?: string; section?: NewInRevisionSection; blockId?: string; blockIds: string[] }[];
  needsYou?: { kind: NeedsYouKind; topic?: string; blockIds: string[] }[];
  /** Publish-level links and the repo base, kept beside the sections in the stored blob. */
  links?: PublishLinks;
  repoUrl?: string;
};

const unwrittenDecisions =
  "Decisions and drift: not written. Only the session where the change was asked for can tell what drifted from it.";

const escapeMarkdown = (text: string) => text.replace(/[!-/:-@[-`{-~]/g, "\\$&");

const quoteParser = unified().use(remarkParse).use(remarkGfm);

function normalizeMarkdownQuote(quote: string): string {
  const tree = quoteParser.parse(quote);
  const parts: string[] = [];
  const pending: (typeof tree | (typeof tree.children)[number])[] = [tree];
  while (pending.length) {
    const node = pending.pop();
    if (!node) break;
    if (node.type === "text" || node.type === "inlineCode") parts.push(node.value);
    else if (node.type === "break") parts.push(" ");
    else if ("children" in node) pending.push(...node.children.toReversed());
  }
  return normalizeText(parts.join(""));
}

function reviewMarkdown(review: ReviewVerdict, topics: TopicMeta[]): string {
  let verdict = review.level === "skim" ? "Skim, then merge." : "Read everything.";
  if (review.level === "topics") {
    const names = (review.topics ?? []).map((slug) => {
      const title = (topics.find((topic) => topic.slug === slug)?.title ?? slug).replace(/\s+/g, " ").trim();
      return `“${escapeMarkdown(title)}”`;
    });
    verdict =
      names.length === 1
        ? `Read topic ${names[0]}.`
        : `Read topics ${names.slice(0, -1).join(", ")} and ${names.at(-1)}.`;
  }
  return `**${verdict}** ${review.reason}`;
}

/** `meta.media` maps declared media paths to their SHA-256; only those paths resolve as images. */
export async function renderWriteup(
  writeup: WriteupInput,
  topics: TopicMeta[],
  meta: {
    links?: PublishLinks;
    repoUrl?: string;
    media?: ReadonlyMap<string, string>;
    docs?: DocLinks;
    effects?: RenderEffects;
    /** Displayed pixel size per media SHA-256, read by the server from the stored bytes. */
    mediaSizes?: ReadonlyMap<string, MediaSize>;
  } = {},
): Promise<RenderedWriteup> {
  const sections: RenderedWriteup["sections"] = [];
  const highlightBudget = { highlightedBytes: 0 };
  const entries = Array.isArray(writeup.glossary) ? writeup.glossary : undefined;
  const terms: GlossaryTerm[] = [];
  const matcher = entries ? termMatcher(entries) : undefined;
  let newsItems: { item: NewInRevisionItem; blockIds: string[] }[] = [];
  let needsYou: NonNullable<RenderedWriteup["needsYou"]> = [];
  const appendItems = async <T extends { text: string }, M>(
    key: string,
    label: string,
    items: T[] | undefined,
    metadata: (item: T, blockIds: string[]) => M,
  ): Promise<M[]> => {
    if (!items?.length) return [];
    const blocks: Block[] = [];
    const result: M[] = [];
    const occurrences = new Map<string, number>();
    for (const item of items) {
      const rendered = await renderMarkdownWithBudget(
        item.text,
        key,
        highlightBudget,
        meta.repoUrl,
        meta.media,
        meta.docs,
        "",
        meta.effects,
        meta.mediaSizes,
        matcher,
      );
      if (key === "newInRevision" && !rendered.length) continue;
      for (const block of rendered) {
        const base = block.id.slice(0, key.length + 1 + 8);
        const count = (occurrences.get(base) ?? 0) + 1;
        occurrences.set(base, count);
        block.id = count === 1 ? base : `${base}-${count}`;
        blocks.push(block);
      }
      result.push(
        metadata(
          item,
          rendered.map((block) => block.id),
        ),
      );
    }
    if (result.length) sections.push({ key, label, topic: null, blocks });
    return result;
  };
  const appendOpeningItems = async () => {
    newsItems = await appendItems("newInRevision", "New in this revision", writeup.newInRevision, (item, blockIds) => ({
      item,
      blockIds,
    }));
    needsYou = await appendItems("needsYou", "Needs you", writeup.needsYou, (item, blockIds) => ({
      kind: item.kind,
      ...(item.topic !== undefined ? { topic: item.topic } : {}),
      blockIds,
    }));
  };
  const append = async (key: string, label: string, markdown: string | undefined, topic: string | null = null) => {
    if (markdown === undefined) return;
    sections.push({
      key,
      label,
      topic,
      blocks: await renderMarkdownWithBudget(
        markdown,
        key,
        highlightBudget,
        meta.repoUrl,
        meta.media,
        meta.docs,
        "",
        meta.effects,
        meta.mediaSizes,
        key === "glossary" ? undefined : matcher,
        topic !== null && key === `t-${topic}-example` ? { exampleRows: true } : undefined,
      ),
    });
  };
  if (
    writeup.whyItMatters !== undefined ||
    writeup.area !== undefined ||
    writeup.review !== undefined ||
    writeup.checked !== undefined ||
    writeup.notChecked !== undefined ||
    writeup.outOfScope !== undefined ||
    writeup.whereToLook !== undefined ||
    writeup.context !== undefined
  ) {
    await append("tldr", "TL;DR", writeup.tldr);
    await append("whyItMatters", "Why it matters", writeup.whyItMatters);
    await appendOpeningItems();
    await append("review", "Review", writeup.review ? reviewMarkdown(writeup.review, topics) : undefined);
    await append("checked", "Checked", writeup.checked);
    await append("notChecked", "Not checked", writeup.notChecked);
    await append("overview", "Overview", writeup.overview);
    await append("outOfScope", "Out of scope", writeup.outOfScope);
    await append("whereToLook", "Where to look", writeup.whereToLook);
    await append("context", "Context", writeup.context);
  } else {
    // Keep old manifests unchanged, including imports that re-render their source.
    await append("overview", "Overview", writeup.overview);
    await append("tldr", "TL;DR", writeup.tldr);
    await appendOpeningItems();
  }
  await append("deviations", "Deviations from the approved intent", writeup.deviations);
  await append("decisions", "Decisions and drift", writeup.decisions ?? unwrittenDecisions);
  if (entries) {
    const glossaryBlocks: Block[] = [];
    const occurrences = new Map<string, number>();
    for (const entry of entries) {
      const escaped = escapeMarkdown(normalizeGlossaryForm(entry.term));
      const definition = entry.definition.replace(/\r\n?/g, "\n").replace(/\n/g, "\n  ");
      const rendered = await renderMarkdownWithBudget(
        `- **${escaped}:** ${definition}`,
        "glossary",
        highlightBudget,
        meta.repoUrl,
        meta.media,
        meta.docs,
        "",
        meta.effects,
        meta.mediaSizes,
      );
      for (const block of rendered) {
        const base = block.id.slice(0, "glossary-".length + 8);
        const count = (occurrences.get(base) ?? 0) + 1;
        occurrences.set(base, count);
        block.id = count === 1 ? base : `${base}-${count}`;
        glossaryBlocks.push(block);
      }
      const first = rendered[0];
      if (!first) throw new Error("glossary entry rendered no block");
      const term = normalizeGlossaryForm(entry.term);
      let text = normalizeText(
        rendered
          .filter((block) => block.kind !== "diagram")
          .map((block) => block.text)
          .join(" "),
      );
      const prefix = normalizeText(`${term}:`);
      if (text.startsWith(prefix)) text = text.slice(prefix.length).trim();
      if (text.length > LIMITS.glossaryDefinitionChars) {
        let cut = LIMITS.glossaryDefinitionChars - 1;
        if ((text.codePointAt(cut - 1) ?? 0) > 0xffff) cut--;
        text = `${text.slice(0, cut)}…`;
      }
      terms.push({ term, definition: text, blockId: first.id });
    }
    sections.push({ key: "glossary", label: "Glossary", topic: null, blocks: glossaryBlocks });
  } else {
    await append("glossary", "Glossary", typeof writeup.glossary === "string" ? writeup.glossary : undefined);
  }
  // ECMAScript's stable sort preserves manifest order for equal importance.
  for (const topic of topics.toSorted((a, b) => a.importance - b.importance)) {
    if (!Object.hasOwn(writeup.topics, topic.slug)) continue;
    const content = writeup.topics[topic.slug];
    if (!content) continue;
    await append(`t-${topic.slug}-why`, `${topic.title} — Why`, content.why, topic.slug);
    await append(`t-${topic.slug}-example`, `${topic.title} — Example`, content.example, topic.slug);
    await append(`t-${topic.slug}-body`, `${topic.title} — Details`, content.body, topic.slug);
  }
  const newInRevision = newsItems.map(({ item, blockIds }) => {
    let blockId: string | undefined;
    if (item.quote !== undefined) {
      const candidates = sections
        .filter((section) => {
          if (["newInRevision", "needsYou", "review"].includes(section.key)) return false;
          if (item.topic !== undefined)
            return [`t-${item.topic}-why`, `t-${item.topic}-example`, `t-${item.topic}-body`].includes(section.key);
          return item.section === undefined || section.key === item.section;
        })
        .flatMap((section) => section.blocks);
      for (const normalize of [normalizeText, normalizeMarkdownQuote]) {
        const quote = normalize(item.quote);
        if (!quote) continue;
        blockId = candidates.find((block) => normalizeText(block.text).includes(quote))?.id;
        if (blockId !== undefined) break;
      }
    }
    return {
      ...(item.topic !== undefined ? { topic: item.topic } : {}),
      ...(item.section !== undefined ? { section: item.section } : {}),
      ...(blockId !== undefined ? { blockId } : {}),
      blockIds,
    };
  });
  return {
    sections,
    ...(newInRevision.length ? { newInRevision } : {}),
    ...(writeup.needsYou !== undefined ? { needsYou } : {}),
    ...(writeup.area !== undefined ? { area: writeup.area.replace(/\s+/gu, " ").trim() } : {}),
    ...(terms.length ? { terms } : {}),
    ...(meta.links?.length ? { links: meta.links } : {}),
    ...(meta.repoUrl ? { repoUrl: meta.repoUrl } : {}),
  };
}
