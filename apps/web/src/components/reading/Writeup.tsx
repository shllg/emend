import type { RenderedWriteup, RevisionView } from "@emend/contract";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { plural } from "../../lib/count.ts";
import { useLayoutPreferences } from "../../lib/layout-store.ts";
import { rankedTopics } from "../../lib/topics.ts";
import type { ReviewSearch } from "../../router.tsx";
import { BlockReader, type ReaderGroup, type ReaderProps } from "./BlockReader.tsx";
import { GlossaryTerms } from "./GlossaryTerms.tsx";
import { undoSentence } from "./TopicChips.tsx";
import { TopicsMap } from "./TopicsMap.tsx";
import { useCurrentTopic } from "./useCurrentTopic.ts";
import { WriteupOutline } from "./WriteupOutline.tsx";

const emptyTopics: RevisionView["topics"] = [];
const emptyFiles: RevisionView["files"] = [];

export function Writeup({
  writeup,
  topics = emptyTopics,
  files = emptyFiles,
  search = {},
  phone = false,
  visible = true,
  onCurrentTopic,
  onNote,
  ...props
}: ReaderProps & {
  writeup: RenderedWriteup;
  topics?: RevisionView["topics"];
  files?: RevisionView["files"];
  search?: ReviewSearch;
  phone?: boolean;
  visible?: boolean;
  onCurrentTopic?: (slug: string | undefined) => void;
  onNote?: (id: string) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const prefs = useLayoutPreferences();
  const compact = !phone && prefs.compact;
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
  const groups = useMemo(() => {
    const ranked = rankedTopics(topics);
    const bySlug = new Map(ranked.map((entry) => [entry.topic.slug, entry]));
    const counts = new Map<string, number>();
    for (const file of files) {
      if (file.role === "diff" && file.topic) counts.set(file.topic, (counts.get(file.topic) ?? 0) + 1);
    }
    const fileCount = (slug: string) => counts.get(slug) ?? 0;
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
    for (const section of writeup.sections) {
      const entry = section.topic ? bySlug.get(section.topic) : undefined;
      if (!entry) {
        groups.push({
          key: section.key,
          heading: section.key === "decisions" ? "Decisions & drift" : section.label,
          blocks: section.blocks,
          presentation:
            section.key === "tldr" ||
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
          action: fileCount(topic.slug) > 0 && (
            <a
              href={link(`diff-topic-${topic.slug}`, true)}
              aria-label={`Files in diff: ${topic.title}`}
              className="em-topic-files"
            >
              {fileCount(topic.slug)} {plural(fileCount(topic.slug), "file")} · Files in diff{" "}
              <span aria-hidden="true">→</span>
            </a>
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
  }, [writeup.sections, topics, files, link, props.threads]);
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
        <BlockReader {...props} topics={topics} groups={groups} compact={compact} files={files} onNote={onNote} />
      </div>
      <GlossaryTerms root={root} terms={writeup.terms} href={(blockId) => link(`block-${blockId}`)} />
    </>
  );
}
