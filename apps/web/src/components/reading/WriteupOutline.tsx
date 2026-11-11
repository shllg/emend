import type { RevisionView } from "@emend/contract";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { plural } from "../../lib/count.ts";
import { revealReadingTarget } from "../../lib/reading-reveal.ts";
import { TopicRank } from "../status/TopicRank.tsx";
import type { ReaderGroup } from "./BlockReader.tsx";

export const OUTLINE_WIDTH = 184;
export const OUTLINE_MIN_WIDTH = 640;

export function WriteupOutline({
  root,
  groups,
  threads,
  visible,
  onCurrentTopic,
}: {
  root: RefObject<HTMLDivElement | null>;
  groups: ReaderGroup[];
  threads: RevisionView["threads"];
  visible: boolean;
  onCurrentTopic?: (slug: string | undefined) => void;
}) {
  const progress = useRef<HTMLDivElement>(null);
  const sections = useMemo(() => groups.filter((group) => group.key !== "topics-map"), [groups]);
  const [current, setCurrent] = useState(sections[0]?.key);
  const counts = useMemo(() => {
    const blocks = new Map(
      sections.flatMap((group) =>
        [...group.blocks, ...(group.subsections?.flatMap((section) => section.blocks) ?? [])].map(
          (block) => [block.id, group.key] as const,
        ),
      ),
    );
    const topics = new Map(sections.flatMap((group) => (group.topic ? [[group.topic.slug, group.key]] : [])));
    const counts = new Map<string, number>();
    for (const thread of threads) {
      if (thread.placement.status !== "placed") continue;
      const location = thread.placement.location;
      const key =
        location.kind === "writeup-span"
          ? blocks.get(location.blockId)
          : location.kind === "topic"
            ? topics.get(location.slug)
            : undefined;
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [sections, threads]);

  useEffect(() => {
    const content = root.current;
    const scroll = content?.closest<HTMLElement>("[data-reading-scroll]");
    if (!visible || !content || !scroll) return;
    let stopped = false;
    let frame: number | undefined;
    let observer: IntersectionObserver | undefined;
    let tabRow: HTMLElement | null = null;
    let tabHeight = 0;
    let atBottom = false;
    const headers = sections.flatMap((group) => {
      const section = [...content.querySelectorAll<HTMLElement>("[data-reading-section]")].find(
        (node) => node.dataset.readingSection === group.key,
      );
      const heading = section?.querySelector<HTMLElement>("h2, summary");
      return heading ? [{ group, heading }] : [];
    });
    const active = () => !stopped && !scroll.closest("[hidden]");
    const report = () => {
      if (!active()) return;
      const viewportTop = scroll.getBoundingClientRect().top;
      // Include the topic's top padding and kicker when scrolled into place.
      const edge = viewportTop + tabHeight + 96;
      const bounds = headers.map((entry) => ({ ...entry, rect: entry.heading.getBoundingClientRect() }));
      const lastVisible = atBottom
        ? bounds.findLast(
            ({ rect }) => rect.bottom > viewportTop + tabHeight && rect.top < viewportTop + scroll.clientHeight,
          )
        : undefined;
      const section = lastVisible ?? bounds.findLast(({ rect }) => rect.top <= edge) ?? bounds[0];
      setCurrent(section?.group.key);
      onCurrentTopic?.(section?.group.topic?.slug);
    };
    const updateProgress = () => {
      frame = undefined;
      if (!active() || !progress.current) return;
      const max = scroll.scrollHeight - scroll.clientHeight;
      const scrollTop = scroll.scrollTop;
      const ratio = max > 0 ? Math.min(1, Math.max(0, scrollTop / max)) : 1;
      progress.current.style.transform = `scaleX(${ratio})`;
      const bottom = max > 0 && scrollTop >= max - 1;
      if (bottom !== atBottom) {
        atBottom = bottom;
        report();
      }
    };
    const scheduleProgress = () => {
      if (active() && frame === undefined) frame = requestAnimationFrame(updateProgress);
    };
    const observe = () => {
      if (!active()) return;
      observer?.disconnect();
      const nextTabRow = scroll.querySelector<HTMLElement>(".em-review-tabs");
      if (tabRow !== nextTabRow) {
        if (tabRow) resize.unobserve(tabRow);
        tabRow = nextTabRow;
        if (tabRow) resize.observe(tabRow);
      }
      tabHeight = tabRow?.getBoundingClientRect().height ?? 0;
      content.style.setProperty("--reading-sticky-top", `${tabHeight}px`);
      const top = tabHeight + 96;
      // Include all headers below the reading edge so even a large scroll jump changes
      // intersection state. A thin strip could skip a header between observer samples.
      observer = new IntersectionObserver(report, {
        root: scroll,
        rootMargin: `-${top}px 0px ${scroll.scrollHeight}px 0px`,
        threshold: 1,
      });
      for (const { heading } of headers) observer.observe(heading);
      report();
      scheduleProgress();
    };
    const resize = new ResizeObserver(observe);
    observe();
    resize.observe(scroll);
    resize.observe(content);
    scroll.addEventListener("scroll", scheduleProgress, { passive: true });
    return () => {
      stopped = true;
      observer?.disconnect();
      resize.disconnect();
      scroll.removeEventListener("scroll", scheduleProgress);
      if (frame !== undefined) cancelAnimationFrame(frame);
      content.style.removeProperty("--reading-sticky-top");
    };
  }, [root, sections, visible, onCurrentTopic]);

  return (
    <>
      <div ref={progress} className="em-outline-progress" style={{ transform: "scaleX(0)" }} aria-hidden="true" />
      <nav className="em-outline" aria-label="Writeup outline">
        <div className="em-outline__label">WRITEUP</div>
        {sections.map((group) => {
          const count = counts.get(group.key) ?? 0;
          return (
            <button
              key={group.key}
              type="button"
              className="em-outline__item"
              aria-current={current === group.key ? "location" : undefined}
              onClick={() => {
                const section = [...(root.current?.querySelectorAll<HTMLElement>("[data-reading-section]") ?? [])].find(
                  (node) => node.dataset.readingSection === group.key,
                );
                if (!section) return;
                setCurrent(group.key);
                onCurrentTopic?.(group.topic?.slug);
                revealReadingTarget(section);
                section.scrollIntoView({ block: "start" });
              }}
            >
              {group.rank !== undefined && <TopicRank rank={group.rank} />}
              <span className="em-outline__text">{group.topic?.title ?? group.heading}</span>
              {count > 0 && (
                <span className="em-outline__count" title={`${count} ${plural(count, "comment")}`}>
                  {count}
                  <span className="sr-only"> {plural(count, "comment")}</span>
                </span>
              )}
            </button>
          );
        })}
      </nav>
    </>
  );
}
