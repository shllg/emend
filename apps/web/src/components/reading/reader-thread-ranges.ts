import type { ThreadView } from "@emend/contract";
import { mapBlockText } from "../../lib/block-ranges.ts";
import { supportsCommentHighlights } from "../../lib/comment-highlights.ts";
import { revealReadingTarget } from "../../lib/reading-reveal.ts";

export type ReaderThread = { thread: ThreadView; element: HTMLElement; range?: Range; start: number; length: number };
export type ThreadChip = { top: number; entries: ReaderThread[] };
export type PlacedThreads = Map<string, ThreadView[]>;

/** Build the ranges once for highlights, hit testing and line markers, including resolved jump targets. */
export function readerThreadRanges(root: HTMLElement, blocks: PlacedThreads, topics: PlacedThreads) {
  const entries: ReaderThread[] = [];
  const highlights: Map<string, Range>[] = [];
  for (const element of root.querySelectorAll<HTMLElement>("[data-block-id], [data-topic-slug][data-topic-part]")) {
    const part = element.dataset.topicPart;
    const placed =
      (part ? topics.get(element.dataset.topicSlug ?? "") : blocks.get(element.dataset.blockId ?? "")) ?? [];
    const local: ReaderThread[] = [];
    for (const thread of placed) {
      if (thread.placement.status !== "placed") continue;
      const location = thread.placement.location;
      if (part && (location.kind !== "topic" || (location.part ?? "title") !== part)) continue;
      const start = "start" in location ? location.start : undefined;
      const end = "end" in location ? location.end : undefined;
      const whole =
        location.kind === "topic"
          ? !location.part
          : "quote" in thread.target && thread.target.quote === element.dataset.blockText;
      local.push({
        thread,
        element,
        start: whole ? -1 : (start ?? -1),
        length: start !== undefined && end !== undefined ? end - start : Infinity,
      });
    }
    if (!local.length) continue;
    const ranges = new Map<string, Range>();
    try {
      const map = supportsCommentHighlights() ? mapBlockText(element) : undefined;
      for (const entry of local) {
        const location = entry.thread.placement;
        if (location.status !== "placed" || !("start" in location.location)) continue;
        const { start, end } = location.location;
        if (start === undefined || end === undefined) continue;
        entry.range = map?.(start, end);
        if (entry.range && entry.thread.state !== "resolved") ranges.set(entry.thread.id, entry.range);
      }
    } catch {
      // Mapping a block is atomic, matching highlight registration's failure boundary.
      ranges.clear();
      for (const entry of local) entry.range = undefined;
    }
    entries.push(...local.sort((a, b) => a.start - b.start));
    highlights.push(ranges);
  }
  return { entries, highlights };
}

/** Chips use the first line; popovers use the bounds of the lines visible in the reading area. */
export function passageRect(entry: ReaderThread, area?: { top: number; bottom: number }) {
  if (entry.element.closest("[hidden]")) return;
  for (let parent = entry.element.parentElement; parent; parent = parent.parentElement) {
    if (
      parent instanceof HTMLDetailsElement &&
      !parent.open &&
      !parent.querySelector("summary")?.contains(entry.element)
    )
      return;
  }
  const rects = [...(entry.range?.getClientRects() ?? entry.element.getClientRects())].filter(
    (rect) => rect.width > 0 && rect.height > 0,
  );
  if (!area || !rects.length) return rects[0];
  const visible = rects.filter((rect) => rect.bottom > area.top && rect.top < area.bottom);
  const anchor = visible.length ? visible : rects;
  const top = Math.min(...anchor.map((rect) => rect.top));
  const left = Math.min(...anchor.map((rect) => rect.left));
  return new DOMRect(
    left,
    top,
    Math.max(...anchor.map((rect) => rect.right)) - left,
    Math.max(...anchor.map((rect) => rect.bottom)) - top,
  );
}

/** Hidden passages use their visible fold heading when choosing a starting thread. */
export function passageTop(entry: ReaderThread) {
  const rect = passageRect(entry);
  if (rect) return rect.top;
  let anchor = entry.element;
  for (let parent: HTMLElement | null = entry.element; parent; parent = parent.parentElement) {
    if (parent.hasAttribute("hidden")) anchor = parent.closest<HTMLElement>("[data-reading-section]") ?? parent;
    if (parent instanceof HTMLDetailsElement && !parent.open) anchor = parent.querySelector("summary") ?? parent;
  }
  return anchor.getBoundingClientRect().top;
}

export function threadChips(entries: ReaderThread[], root: HTMLElement): ThreadChip[] {
  const top = root.getBoundingClientRect().top;
  const chips: ThreadChip[] = [];
  for (const entry of entries) {
    if (entry.thread.state === "resolved") continue;
    const rect = passageRect(entry);
    if (!rect) continue;
    const chip = chips.find(
      (chip) => chip.entries[0]?.element === entry.element && Math.abs(chip.top - (rect.top - top)) < 3,
    );
    if (chip) chip.entries.push(entry);
    else chips.push({ top: rect.top - top, entries: [entry] });
  }
  return chips;
}

export function threadAtPoint(
  entries: ReaderThread[],
  event: { target: EventTarget | null; clientX: number; clientY: number },
) {
  if (
    !(event.target instanceof Element) ||
    event.target.closest(
      'a, button, input, textarea, select, summary, span.emend-term, img, [role="button"], [contenteditable], [data-reading-thread-popover]',
    )
  )
    return;
  return entries
    .filter(
      (entry) =>
        entry.thread.state !== "resolved" &&
        passageRect(entry) &&
        entry.range &&
        [...entry.range.getClientRects()].some(
          (rect) =>
            event.clientX >= rect.left &&
            event.clientX <= rect.right &&
            event.clientY >= rect.top &&
            event.clientY <= rect.bottom,
        ),
    )
    .sort((a, b) => a.length - b.length)[0];
}

export function visibleReadingArea(root: HTMLElement) {
  const scroller = root.closest<HTMLElement>("[data-reading-scroll]");
  const rect = scroller?.getBoundingClientRect();
  return {
    top: Math.max(
      0,
      rect?.top ?? 0,
      scroller?.querySelector(".em-doc-bar")?.getBoundingClientRect().bottom ?? 0,
      scroller?.querySelector(".em-review-tabs")?.getBoundingClientRect().bottom ?? 0,
    ),
    bottom: Math.min(window.innerHeight, rect?.bottom ?? window.innerHeight),
    scroller,
  };
}

export function revealThread(entry: ReaderThread, root: HTMLElement) {
  // A range has no scrollIntoView. Reveal its block first, then adjust the scroller to the actual line.
  revealReadingTarget(entry.element);
  entry.element.scrollIntoView({ block: "nearest" });
  const rect = passageRect(entry);
  const area = visibleReadingArea(root);
  if (!rect || !area.scroller) return;
  if (rect.top < area.top) area.scroller.scrollTop += rect.top - area.top;
  else if (rect.bottom > area.bottom) area.scroller.scrollTop += rect.bottom - area.bottom;
}
