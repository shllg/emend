import type { RevisionView } from "@emend/contract";
import { type RefObject, useEffect, useMemo, useState } from "react";
import { revealReadingTarget } from "../../lib/reading-reveal.ts";
import type { ReaderGroup } from "./BlockReader.tsx";

import { DashOutline } from "./DashOutline.tsx";

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
    const updateBottom = () => {
      if (!active()) return;
      const max = scroll.scrollHeight - scroll.clientHeight;
      const scrollTop = scroll.scrollTop;
      const bottom = max > 0 && scrollTop >= max - 1;
      if (bottom !== atBottom) {
        atBottom = bottom;
        report();
      }
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
      updateBottom();
    };
    const resize = new ResizeObserver(observe);
    observe();
    resize.observe(scroll);
    resize.observe(content);
    scroll.addEventListener("scroll", updateBottom, { passive: true });
    return () => {
      stopped = true;
      observer?.disconnect();
      resize.disconnect();
      scroll.removeEventListener("scroll", updateBottom);
      content.style.removeProperty("--reading-sticky-top");
    };
  }, [root, sections, visible, onCurrentTopic]);

  return (
    <div className="em-dash-rail">
      <DashOutline
        label="Writeup outline"
        items={sections.map((group) => ({
          id: group.key,
          label: group.topic?.title ?? group.heading,
          rank: group.rank,
          count: counts.get(group.key) ?? 0,
        }))}
        current={current}
        onPick={(id) => {
          const group = sections.find((group) => group.key === id);
          const section = [...(root.current?.querySelectorAll<HTMLElement>("[data-reading-section]") ?? [])].find(
            (node) => node.dataset.readingSection === id,
          );
          if (!section) return;
          setCurrent(id);
          onCurrentTopic?.(group?.topic?.slug);
          revealReadingTarget(section);
          section.scrollIntoView({ block: "start" });
        }}
      />
    </div>
  );
}
