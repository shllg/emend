import type { RenderedWriteup, RevisionView } from "@emend/contract";
import { ChevronLeft, ChevronRight, CircleAlert, CircleCheck } from "lucide-react";
import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { type CodeFocus, sameCodeFocus } from "../../lib/code-focus.ts";
import { plural } from "../../lib/count.ts";
import { diffGroups } from "../../lib/diff-groups.ts";
import { HIDDEN_COMMENTS_GROUP, HIDDEN_WRITEUP_SECTIONS } from "../../lib/hidden-writeup.ts";
import { needsYouLabels, needsYouStatus } from "../../lib/needs-you.ts";
import { useReadOnlyReview } from "../../lib/read-only-review.ts";
import { rankedTopics } from "../../lib/topics.ts";
import { type FactPart, labelledFact, sinceFact, undoFact, usesOpeningCard } from "../../lib/writeup-facts.ts";
import type { ReviewSearch } from "../../router.tsx";
import { WRITEUP_SECTION_NAMES } from "../diff/targets.ts";
import { ThreadCard } from "../threads/ThreadCard.tsx";
import { BlockReader, groupBlocks, type ReaderFact, type ReaderGroup, type ReaderProps } from "./BlockReader.tsx";
import { DepthMarker } from "./DepthMarker.tsx";
import { GlossaryTerms } from "./GlossaryTerms.tsx";
import { IssueCards } from "./IssueCards.tsx";
import { undoSentence } from "./TopicChips.tsx";
import { TopicsMap } from "./TopicsMap.tsx";
import { useCurrentTopic } from "./useCurrentTopic.ts";
import { depthLayers, useDepthLayer } from "./useDepthLayer.ts";
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
  depthSlot,
  onCurrentTopic,
  onNote,
  code,
  issueRefs,
  repoUrl,
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
  depthSlot?: HTMLElement | null;
  onCurrentTopic?: (slug: string | undefined) => void;
  onNote?: (id: string) => void;
  issueRefs?: RevisionView["issueRefs"];
  repoUrl?: string | null;
  code?: { current?: CodeFocus; onOpen: (focus: CodeFocus, opener: HTMLElement) => void };
}) {
  const readOnly = useReadOnlyReview();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => () => onCurrentTopic?.(undefined), [onCurrentTopic]);
  const link = useCallback(
    (hash: string, diff = false) => {
      if (readOnly) return `#${hash}`;
      const next = { tab: diff && phone ? "diff" : search.tab, rev: search.rev };
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(next)) if (value !== undefined) params.set(key, String(value));
      return `/r/${encodeURIComponent(props.reviewId)}${params.size ? `?${params}` : ""}#${hash}`;
    },
    [readOnly, phone, search.tab, search.rev, props.reviewId],
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
    const lifted = new Set<string>();
    const risk: ReaderFact[] = [];
    const frame: ReaderFact[] = [];
    const computed = (facts: ReaderFact[], key: string, label: string, parts: FactPart[] | undefined) => {
      if (!parts) return;
      facts.push({
        key,
        label,
        content: parts.map((part, index) => {
          const text = part.agent ? <bdi>{part.text}</bdi> : part.text;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: fact parts are text, rebuilt together in order.
            <Fragment key={index}>{part.target ? <a href={link(part.target)}>{text}</a> : text}</Fragment>
          );
        }),
      });
    };
    if (newLayout) {
      const tldr = writeup.sections.find((section) => section.key === "tldr");
      const matters = writeup.sections.find((section) => section.key === "whyItMatters");
      groups.push({
        key: "tldr",
        layer: "decide",
        heading: "TL;DR",
        presentation: "tldr",
        blocks: tldr?.blocks ?? [],
        subsections: matters
          ? [{ key: "whyItMatters", heading: "Why it matters", kind: "matters", blocks: matters.blocks }]
          : [],
      });
      const blocksFor = (key: string) => writeup.sections.find((section) => section.key === key)?.blocks ?? [];
      const lift = (facts: ReaderFact[], key: string, label: Parameters<typeof labelledFact>[1], section: string) => {
        const fact = labelledFact(blocksFor(section), label);
        if (!fact) return;
        for (const block of fact.blocks) lifted.add(block.id);
        facts.push({ key, label, ...fact });
      };
      const rows = (facts: ReaderFact[], key: string, label: string, blocks: ReaderFact["blocks"]) => {
        if (blocks?.length) facts.push({ key, label, blocks });
      };
      lift(risk, "risk", "Biggest risk", "whereToLook");
      computed(risk, "undo", "Undo", undoFact({ sections: writeup.sections }, topics));
      const checked = blocksFor("checked");
      rows(risk, "proof", "Proof", checked.slice(0, 1));
      rows(risk, "gaps", "Gaps", blocksFor("notChecked"));
      lift(risk, "look", "Look yourself", "whereToLook");
      if (checked.length > 1) {
        const count = checked.length - 1;
        risk.push({
          key: "assurance",
          label: "Assurance",
          blocks: checked.slice(1),
          fold: { key: "checked-more", summary: `and ${count} more ${plural(count, "check")}` },
        });
      }
      lift(frame, "goal", "Goal", "overview");
      lift(frame, "change", "Change", "overview");
      const outOfScope = blocksFor("outOfScope");
      rows(frame, "outOfScope", "Out of scope", outOfScope);
      for (const block of outOfScope) lifted.add(block.id);
    }
    for (const section of writeup.sections) {
      if (HIDDEN_WRITEUP_SECTIONS.has(section.key)) continue;
      if (section.key === "newInRevision" && (props.revision < 2 || writeup.newInRevision !== undefined)) continue;
      if (section.key === "needsYou" && writeup.needsYou !== undefined) continue;
      if (newLayout && ["tldr", "whyItMatters", "checked", "notChecked"].includes(section.key)) continue;
      const blocks = section.blocks.filter((block) => !lifted.has(block.id));
      if (section.blocks.length && !blocks.length) continue;
      const entry = section.topic ? bySlug.get(section.topic) : undefined;
      if (!entry) {
        groups.push({
          key: section.key,
          layer:
            ["tldr", "newInRevision", "needsYou", "whereToLook"].includes(section.key) ||
            (!newLayout && section.key === "overview")
              ? "decide"
              : ["decisions", "context", "glossary"].includes(section.key)
                ? "trail"
                : /^t-.+-(?:why|example|body)$/u.test(section.key)
                  ? "topics"
                  : "frame",
          heading: section.key === "decisions" ? "Decisions & drift" : section.label,
          blocks,
          presentation:
            newLayout &&
            section.key === "overview" &&
            blocks.length === 2 &&
            blocks.every((block) => block.kind === "item")
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
          layer: "topics",
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
    const written = new Set(groups.flatMap((group) => (group.id ? [group.id] : [])));
    const topicHref = (slug: string) =>
      written.has(`topic-${slug}`)
        ? link(`topic-${slug}`)
        : fileCount(slug) > 0
          ? link(`diff-topic-${slug}`, true)
          : undefined;
    const needsSection = writeup.sections.find((section) => section.key === "needsYou");
    if (writeup.needsYou !== undefined && needsSection) {
      const blocksById = new Map(needsSection.blocks.map((block) => [block.id, block]));
      const needs = writeup.needsYou.map((item, index) => {
        const topic = item.topic ? bySlug.get(item.topic)?.topic : undefined;
        const href = topic ? topicHref(topic.slug) : undefined;
        return {
          key: String(index),
          kind: item.kind,
          label: needsYouLabels[item.kind],
          blocks: item.blockIds.flatMap((id) => {
            const block = blocksById.get(id);
            return block ? [block] : [];
          }),
          jump:
            topic && href ? (
              <a className="em-needs-topic" href={href}>
                <span aria-hidden="true">→</span> <bdi>{topic.title}</bdi>
              </a>
            ) : undefined,
        };
      });
      groups.splice(groups.findIndex((group) => group.key === "tldr") + 1, 0, {
        key: "needsYou",
        layer: "decide",
        heading: "Needs you",
        presentation: "needsYou",
        blocks: [],
        needs,
      });
    }
    const newsSection = writeup.sections.find((section) => section.key === "newInRevision");
    const newsItems = writeup.newInRevision;
    let showNews = false;
    if (props.revision >= 2 && newsItems !== undefined && newsSection !== undefined) {
      const blocksById = new Map(newsSection.blocks.map((block) => [block.id, block]));
      const changed = new Set(props.changedBlocks.map((block) => block.blockId));
      const shown = new Set(
        [
          ...groups.flatMap(groupBlocks),
          ...risk.flatMap((fact) => fact.blocks ?? []),
          ...frame.flatMap((fact) => fact.blocks ?? []),
        ].map((block) => block.id),
      );
      const placesByBlock = new Map(
        writeup.sections.flatMap((section) =>
          section.blocks.filter((block) => shown.has(block.id)).map((block) => [block.id, section] as const),
        ),
      );
      const news = newsItems.flatMap((item, index) => {
        const blocks = item.blockIds.flatMap((id) => {
          const block = blocksById.get(id);
          return block ? [block] : [];
        });
        if (!blocks.length) return [];
        const place = item.blockId !== undefined ? placesByBlock.get(item.blockId) : undefined;
        let href: string | undefined;
        let label: ReactNode;
        if (item.topic !== undefined) {
          const topic = bySlug.get(item.topic)?.topic;
          if (topic) {
            const keys = new Set([`t-${topic.slug}-why`, `t-${topic.slug}-example`, `t-${topic.slug}-body`]);
            const firstChanged = writeup.sections
              .filter((section) => keys.has(section.key))
              .flatMap((section) => section.blocks)
              .find((block) => changed.has(block.id));
            href = firstChanged ? link(`block-${firstChanged.id}`) : topicHref(topic.slug);
            label = <bdi>{topic.title}</bdi>;
          }
        } else if (item.section !== undefined) {
          const blocks = writeup.sections.find((section) => section.key === item.section)?.blocks ?? [];
          const target = blocks.find((block) => changed.has(block.id)) ?? blocks[0];
          if (target) href = link(`block-${target.id}`);
          label = WRITEUP_SECTION_NAMES[item.section];
        }
        if (place) {
          href = link(`block-${item.blockId}`);
          if (item.topic === undefined && item.section === undefined) {
            const slug = /^t-(.+)-(?:why|example|body)$/.exec(place.key)?.[1];
            const topic = slug ? bySlug.get(slug)?.topic : undefined;
            label = topic ? (
              <bdi>{topic.title}</bdi>
            ) : (
              WRITEUP_SECTION_NAMES[place.key as keyof typeof WRITEUP_SECTION_NAMES]
            );
          }
        }
        return [
          {
            key: String(index),
            blocks,
            jump:
              href && label !== undefined ? (
                <a className="em-needs-topic" href={href}>
                  <span aria-hidden="true">→</span> {label}
                </a>
              ) : undefined,
          },
        ];
      });
      showNews = news.length > 0;
      if (showNews)
        groups.splice(groups.findIndex((group) => group.key === "tldr") + 1, 0, {
          key: "newInRevision",
          layer: "decide",
          heading: "New in this revision",
          presentation: "newInRevision",
          blocks: [],
          news,
        });
    }
    if (newLayout) {
      groups.push(
        {
          key: "risk",
          heading: "Risk",
          layer: "decide",
          presentation: "facts",
          blocks: [],
          factGroups: [{ key: "risk", label: "Risk", facts: risk }],
        },
        {
          key: "frame",
          heading: "Frame",
          layer: "frame",
          presentation: "facts",
          blocks: [],
          factGroups: [{ key: "frame", label: "Frame", facts: frame }],
        },
      );
    }
    if (ranked.length) {
      groups.push({
        key: "topics-map",
        heading: "Topics",
        layer: "frame",
        blocks: [],
        content: <TopicsMap topics={ranked} href={topicHref} />,
      });
    }
    // Stable sorting retains the section order within each layer. The inserted facts
    // bracket the opening, and the index always closes Frame.
    const withinLayer = (group: ReaderGroup) => {
      if (group.layer === "decide") return group.key === "whereToLook" ? 2 : group.key === "risk" ? 1 : 0;
      if (group.layer === "frame") return group.key === "frame" ? -1 : group.key === "topics-map" ? 1 : 0;
      if (group.layer === "topics") return group.rank ?? ranked.length + 1;
      return ["decisions", "context", "glossary", HIDDEN_COMMENTS_GROUP].indexOf(group.key);
    };
    groups.sort(
      (a, b) =>
        depthLayers.indexOf(a.layer ?? "frame") - depthLayers.indexOf(b.layer ?? "frame") ||
        withinLayer(a) - withinLayer(b),
    );
    if (newLayout) {
      const furtherDown = groups.slice(groups.findIndex((group) => group.key === "topics-map") + 1).flatMap((group) => {
        const first = group.blocks[0];
        return first && group.layer === "trail" && group.key !== HIDDEN_COMMENTS_GROUP ? [{ group, first }] : [];
      });
      if (furtherDown.length) {
        frame.push({
          key: "furtherDown",
          label: "Further down",
          content: furtherDown.map(({ group, first }, index) => (
            <Fragment key={group.key}>
              {index > 0 && " · "}
              <a href={link(`block-${first.id}`)}>{group.heading}</a>
            </Fragment>
          )),
        });
      }
      computed(
        frame,
        "since",
        "Changed",
        sinceFact({
          writeup: { sections: writeup.sections },
          topics,
          docs,
          files,
          revision: props.revision,
          changedSince,
          changedBlocks: props.changedBlocks,
          omitWriteup: showNews,
        }),
      );
    }
    const shownBlocks = new Set(groups.flatMap((group) => groupBlocks(group).map((block) => block.id)));
    const hiddenThreads = props.threads.filter(
      (thread) =>
        thread.placement.status === "placed" &&
        thread.placement.location.kind === "writeup-span" &&
        !shownBlocks.has(thread.placement.location.blockId),
    );
    if (hiddenThreads.length) {
      groups.push({
        key: HIDDEN_COMMENTS_GROUP,
        layer: "trail",
        heading: "Comments on hidden text",
        blocks: [],
        content: (
          <div className="space-y-3">
            {hiddenThreads.map((thread) => (
              <ThreadCard
                key={thread.id}
                surface="reading"
                reviewId={props.reviewId}
                revision={props.revision}
                thread={thread}
                changedBlocks={props.changedBlocks}
                topics={topics}
                note="The writeup no longer shows the text this comment is on."
              />
            ))}
          </div>
        ),
      });
    }
    return groups.filter(
      (group) => group.presentation !== "facts" || group.factGroups?.some((part) => part.facts.length),
    );
  }, [
    writeup.sections,
    writeup.area,
    writeup.newInRevision,
    writeup.needsYou,
    topics,
    files,
    docs,
    changedSince,
    code,
    link,
    props.threads,
    props.reviewId,
    props.revision,
    props.changedBlocks,
  ]);
  const layout = useMemo(() => groups.map((group) => `${group.key}:${group.layer ?? ""}`).join("|"), [groups]);
  const depth = useDepthLayer(root, visible && !!depthSlot, layout);
  const outline = !phone && groups.filter((group) => group.key !== "topics-map").length >= 2;
  const status = needsYouStatus(writeup.needsYou);
  const openNeeds = (writeup.needsYou?.length ?? 0) > 0;
  const firstNeedBlock = writeup.needsYou?.[0]?.blockIds[0];
  const NeedsIcon = openNeeds ? CircleAlert : CircleCheck;
  useCurrentTopic(root, onCurrentTopic, writeup.sections, visible && !outline);
  return (
    <>
      {depthSlot &&
        groups.some((group) => group.layer) &&
        createPortal(<DepthMarker current={depth.current} present={depth.present} compact={phone} />, depthSlot)}
      <div ref={root} className={outline ? "em-outline-layout" : "min-w-0"}>
        {outline && (
          <WriteupOutline
            root={root}
            groups={groups}
            threads={props.threads}
            visible={visible}
            onCurrentTopic={onCurrentTopic}
          />
        )}
        <BlockReader
          {...props}
          topics={topics}
          groups={groups}
          files={files}
          onNote={onNote}
          lead={
            status !== undefined && (
              <p className="em-needs-status" data-state={openNeeds ? "open" : "clear"}>
                <NeedsIcon size={14} aria-hidden="true" />
                {openNeeds && firstNeedBlock ? <a href={link(`block-${firstNeedBlock}`)}>{status}</a> : status}
              </p>
            )
          }
        />
      </div>
      <GlossaryTerms root={root} terms={writeup.terms} href={(blockId) => link(`block-${blockId}`)} />
      <IssueCards root={root} repoUrl={repoUrl} refs={issueRefs} />
    </>
  );
}
