import type { FileView, TopicMeta as Topic } from "@emend/contract";
import { ChevronDown, ChevronRight, FileText, Info, MessageSquarePlus } from "lucide-react";
import { useId, useLayoutEffect, useRef } from "react";
import { plural } from "../../lib/count.ts";
import { lineTotals } from "../../lib/diff-totals.ts";
import { useLayout, useTopicDetails } from "../../lib/layout.ts";
import { useStickyHeight } from "../../lib/sticky-stack.ts";
import { BlastRadius, TopicMeta } from "../reading/TopicMeta.tsx";
import { TopicRank } from "../status/TopicRank.tsx";
import { Composer } from "../threads/Composer.tsx";
import { ThreadCard } from "../threads/ThreadCard.tsx";
import { Button } from "../ui/Button.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { type DiffContext, FileDiff } from "./FileDiff.tsx";
import { LineTotals } from "./LineTotals.tsx";
import { ThreadCount } from "./ThreadCount.tsx";

export function TopicSection({
  topic,
  files,
  rank,
  current,
  writeupLink,
  collapsed,
  onToggle,
  ...context
}: DiffContext & {
  topic: Topic;
  files: FileView[];
  rank?: number;
  current: boolean;
  writeupLink?: string;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const layout = useLayout();
  const phone = layout === "phone";
  const [full, setFull] = useTopicDetails();
  const detailsId = useId();
  const section = useRef<HTMLElement>(null);
  const header = useRef<HTMLElement>(null);
  // File headers stick right below this header, so they need its real height. On the phone it scrolls away.
  useStickyHeight(header, section, "--em-topic-height", !phone);
  const active = context.active;
  const close = () => context.onActive(null);
  const threads = context.threads.filter(
    (thread) =>
      thread.placement.status === "placed" &&
      thread.placement.location.kind === "topic" &&
      thread.placement.location.slug === topic.slug,
  );
  const fileIds = new Set(files.map((file) => file.id));
  const threadCount = context.threads.filter((thread) => {
    if (thread.placement.status !== "placed") return false;
    const location = thread.placement.location;
    return location.kind === "topic"
      ? location.slug === topic.slug
      : fileIds.has(context.fileForTarget(location)?.id ?? "");
  }).length;
  const hasDetails = !!topic.summary || !!topic.blastRadius;
  const anchor = useRef<number>(undefined);
  const toggleDetails = () => {
    const scroller = header.current?.closest("[data-diff-scroll]");
    if (scroller && header.current)
      anchor.current = header.current.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    setFull(!full);
  };
  // Every topic changes height at once and iOS has no scroll anchoring: keep this header where the reader saw it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Runs once per toggle, after the new heights commit.
  useLayoutEffect(() => {
    const before = anchor.current;
    anchor.current = undefined;
    const scroller = header.current?.closest("[data-diff-scroll]");
    if (before === undefined || !scroller || !header.current) return;
    const delta = header.current.getBoundingClientRect().top - scroller.getBoundingClientRect().top - before;
    if (Math.abs(delta) >= 1) scroller.scrollTop += delta;
  }, [full]);
  const meta = (
    <div className="em-topic-meta flex items-center gap-x-3 text-fg-3 [font:var(--type-meta)]">
      <TopicMeta topic={topic} blast={false} />
      <span>
        {files.length} {plural(files.length, "file")}
      </span>
      <LineTotals counts={lineTotals(files, context.counts)} />
      <ThreadCount count={threadCount} />
    </div>
  );
  return (
    <section
      ref={section}
      id={`diff-topic-${topic.slug}`}
      data-diff-section
      data-topic={topic.slug}
      data-phone={phone || undefined}
      className="em-diff-topic"
      aria-label={`Topic ${topic.title}`}
    >
      <header ref={header} data-topic-header className="em-topic" aria-current={current ? "true" : undefined}>
        {rank ? (
          <TopicRank rank={rank} current={current} />
        ) : (
          <span
            aria-hidden="true"
            className="inline-grid h-5 min-w-[22px] place-items-center rounded-sm bg-active font-mono text-11 text-fg-3"
          >
            —
          </span>
        )}
        <div className="min-w-0">
          <h3 title={topic.title} className="truncate text-fg-1 [font:var(--type-h3)]">
            {topic.title}
          </h3>
        </div>
        <div className="flex items-center gap-0.5">
          {writeupLink && (
            <Button asChild variant="ghost" size="sm" icon={FileText}>
              <a href={writeupLink}>Writeup</a>
            </Button>
          )}
          <IconButton
            label="Details"
            icon={Info}
            size="sm"
            pressed={full}
            aria-controls={hasDetails ? detailsId : undefined}
            onClick={toggleDetails}
          />
          <IconButton
            label="Comment on topic"
            icon={MessageSquarePlus}
            size="sm"
            onClick={() => context.onActive({ kind: "topic", slug: topic.slug })}
          />
          <IconButton
            label={collapsed ? "Expand topic" : "Collapse topic"}
            icon={collapsed ? ChevronRight : ChevronDown}
            size="sm"
            aria-expanded={!collapsed}
            onClick={onToggle}
          />
        </div>
        {meta}
      </header>
      {hasDetails && (
        <div id={detailsId} data-topic-details hidden={!full} className="em-topic-details">
          {topic.summary && <p className="whitespace-pre-wrap text-13 leading-[1.45] text-fg-2">{topic.summary}</p>}
          {topic.blastRadius && (
            <p className="text-fg-3 [font:var(--type-meta)]">
              <BlastRadius topic={topic} note />
            </p>
          )}
        </div>
      )}
      <div className="em-diff-discussion">
        {active?.kind === "topic" && active.slug === topic.slug && (
          <Composer
            surface="diff"
            reviewId={context.reviewId}
            revision={context.revision}
            target={active}
            topics={context.topics}
            onSaved={close}
            onCancel={close}
          />
        )}
        {threads.map((thread) => (
          <ThreadCard surface="diff" key={thread.id} {...context} thread={thread} />
        ))}
      </div>
      <div hidden={collapsed} className="px-3 pb-3">
        {files.map((file) => (
          <FileDiff key={file.id} file={file} topicCollapsed={collapsed} {...context} />
        ))}
      </div>
    </section>
  );
}
