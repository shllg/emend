import { type RefObject, useLayoutEffect, useState } from "react";
import { layoutStore, useLayoutPreferences } from "../../lib/layout-store.ts";
import { onReaderInput } from "../../lib/reader-input.ts";
import type { ParsedDiff } from "./FileDiff.tsx";

export type DiffStyle = "split" | "unified";
export type DiffCounts = { additions: number; deletions: number };

export function diffCounts(diff: ParsedDiff): DiffCounts {
  return diff.hunks.reduce(
    (total, hunk) => ({
      additions: total.additions + hunk.additionLines,
      deletions: total.deletions + hunk.deletionLines,
    }),
    { additions: 0, deletions: 0 },
  );
}

export function useDiffStyle() {
  const { diffStyle } = useLayoutPreferences();
  return [diffStyle, (next: DiffStyle) => layoutStore.update({ diffStyle: next })] as const;
}

export function useDiffWrap() {
  const { wrap } = useLayoutPreferences();
  return [wrap, (next: boolean) => layoutStore.update({ wrap: next })] as const;
}

export function useNarrowDiffPane(root: RefObject<HTMLElement | null>) {
  const [narrow, setNarrow] = useState<boolean | undefined>(() =>
    typeof ResizeObserver === "undefined" ? false : undefined,
  );
  useLayoutEffect(() => {
    const pane = root.current;
    if (!pane) return;
    if (typeof ResizeObserver === "undefined") {
      setNarrow(false);
      return;
    }
    // Use the same border-box width initially and on every resize notification.
    const measure = () => {
      const width = pane.getBoundingClientRect().width;
      // Hidden Tabs panes retain their last presentation until shown and measured again.
      if (width > 0) setNarrow(width < 760);
    };
    measure();
    const observer = new ResizeObserver((entries) => {
      if (entries.some((entry) => entry.target === pane)) measure();
    });
    observer.observe(pane);
    return () => observer.disconnect();
  }, [root]);
  return narrow;
}

function diffTargetOffset(target: HTMLElement, pane: HTMLElement): number {
  // A sticky file header no longer marks the file's start.
  const measured = target.hasAttribute("data-file-header") ? (target.closest("[data-diff-file]") ?? target) : target;
  return pane.scrollTop + measured.getBoundingClientRect().top - pane.getBoundingClientRect().top;
}

function diffStickyStack(target: HTMLElement, pane: HTMLElement): number {
  const toolbar = pane.querySelector("[data-diff-toolbar]");
  const section = target.closest("[data-topic]");
  // The phone topic header scrolls away with its section, so it takes no room in the stack.
  const topic = section?.hasAttribute("data-phone") ? null : section?.querySelector("[data-topic-header]");
  const file = target.closest("[data-diff-file]")?.querySelector("[data-file-header]");
  // A header, its contents, and its section are destinations unobstructed by that header.
  const height = (header: Element | null | undefined) =>
    header && !target.contains(header) && !header.contains(target) ? header.getBoundingClientRect().height : 0;
  return (toolbar?.getBoundingClientRect().height ?? 0) + height(topic) + height(file);
}

function diffTargetTop(target: HTMLElement, pane: HTMLElement, offset = diffTargetOffset(target, pane)): number {
  const destination = offset - pane.clientTop - diffStickyStack(target, pane) - 8;
  return Math.max(0, Math.min(destination, Math.max(0, pane.scrollHeight - pane.clientHeight)));
}

export function diffFoldSpot(header: HTMLElement): number | undefined {
  const pane = header.closest<HTMLElement>("[data-diff-scroll]");
  if (!pane) return;
  return Math.max(
    header.getBoundingClientRect().top - pane.getBoundingClientRect().top,
    pane.clientTop + diffStickyStack(header, pane),
  );
}

export function scrollDiffTarget(target: HTMLElement) {
  const pane = target.closest<HTMLElement>("[data-diff-scroll]");
  if (pane) pane.scrollTo({ top: diffTargetTop(target, pane), behavior: "instant" });
}

export const diffHoldQuietMs = 2000;
export const diffHoldMaxMs = 10000;
const diffHolds = new WeakMap<HTMLElement, () => void>();

export function holdDiffTarget(target: HTMLElement, at?: number): () => void {
  const pane = target.closest<HTMLElement>("[data-diff-scroll]");
  if (!pane) return () => {};
  diffHolds.get(pane)?.();
  const start = performance.now();
  let lastMoved = start;
  let height = pane.scrollHeight;
  let frame: number;
  const cancel = () => {
    cancelAnimationFrame(frame);
    stopInput();
    window.removeEventListener("keydown", onTab);
    if (diffHolds.get(pane) === cancel) diffHolds.delete(pane);
  };
  const onTab = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.key !== "Tab") return;
    const source = event.target;
    if (source instanceof Node && (source === document.body || pane.contains(source))) cancel();
  };
  const stopInput = onReaderInput(pane, cancel);
  window.addEventListener("keydown", onTab);
  diffHolds.set(pane, cancel);
  const destination = (offset = diffTargetOffset(target, pane)) =>
    at === undefined
      ? diffTargetTop(target, pane, offset)
      : Math.max(0, Math.min(offset - at, Math.max(0, pane.scrollHeight - pane.clientHeight)));
  pane.scrollTo({ top: destination(), behavior: "instant" });
  let lastScrollTop = pane.scrollTop;
  let lastOffset = diffTargetOffset(target, pane);
  const tick = () => {
    const now = performance.now();
    if (!target.isConnected || target.closest("[hidden]") || now - start >= diffHoldMaxMs) {
      cancel();
      return;
    }
    const offset = diffTargetOffset(target, pane);
    const shifted = Math.abs(offset - lastOffset) >= 1;
    // A scroll without a layout change belongs to the reader.
    if (Math.abs(pane.scrollTop - lastScrollTop) >= 1 && !shifted && height === pane.scrollHeight) {
      cancel();
      return;
    }
    const top = destination(offset);
    const moved = Math.abs(pane.scrollTop - top) >= 1;
    if (moved || shifted || height !== pane.scrollHeight || pane.querySelector("[data-diff-loading]")) lastMoved = now;
    height = pane.scrollHeight;
    if (moved) pane.scrollTo({ top, behavior: "instant" });
    lastScrollTop = pane.scrollTop;
    lastOffset = moved ? diffTargetOffset(target, pane) : offset;
    if (now - lastMoved >= diffHoldQuietMs) {
      cancel();
      return;
    }
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return cancel;
}
