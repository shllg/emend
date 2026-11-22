import type { RenderedBlock, RenderedWriteup, RevisionView, TopicMeta } from "@emend/contract";
import { WRITEUP_SECTION_NAMES } from "../components/diff/targets.ts";
import { plural } from "./count.ts";
import { rankedTopics } from "./topics.ts";

export function usesOpeningCard(writeup: RenderedWriteup): boolean {
  return writeup.area !== undefined || writeup.sections.some((section) => section.key === "whyItMatters");
}

export type FactPart = { text: string; agent?: true; target?: string };

export function labelledFact(blocks: RenderedBlock[], label: "Biggest risk" | "Look yourself" | "Goal" | "Change") {
  const normalizedLabel = label.toLowerCase();
  const collapse = (text: string) => text.replace(/\s+/gu, " ").trim();
  for (const block of blocks) {
    if (block.kind !== "item" && block.kind !== "paragraph") continue;
    const html = block.html;
    if (
      (html.match(/<(?:ul|ol)(?=[\s>])/gu)?.length ?? 0) > 1 ||
      (html.match(/<li(?=[\s>])/gu)?.length ?? 0) > 1 ||
      (html.match(/<p(?=[\s>])/gu)?.length ?? 0) > 1 ||
      /<(?:pre|blockquote|table|details)(?=[\s>])/u.test(html)
    )
      continue;
    // Inspect the server HTML as a string only; the original block remains the rendering boundary.
    const leading = html.match(
      /^\s*(?:<(?:ul|ol)(?:\s[^>]*)?>\s*<li(?:\s[^>]*)?>\s*)?(?:<p(?:\s[^>]*)?>\s*)?<strong(?:\s[^>]*)?>([\s\S]*?)<\/strong>(:)?/u,
    );
    if (!leading) continue;
    const content = collapse(leading[1] ?? "").toLowerCase();
    const hideLabel = content === `${normalizedLabel}:`;
    if (!hideLabel && !(content === normalizedLabel && leading[2] === ":")) continue;
    const labels = [...html.matchAll(/<strong(?:\s[^>]*)?>([\s\S]*?)<\/strong>(:)?/gu)].filter(
      (run) => collapse(run[1] ?? "").endsWith(":") || run[2] === ":",
    );
    if (labels.length !== 1) continue;
    // Trim wrapper whitespace before checking continuation lines, including loose list items.
    const laterLines = block.text
      .trim()
      .split(/\r\n?|\n|\u2028|\u2029/u)
      .slice(1);
    if (laterLines.some((line) => /^(?:Biggest risk|Look yourself|Check first|Goal|Change):/iu.test(line.trim())))
      continue;
    if (/<br(?:\s[^>]*)?>\s*(?:Biggest risk|Look yourself|Check first|Goal|Change):/iu.test(html)) continue;
    return { blocks: [block], hideLabel };
  }
}

function agentPart(text: string): FactPart {
  return { text: text.replace(/[\p{Cc}\u2028\u2029]/gu, " ").replace(/\p{Bidi_Control}/gu, ""), agent: true };
}

export function topicsFact(topics: TopicMeta[]): FactPart[] | undefined {
  const ranked = rankedTopics(topics).map(({ topic }) => topic);
  const parts: FactPart[] = [];
  for (const [attention, label] of [
    ["critical", "High"],
    ["review", "Medium"],
  ] as const) {
    const matching = ranked.filter((topic) => topic.attention === attention);
    if (!matching.length) continue;
    if (parts.length) parts.push({ text: "; " });
    parts.push({ text: `${label}: ` });
    for (const [index, topic] of matching.slice(0, 3).entries()) {
      if (index) parts.push({ text: ", " });
      parts.push(agentPart(topic.title));
    }
    if (matching.length > 3) parts.push({ text: ` and ${matching.length - 3} more` });
  }
  const low = ranked.filter((topic) => topic.attention === "skim").length;
  if (low) parts.push({ text: `${parts.length ? "; and " : ""}${low} Low` });
  return parts.length ? parts : undefined;
}

function undoText(text: string): string | undefined {
  const normalized = text.replace(/\s+/gu, " ").trim();
  for (let index = normalized.indexOf("Undo:"); index !== -1; index = normalized.indexOf("Undo:", index + 5)) {
    if (index === 0 || (index >= 2 && normalized[index - 1] === " " && ".!?:".includes(normalized[index - 2] ?? ""))) {
      return normalized.slice(index + 5).trim() || undefined;
    }
  }
}

function capUndo(text: string): string {
  if (text.length <= 300) return text;
  let end = 299;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return `${text.slice(0, end)}…`;
}

export function undoFact(writeup: RenderedWriteup, topics: TopicMeta[]): FactPart[] | undefined {
  const ranked = rankedTopics(topics);
  if (!ranked.length) return;
  let hardest: { level: number; parts: FactPart[] } = { level: 0, parts: [{ text: "A revert" }] };
  for (const { topic } of ranked) {
    const blocks = writeup.sections.find((section) => section.key === `t-${topic.slug}-why`)?.blocks ?? [];
    let undo: string | undefined;
    for (const block of blocks.toReversed()) {
      undo = undoText(block.text);
      if (undo) break;
    }
    const level = undo ? (/cannot be undone/i.test(undo) ? 2 : 1) : topic.door === "one-way" ? 1 : 0;
    if (level > hardest.level) {
      const text = (undo || "A revert is not enough").replace(/\.$/u, "");
      const parts: FactPart[] = [undo ? agentPart(capUndo(text)) : { text }];
      if (text !== "A revert") parts.push({ text: " (" }, agentPart(topic.title), { text: ")" });
      hardest = { level, parts };
    }
  }
  return hardest.parts;
}

export function sinceFact({
  writeup,
  topics,
  docs,
  files,
  revision,
  changedSince,
  changedBlocks,
  omitWriteup = false,
}: {
  writeup: RenderedWriteup;
  topics: TopicMeta[];
  docs: RevisionView["docs"];
  files: RevisionView["files"];
  revision: number;
  changedSince?: number;
  changedBlocks: RevisionView["changedBlocks"];
  omitWriteup?: boolean;
}): FactPart[] | undefined {
  if (revision < 2 || changedSince === undefined || revision <= changedSince) return;
  const changed = new Set(changedBlocks.map((block) => block.blockId));
  const titles = new Map(topics.map((topic) => [topic.slug, topic.title]));
  const seenTopics = new Set<string>();
  const names: FactPart[][] = [];
  for (const section of omitWriteup ? [] : writeup.sections) {
    if (section.key === "review") continue;
    const firstChanged = section.blocks.find((block) => changed.has(block.id));
    if (!firstChanged) continue;
    if (section.topic) {
      if (!seenTopics.has(section.topic))
        names.push([
          { text: "topic “" },
          { ...agentPart(titles.get(section.topic) ?? section.topic), target: `block-${firstChanged.id}` },
          { text: "”" },
        ]);
      seenTopics.add(section.topic);
    } else {
      const name = WRITEUP_SECTION_NAMES[section.key as keyof typeof WRITEUP_SECTION_NAMES];
      if (name) names.push([{ text: name, target: `block-${firstChanged.id}` }]);
    }
  }
  for (const doc of docs) {
    if (doc.kind === "markdown" && doc.blocks.some((block) => changed.has(block.id))) names.push([agentPart(doc.path)]);
  }
  const stale = files.filter(
    (file) => file.viewed === "stale" && file.viewedOn !== undefined && file.viewedOn >= changedSince,
  ).length;
  const parts: FactPart[] = [{ text: `Since revision ${changedSince}: ` }];
  if (!names.length && !stale) {
    if (omitWriteup) return;
    parts.push({ text: "no new text in the writeup or Markdown docs. Removed text is not tracked." });
    return parts;
  }
  if (names.length) {
    for (const [index, name] of names.entries()) {
      if (index) parts.push({ text: index === names.length - 1 ? " and " : ", " });
      parts.push(...name);
    }
  }
  if (stale) {
    if (names.length) parts.push({ text: "; " });
    parts.push({ text: `${stale} ${plural(stale, "file")} you viewed changed` });
  }
  parts.push({ text: "." });
  return parts;
}
