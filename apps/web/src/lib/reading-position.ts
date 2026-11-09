import { z } from "@emend/contract/browser";
import { appElementId, docHeading, type HeadingDoc } from "./doc-navigation.ts";

export const readingKey = "emend.reading.v1";
export const readingCap = 200;
export type ReadingAnchor = { id: string; fraction: number; gap?: number };
type Entry = ReadingAnchor & { at: number };

const entrySchema = z.object({
  id: z
    .string()
    .min(1)
    .max(600)
    .regex(/^(?:block-|thread-|h-|html-doc-).+/),
  fraction: z.number().min(0).max(1),
  gap: z.number().min(0).max(1).optional(),
  at: z.number().finite(),
});
const storeSchema = z.record(z.string(), z.unknown());

export function readingPositionKey(
  reviewId: string,
  tab: string,
  doc = "",
  revision?: number,
  view: "reading" | "original" | "source" = "reading",
) {
  return [reviewId, tab, doc, ...(tab === "docs" && revision !== undefined ? [revision, view] : [])].join("\n");
}

// Storage may be missing, full or hold anything; every failure leaves the reader at the top.
function readAll(): Map<string, Entry> {
  try {
    const parsed = storeSchema.safeParse(JSON.parse(localStorage.getItem(readingKey) ?? "{}"));
    if (!parsed.success) return new Map();
    const entries = new Map<string, Entry>();
    for (const [key, value] of Object.entries(parsed.data)) {
      const entry = entrySchema.safeParse(value);
      if (entry.success) entries.set(key, entry.data);
    }
    return entries;
  } catch {
    return new Map();
  }
}

export function loadReadingPosition(key: string): ReadingAnchor | undefined {
  const entry = readAll().get(key);
  return entry
    ? { id: entry.id, fraction: entry.fraction, ...(entry.gap === undefined ? {} : { gap: entry.gap }) }
    : undefined;
}

/** Saves the anchor, or forgets the key when `anchor` is null (the reader is at the top). */
export function saveReadingPosition(key: string, anchor: ReadingAnchor | null, now = Date.now()) {
  try {
    const entries = readAll();
    if (anchor) {
      const parsed = entrySchema.safeParse({
        id: anchor.id,
        fraction: Math.min(1, Math.max(0, anchor.fraction)),
        ...(anchor.gap === undefined ? {} : { gap: Math.min(1, Math.max(0, anchor.gap)) }),
        at: now,
      });
      if (!parsed.success) return;
      entries.set(key, parsed.data);
    } else entries.delete(key);
    const kept = [...entries].sort((a, b) => b[1].at - a[1].at).slice(0, readingCap);
    localStorage.setItem(readingKey, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Reading still works without a remembered position.
  }
}

const hidden = (rect: DOMRect) => rect.width === 0 && rect.height === 0;
const readingTop = (scroller: HTMLElement) =>
  Math.max(
    scroller.getBoundingClientRect().top,
    scroller.querySelector(".em-doc-bar")?.getBoundingClientRect().bottom ?? 0,
    scroller.querySelector(".em-review-tabs")?.getBoundingClientRect().bottom ?? 0,
  );

/**
 * The first anchorable element whose bottom is below the scroller's top edge. Anchors are in document order,
 * so a binary search reads O(log n) rects. An element with an all-zero rect (display: none, a collapsed fold)
 * is never an anchor. Anchors never nest: BlockView renders a leaf div (ids inside block HTML get the
 * user-content- prefix), thread cards are siblings of their block, and an HTML doc holds only its frame.
 */
export function findAnchor(scroller: HTMLElement, selector: string): ReadingAnchor | null {
  if (scroller.scrollTop <= 0) return null;
  const top = readingTop(scroller);
  const list = Array.from(scroller.querySelectorAll<HTMLElement>(selector));
  const at = (index: number) => list[index] as HTMLElement;
  let found: { index: number; rect: DOMRect } | undefined;
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    let index = mid;
    let rect = at(index).getBoundingClientRect();
    while (hidden(rect) && ++index < hi) rect = at(index).getBoundingClientRect();
    if (index >= hi) {
      hi = mid;
    } else if (rect.bottom > top) {
      found = { index, rect };
      hi = mid;
    } else {
      lo = index + 1;
    }
  }
  if (found) {
    if (found.rect.top > top) {
      for (let index = found.index - 1; index >= 0; index--) {
        const rect = at(index).getBoundingClientRect();
        if (hidden(rect)) continue;
        const span = found.rect.top - rect.bottom;
        return {
          id: at(index).id,
          fraction: 1,
          gap: span > 0 ? Math.min(1, Math.max(0, (top - rect.bottom) / span)) : 0,
        };
      }
    }
    const fraction = found.rect.height > 0 ? (top - found.rect.top) / found.rect.height : 0;
    return { id: at(found.index).id, fraction: Math.min(1, Math.max(0, fraction)) };
  }
  // Scrolled past every anchor: the last one that is shown.
  for (let index = list.length - 1; index >= 0; index--)
    if (!hidden(at(index).getBoundingClientRect())) return { id: at(index).id, fraction: 1 };
  return null;
}

/** Scrolls so the anchor sits at the scroller's top. Returns the new scrollTop, or undefined when the element is gone. */
export function applyAnchor(
  scroller: HTMLElement,
  anchor: ReadingAnchor,
  doc?: HeadingDoc,
  selector?: string,
): number | undefined {
  const element = anchor.id.startsWith("h-")
    ? doc && docHeading(scroller, doc, anchor.id.slice(2))
    : appElementId(anchor.id)
      ? document.getElementById(anchor.id)
      : undefined;
  if (!element || !scroller.contains(element)) return undefined;
  const rect = element.getBoundingClientRect();
  let line = rect.top + anchor.fraction * rect.height;
  if (anchor.gap !== undefined) {
    line = rect.bottom;
    const list = selector ? Array.from(scroller.querySelectorAll<HTMLElement>(selector)) : [];
    const index = list.indexOf(element);
    if (index !== -1) {
      for (const next of list.slice(index + 1)) {
        const nextRect = next.getBoundingClientRect();
        if (hidden(nextRect)) continue;
        line += anchor.gap * (nextRect.top - rect.bottom);
        break;
      }
    }
  }
  const delta = line - readingTop(scroller);
  if (Math.abs(delta) >= 1) scroller.scrollTop += delta;
  return scroller.scrollTop;
}
