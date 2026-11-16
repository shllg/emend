import type { RenderedWriteup, RevisionView } from "@emend/contract";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { type CodeFocus, sameCodeFocus } from "../../lib/code-focus.ts";
import { plural } from "../../lib/count.ts";
import { diffGroups } from "../../lib/diff-groups.ts";
import { rankedTopics } from "../../lib/topics.ts";
import { readFact, riskFact, sinceFact, undoFact, usesOpeningCard } from "../../lib/writeup-facts.ts";
import type { ReviewSearch } from "../../router.tsx";
import { BlockReader, type ReaderGroup, type ReaderProps } from "./BlockReader.tsx";
import { GlossaryTerms } from "./GlossaryTerms.tsx";
import { undoSentence } from "./TopicChips.tsx";
import { TopicsMap } from "./TopicsMap.tsx";
import { useCurrentTopic } from "./useCurrentTopic.ts";
import { WriteupOutline } from "./WriteupOutline.tsx";

const emptyTopics: RevisionView["topics"] = [];
const emptyFiles: RevisionView["files"] = [];
const emptyDocs: RevisionView["docs"] = [];

export function Writeup({
  writeup,
  topics = emptyTopics,
  files = emptyFiles,
  docs = emptyDocs,
  changedSince,
  search = {},
  phone = false,
  visible = true,
  onCurrentTopic,
  onNote,
  code,
  ...props
}: ReaderProps & {
  writeup: RenderedWriteup;
  topics?: RevisionView["topics"];
  files?: RevisionView["files"];
  docs?: RevisionView["docs"];
  changedSince?: number;
  search?: ReviewSearch;
  phone?: boolean;
  visible?: boolean;
  onCurrentTopic?: (slug: string | undefined) => void;
  onNote?: (id: string) => void;
  code?: { current?: CodeFocus; onOpen: (focus: CodeFocus, opener: HTMLElement) => void };
}) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => () => onCurrentTopic?.(undefined), [onCurrentTopic]);
  const link = useCallback(
    (hash: string, diff = false) => {
      const next = { tab: diff && phone ? "diff" : search.tab, rev: search.rev };
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(next)) if (value !== undefined) params.set(key, String(value));
      return `/r/${encodeURIComponent(props.reviewId)}${params.size ? `?${params}` : ""}#${hash}`;
    },
    [phone, search.tab, search.rev, props.reviewId],
  );
  const read = useMemo(
    () =>
      usesOpeningCard({ sections: writeup.sections, area: writeup.area })
        ? readFact({ sections: writeup.sections }, docs, files)
        : undefined,
    [writeup.sections, writeup.area, docs, files],
  );
  const groups = useMemo(() => {
    const ranked = rankedTopics(topics);
    const bySlug = new Map(ranked.map((entry) => [entry.topic.slug, entry]));
    const diffs = diffGroups({ files, topics });
    const fileCount = (slug: string) => diffs.get(slug)?.files.length ?? 0;
    const blockTopics = new Map(
      writeup.sections.flatMap((section) => section.blocks.map((block) => [block.id, section.topic] as const)),
    );
    const commentCounts = new Map<string, number>();
    for (const thread of props.threads) {
      if (thread.state === "resolved" || thread.placement.status !== "placed") continue;
      const location = thread.placement.location;
      const slug =
        location.kind === "topic"
          ? location.slug
          : location.kind === "writeup-span"
            ? blockTopics.get(location.blockId)
            : undefined;
      if (slug) commentCounts.set(slug, (commentCounts.get(slug) ?? 0) + 1);
    }
    const groups: ReaderGroup[] = [];
    const newLayout = usesOpeningCard({ sections: writeup.sections, area: writeup.area });
    if (newLayout) {
      const tldr = writeup.sections.find((section) => section.key === "tldr");
      const matters = writeup.sections.find((section) => section.key === "whyItMatters");
      groups.push({
        key: "tldr",
        heading: "TL;DR",
        presentation: "tldr",
        blocks: tldr?.blocks ?? [],
        subsections: matters
          ? [{ key: "whyItMatters", heading: "Why it matters", kind: "matters", blocks: matters.blocks }]
          : [],
      });
      const facts: NonNullable<ReaderGroup["facts"]> = [];
      for (const [key, label] of [
        ["review", "Review"],
        ["checked", "Checked"],
        ["notChecked", "Not checked"],
      ] as const) {
        const blocks = writeup.sections.find((section) => section.key === key)?.blocks;
        if (blocks?.some((block) => block.text.trim())) facts.push({ key, label, blocks });
      }
      const computed = [
        ["risk", "Risk", riskFact(topics)],
        ["undo", "Undo", undoFact({ sections: writeup.sections }, topics)],
        ["read", "Read", read],
        [
          "since",
          "Since",
          sinceFact({
            writeup: { sections: writeup.sections },
            topics,
            docs,
            files,
            revision: props.revision,
            changedSince,
            changedBlocks: props.changedBlocks,
          }),
        ],
      ] as const;
      for (const [key, label, content] of computed) {
        if (content !== undefined)
          facts.push({
            key,
            label,
            content:
              typeof content === "string"
                ? content
                : content.map((part, index) =>
                    part.agent ? (
                      // biome-ignore lint/suspicious/noArrayIndexKey: fact parts are text, rebuilt together in order.
                      <bdi key={index}>{part.text}</bdi>
                    ) : (
                      part.text
                    ),
                  ),
          });
      }
      if (facts.length) groups.push({ key: "facts", heading: "Facts", presentation: "facts", blocks: [], facts });
    }
    for (const section of writeup.sections) {
      if (newLayout && ["tldr", "whyItMatters", "review", "checked", "notChecked"].includes(section.key)) continue;
      const entry = section.topic ? bySlug.get(section.topic) : undefined;
      if (!entry) {
        groups.push({
          key: section.key,
          heading: section.key === "decisions" ? "Decisions & drift" : section.label,
          blocks: section.blocks,
          presentation:
            newLayout &&
            section.key === "overview" &&
            section.blocks.length === 2 &&
            section.blocks.every((block) => block.kind === "item")
              ? "pair"
              : section.key === "tldr" ||
                  section.key === "decisions" ||
                  section.key === "glossary" ||
                  section.key === "outOfScope" ||
                  section.key === "whereToLook" ||
                  section.key === "context"
                ? section.key
                : undefined,
        });
        continue;
      }
      const { topic, rank } = entry;
      const topicFiles = diffs.get(topic.slug)?.files ?? [];
      const topicFocus: CodeFocus = { kind: "topic", slug: topic.slug };
      const topicOpen = sameCodeFocus(code?.current, topicFocus);
      const Chevron = topicOpen ? ChevronLeft : ChevronRight;
      const names = new Map<string, number>();
      for (const file of topicFiles) {
        const name = file.path.split("/").at(-1) ?? file.path;
        names.set(name, (names.get(name) ?? 0) + 1);
      }
      let group = groups.at(-1);
      if (group?.id !== `topic-${topic.slug}`) {
        group = {
          key: section.key,
          id: `topic-${topic.slug}`,
          topic,
          rank,
          commentCount: commentCounts.get(topic.slug) ?? 0,
          heading: (
            <>
              <span>
                <span className="sr-only">Topic {rank}: </span>
                <span data-topic-slug={topic.slug} data-topic-part="title" data-block-text={topic.title}>
                  {topic.title}
                </span>
              </span>
            </>
          ),
          blocks: [],
          subsections: [],
          action:
            topicFiles.length > 0 &&
            (code ? (
              <button
                type="button"
                className="em-topic-code"
                aria-label={`Code: ${topic.title}`}
                aria-expanded={topicOpen}
                data-code-target={`topic:${topic.slug}`}
                onClick={(event) => code.onOpen(topicFocus, event.currentTarget)}
              >
                Code <Chevron size={14} aria-hidden="true" />
              </button>
            ) : (
              <a
                href={link(`diff-topic-${topic.slug}`, true)}
                aria-label={`Files in diff: ${topic.title}`}
                className="em-topic-files"
              >
                {topicFiles.length} {plural(topicFiles.length, "file")} · Files in diff{" "}
                <span aria-hidden="true">→</span>
              </a>
            )),
          files: topicFiles.length > 0 && (
            <ul aria-label="Files" className="em-topic-file-chips">
              {topicFiles.map((file) => {
                const name = file.path.split("/").at(-1) ?? file.path;
                const label = (names.get(name) ?? 0) > 1 ? file.path : name;
                const focus: CodeFocus = { kind: "file", id: file.id };
                return (
                  <li key={file.id}>
                    {code ? (
                      <button
                        type="button"
                        title={file.path}
                        dir="auto"
                        aria-label={`Code: ${file.path}`}
                        aria-expanded={sameCodeFocus(code.current, focus)}
                        data-code-target={`file:${file.id}`}
                        onClick={(event) => code.onOpen(focus, event.currentTarget)}
                      >
                        {label}
                      </button>
                    ) : (
                      <a href={link(`diff-file-${file.id}`, true)} title={file.path} dir="auto">
                        {label}
                      </a>
                    )}
                  </li>
                );
              })}
            </ul>
          ),
          meta: (
            <>
              <p
                className="em-topic-summary"
                data-topic-slug={topic.slug}
                data-topic-part="summary"
                data-block-text={topic.summary}
              >
                {topic.summary}
              </p>
              {topic.door && <p className="em-topic-undo">{undoSentence(topic.door)}</p>}
              {topic.blastRadius && (
                <p className="em-topic-blast">
                  Blast radius: <strong>{topic.blastRadius.scope}</strong> — {topic.blastRadius.note}
                </p>
              )}
            </>
          ),
        };
        groups.push(group);
      }
      const suffix = section.key.slice(section.key.lastIndexOf("-") + 1);
      const kind = suffix === "why" || suffix === "example" ? suffix : "body";
      const heading = kind === "why" ? "Why" : kind === "example" ? "Example" : "Details";
      group.subsections?.push({ key: section.key, heading, kind, blocks: section.blocks });
    }
    if (ranked.length) {
      const written = new Set(groups.flatMap((group) => (group.id ? [group.id] : [])));
      const afterIntro =
        groups.findLastIndex((group) =>
          [
            "overview",
            "tldr",
            "facts",
            "review",
            "checked",
            "notChecked",
            "outOfScope",
            "whereToLook",
            "context",
            "decisions",
            "glossary",
          ].includes(group.key),
        ) + 1;
      groups.splice(afterIntro, 0, {
        key: "topics-map",
        heading: "Topics",
        blocks: [],
        content: (
          <TopicsMap
            topics={ranked}
            fileCount={fileCount}
            href={(slug) =>
              written.has(`topic-${slug}`)
                ? link(`topic-${slug}`)
                : fileCount(slug) > 0
                  ? link(`diff-topic-${slug}`, true)
                  : undefined
            }
          />
        ),
      });
    }
    return groups;
  }, [
    writeup.sections,
    writeup.area,
    topics,
    files,
    docs,
    read,
    changedSince,
    code,
    link,
    props.threads,
    props.revision,
    props.changedBlocks,
  ]);
  const outline = !phone && groups.filter((group) => group.key !== "topics-map").length >= 2;
  useCurrentTopic(root, onCurrentTopic, writeup.sections, visible && !outline);
  return (
    <>
      <div ref={root} className={outline ? "em-outline-layout" : "contents"}>
        {outline && (
          <WriteupOutline
            root={root}
            groups={groups}
            threads={props.threads}
            visible={visible}
            onCurrentTopic={onCurrentTopic}
          />
        )}
        <BlockReader {...props} topics={topics} groups={groups} files={files} onNote={onNote} />
      </div>
      <GlossaryTerms root={root} terms={writeup.terms} href={(blockId) => link(`block-${blockId}`)} />
    </>
  );
}
