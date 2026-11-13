import {
  type GlossaryTerm,
  LIMITS,
  normalizeGlossaryForm,
  type PublishLinks,
  type TopicMeta,
  type WriteupInput,
} from "@emend/contract";
import type { DocLinks } from "../links.ts";
import type { Block } from "./blocks.ts";
import { renderMarkdownWithBudget } from "./markdown.ts";
import { normalizeText } from "./normalize.ts";
import type { MediaSize } from "./sanitize.ts";
import { termMatcher } from "./terms.ts";

export type RenderedWriteup = {
  sections: { key: string; label: string; topic: string | null; blocks: Block[] }[];
  terms?: GlossaryTerm[];
  /** Publish-level links and the repo base, kept beside the sections in the stored blob. */
  links?: PublishLinks;
  repoUrl?: string;
};

const unwrittenDecisions =
  "Decisions and drift: not written. Only the session where the change was asked for can tell what drifted from it.";

/** `meta.media` maps declared media paths to their SHA-256; only those paths resolve as images. */
export async function renderWriteup(
  writeup: WriteupInput,
  topics: TopicMeta[],
  meta: {
    links?: PublishLinks;
    repoUrl?: string;
    media?: ReadonlyMap<string, string>;
    docs?: DocLinks;
    effects?: { docBaseUsed?: boolean };
    /** Displayed pixel size per media SHA-256, read by the server from the stored bytes. */
    mediaSizes?: ReadonlyMap<string, MediaSize>;
  } = {},
): Promise<RenderedWriteup> {
  const sections: RenderedWriteup["sections"] = [];
  const highlightBudget = { highlightedBytes: 0 };
  const entries = Array.isArray(writeup.glossary) ? writeup.glossary : undefined;
  const terms: GlossaryTerm[] = [];
  const matcher = entries ? termMatcher(entries) : undefined;
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
      ),
    });
  };
  if (writeup.outOfScope !== undefined || writeup.whereToLook !== undefined || writeup.context !== undefined) {
    await append("tldr", "TL;DR", writeup.tldr);
    await append("overview", "Overview", writeup.overview);
    await append("outOfScope", "Out of scope", writeup.outOfScope);
    await append("whereToLook", "Where to look", writeup.whereToLook);
    await append("context", "Context", writeup.context);
  } else {
    // Keep old manifests unchanged, including imports that re-render their source.
    await append("overview", "Overview", writeup.overview);
    await append("tldr", "TL;DR", writeup.tldr);
  }
  await append("decisions", "Decisions and drift", writeup.decisions ?? unwrittenDecisions);
  if (entries) {
    const glossaryBlocks: Block[] = [];
    const occurrences = new Map<string, number>();
    for (const entry of entries) {
      const escaped = normalizeGlossaryForm(entry.term).replace(/[!-/:-@[-`{-~]/g, "\\$&");
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
  return {
    sections,
    ...(terms.length ? { terms } : {}),
    ...(meta.links?.length ? { links: meta.links } : {}),
    ...(meta.repoUrl ? { repoUrl: meta.repoUrl } : {}),
  };
}
