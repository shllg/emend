import type { RenderedWriteup, RevisionView, TopicMeta } from "@emend/contract";
import { WRITEUP_SECTION_NAMES } from "../components/diff/targets.ts";
import { plural } from "./count.ts";
import { rankedTopics } from "./topics.ts";

export function riskFact(topics: TopicMeta[]): string | undefined {
  for (const [attention, label] of [
    ["critical", "High"],
    ["review", "Medium"],
    ["skim", "Low"],
  ] as const) {
    const matching = topics.filter((topic) => topic.attention === attention);
    if (!matching.length) continue;
    const titles = matching
      .slice(0, 3)
      .map((topic) => topic.title)
      .join(", ");
    return `${label}: ${titles}${matching.length > 3 ? ` and ${matching.length - 3} more` : ""}`;
  }
}

export function undoFact(writeup: RenderedWriteup, topics: TopicMeta[]): string | undefined {
  const ranked = rankedTopics(topics);
  if (!ranked.length) return;
  let hardest = { level: 0, text: "A revert" };
  for (const { topic } of ranked) {
    const blocks = writeup.sections.find((section) => section.key === `t-${topic.slug}-why`)?.blocks ?? [];
    let undo: string | undefined;
    for (const block of blocks.toReversed()) {
      const match = /(?:^|[.!?:]\s+)Undo:\s*(\S.*)$/u.exec(block.text.trim());
      if (match) {
        undo = match[1];
        break;
      }
    }
    const level = undo ? (/cannot be undone/i.test(undo) ? 2 : 1) : topic.door === "one-way" ? 1 : 0;
    if (level > hardest.level) {
      const text = (undo || "A revert is not enough").replace(/\.$/u, "");
      hardest = { level, text: text === "A revert" ? text : `${text} (${topic.title})` };
    }
  }
  return hardest.text;
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
  const wordCount =
    writeup.sections.reduce(
      (sum, section) => sum + section.blocks.reduce((sum, block) => sum + words(block.text), 0),
      0,
    ) +
    docs.reduce(
      (sum, doc) => sum + (doc.kind === "markdown" ? doc.blocks.reduce((sum, block) => sum + words(block.text), 0) : 0),
      0,
    );
  const lines = files.reduce(
    (sum, file) => sum + (file.role === "diff" && file.counts ? file.counts.additions + file.counts.deletions : 0),
    0,
  );
  if (!wordCount && !lines) return;
  // Eight changed lines a minute is the common ceiling of about 500 lines an hour for careful review.
  const rawMinutes = wordCount / 200 + lines / 8;
  if (rawMinutes < 1) return "Under 1 min";
  const proseMinutes = Math.ceil(wordCount / 200);
  const diffMinutes = Math.ceil(lines / 8);
  const parts = [
    ...(wordCount ? [`writeup and docs ${minutesText(proseMinutes)}`] : []),
    ...(lines ? [`diff ${minutesText(diffMinutes)} (${lines} ${plural(lines, "line")})`] : []),
  ];
  return `About ${minutesText(proseMinutes + diffMinutes)}: ${parts.join(", ")}`;
}

function joinNames(names: string[]): string {
  return names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
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
}): string | undefined {
  if (revision < 2 || changedSince === undefined || revision <= changedSince) return;
  const changed = new Set(changedBlocks.map((block) => block.blockId));
  const titles = new Map(topics.map((topic) => [topic.slug, topic.title]));
  const seenTopics = new Set<string>();
  const names: string[] = [];
  for (const section of writeup.sections) {
    if (!section.blocks.some((block) => changed.has(block.id))) continue;
    if (section.topic) {
      if (!seenTopics.has(section.topic)) names.push(`topic “${titles.get(section.topic) ?? section.topic}”`);
      seenTopics.add(section.topic);
    } else {
      const name = WRITEUP_SECTION_NAMES[section.key as keyof typeof WRITEUP_SECTION_NAMES];
      if (name) names.push(name);
    }
  }
  for (const doc of docs) {
    if (doc.kind === "markdown" && doc.blocks.some((block) => changed.has(block.id))) names.push(doc.title || doc.path);
  }
  const stale = files.filter((file) => file.viewed === "stale").length;
  if (stale) names.push(`${stale} ${plural(stale, "file")} you viewed`);
  return names.length
    ? `Since revision ${changedSince}: ${joinNames(names)} changed.`
    : `Since revision ${changedSince}, nothing in the writeup, the docs or the files you viewed changed.`;
}
