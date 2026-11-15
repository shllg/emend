import type { RenderedWriteup, RevisionView, TopicMeta } from "@emend/contract";
import { WRITEUP_SECTION_NAMES } from "../components/diff/targets.ts";
import { plural } from "./count.ts";
import { rankedTopics } from "./topics.ts";

export function usesOpeningCard(writeup: RenderedWriteup): boolean {
  return writeup.area !== undefined || writeup.sections.some((section) => section.key === "whyItMatters");
}

export type FactPart = { text: string; agent?: true };

function agentPart(text: string): FactPart {
  return { text: text.replace(/[\p{Cc}\u2028\u2029]/gu, " ").replace(/\p{Bidi_Control}/gu, ""), agent: true };
}

export function riskFact(topics: TopicMeta[]): FactPart[] | undefined {
  for (const [attention, label] of [
    ["critical", "High"],
    ["review", "Medium"],
    ["skim", "Low"],
  ] as const) {
    const matching = topics.filter((topic) => topic.attention === attention);
    if (!matching.length) continue;
    const parts: FactPart[] = [{ text: `${label}: ` }];
    for (const [index, topic] of matching.slice(0, 3).entries()) {
      if (index) parts.push({ text: ", " });
      parts.push(agentPart(topic.title));
    }
    if (matching.length > 3) parts.push({ text: ` and ${matching.length - 3} more` });
    return parts;
  }
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

function minutesText(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const rounded = Math.round(minutes / 5) * 5;
  const remainder = rounded % 60;
  return `${Math.floor(rounded / 60)} h${remainder ? ` ${remainder} min` : ""}`;
}

export function readFact(
  writeup: RenderedWriteup,
  docs: RevisionView["docs"],
  files: RevisionView["files"],
): string | undefined {
  const words = (text: string) => text.match(/\S+/gu)?.length ?? 0;
  const docWords = docs.reduce((sum, doc) => {
    if (doc.kind === "markdown") return sum + doc.blocks.reduce((sum, block) => sum + words(block.text), 0);
    if (doc.kind === "source")
      return sum + doc.lines.reduce((sum, line) => sum + words(line.map((token) => token.text).join("")), 0);
    return sum;
  }, 0);
  const wordCount =
    writeup.sections.reduce(
      (sum, section) => sum + section.blocks.reduce((sum, block) => sum + words(block.text), 0),
      0,
    ) + docWords;
  const lines = files.reduce(
    (sum, file) => sum + (file.role === "diff" && file.counts ? file.counts.additions + file.counts.deletions : 0),
    0,
  );
  const uncounted = files.filter((file) => file.role === "diff" && !file.counts).length;
  const skipped =
    (docs.some((doc) => doc.kind === "html") ? "; HTML docs not counted" : "") +
    (uncounted ? `; ${uncounted} diff ${plural(uncounted, "file")} not counted` : "");
  if (!wordCount && !lines) return skipped ? `Not estimated${skipped}` : undefined;
  // Eight changed lines a minute is the common ceiling of about 500 lines an hour for careful review.
  const rawMinutes = wordCount / 200 + lines / 8;
  if (rawMinutes < 1) return `Under 1 min${skipped}`;
  const proseMinutes = Math.ceil(wordCount / 200);
  const diffMinutes = Math.ceil(lines / 8);
  const parts = [
    ...(wordCount ? [`${docWords ? "writeup and docs" : "writeup"} ${minutesText(proseMinutes)}`] : []),
    ...(lines ? [`diff ${minutesText(diffMinutes)} (${lines} ${plural(lines, "line")})`] : []),
  ];
  return `About ${minutesText(proseMinutes + diffMinutes)}: ${parts.join(", ")}${skipped}`;
}

export function sinceFact({
  writeup,
  topics,
  docs,
  files,
  revision,
  changedSince,
  changedBlocks,
}: {
  writeup: RenderedWriteup;
  topics: TopicMeta[];
  docs: RevisionView["docs"];
  files: RevisionView["files"];
  revision: number;
  changedSince?: number;
  changedBlocks: RevisionView["changedBlocks"];
}): FactPart[] | undefined {
  if (revision < 2 || changedSince === undefined || revision <= changedSince) return;
  const changed = new Set(changedBlocks.map((block) => block.blockId));
  const titles = new Map(topics.map((topic) => [topic.slug, topic.title]));
  const seenTopics = new Set<string>();
  const names: FactPart[][] = [];
  for (const section of writeup.sections) {
    if (!section.blocks.some((block) => changed.has(block.id))) continue;
    if (section.topic) {
      if (!seenTopics.has(section.topic))
        names.push([{ text: "topic “" }, agentPart(titles.get(section.topic) ?? section.topic), { text: "”" }]);
      seenTopics.add(section.topic);
    } else {
      const name = WRITEUP_SECTION_NAMES[section.key as keyof typeof WRITEUP_SECTION_NAMES];
      if (name) names.push([{ text: name }]);
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
    parts.push({ text: "no new text in the writeup or Markdown docs. Removed text is not tracked." });
    return parts;
  }
  if (names.length) {
    parts.push({ text: "new or changed text in " });
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
