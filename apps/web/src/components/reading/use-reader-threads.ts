import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { registerCommentRanges } from "../../lib/comment-highlights.ts";
import { hasOpenOverlay } from "../../lib/shortcuts.ts";
import { useShortcut } from "../../lib/use-shortcut.tsx";
import type { ThreadJump } from "./BlockThreads.tsx";
import {
  type PlacedThreads,
  passageTop,
  type ReaderThread,
  readerThreadRanges,
  revealThread,
  type ThreadChip,
  threadAtPoint,
  threadChips,
  visibleReadingArea,
} from "./reader-thread-ranges.ts";

export function useReaderThreads({
  root,
  blockThreads,
  topicThreads,
  reviewId,
  revision,
  activeThreadId,
  threadJump,
  composing,
}: {
  root: RefObject<HTMLDivElement | null>;
  blockThreads: PlacedThreads;
  topicThreads: PlacedThreads;
  reviewId: string;
  revision: number;
  activeThreadId?: string;
  threadJump?: ThreadJump;
  composing: boolean;
}) {
  const [entries, setEntries] = useState<ReaderThread[]>([]);
  const [chips, setChips] = useState<ThreadChip[]>([]);
  const [openId, setOpenId] = useState<string>();
  const [handled, setHandled] = useState<object>();
  const registration = useRef<ReturnType<typeof registerCommentRanges>>(undefined);
  const chipsRef = useRef(new Map<string, HTMLButtonElement>());
  const popover = useRef<HTMLDivElement>(null);
  const pendingReveal = useRef<string | undefined>(undefined);
  const wasComposing = useRef(composing);
  const openEntry = entries.find((entry) => entry.thread.id === openId);
  // The route scrolls in the commit after delivering the intent. Mount the card in that commit.
  if (threadJump && threadJump.token !== handled && entries.some((entry) => entry.thread.id === threadJump.threadId)) {
    setHandled(threadJump.token);
    setOpenId(threadJump.threadId);
    pendingReveal.current = threadJump.threadId;
  }
  const measure = useCallback(() => {
    if (root.current) setChips(threadChips(entries, root.current));
  }, [entries, root]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A review/revision change retires even shared cached ranges.
  useLayoutEffect(() => {
    if (!root.current) return;
    const mapped = readerThreadRanges(root.current, blockThreads, topicThreads);
    setEntries(mapped.entries);
    const value = registerCommentRanges(mapped.highlights);
    registration.current = value;
    return () => {
      value?.unregister();
      registration.current = undefined;
    };
  }, [root, blockThreads, topicThreads, reviewId, revision]);
  useLayoutEffect(() => registration.current?.setActiveThread(activeThreadId, openId));
  useLayoutEffect(() => {
    if (!root.current) return;
    if (openEntry && pendingReveal.current === openEntry.thread.id) {
      revealThread(openEntry, root.current);
      pendingReveal.current = undefined;
    }
    measure();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(root.current);
    for (const entry of entries) observer?.observe(entry.element);
    // Folds keep their content mounted. hidden/open mutations also cover browser Find and glossary navigation.
    const folds = new MutationObserver(measure);
    folds.observe(root.current, { subtree: true, attributes: true, attributeFilter: ["hidden", "open"] });
    return () => {
      observer?.disconnect();
      folds.disconnect();
    };
  }, [root, entries, measure, openEntry]);
  useEffect(() => {
    if (composing && !wasComposing.current) setOpenId(undefined);
    wasComposing.current = composing;
  }, [composing]);
  useEffect(() => {
    if (openId && !entries.some((entry) => entry.thread.id === openId)) setOpenId(undefined);
  }, [entries, openId]);
  const returnFocus = () => chipsRef.current.get(openId ?? "") ?? root.current;
  const close = (restore = false) => {
    if (restore) returnFocus()?.focus({ preventScroll: true });
    setOpenId(undefined);
  };
  const open = useCallback(
    (entry: ReaderThread, reveal = false) => {
      if (reveal && root.current) revealThread(entry, root.current);
      setOpenId(entry.thread.id);
    },
    [root],
  );
  const ordered = entries.filter((entry) => entry.thread.state !== "resolved" || entry.thread.id === openId);
  const index = ordered.findIndex((entry) => entry.thread.id === openId);
  const step = (direction: -1 | 1) => {
    if (!root.current || !ordered.length) return false;
    const top = visibleReadingArea(root.current).top;
    const next =
      index >= 0
        ? ordered[index + direction]
        : direction === 1
          ? (ordered.find((entry) => passageTop(entry) >= top) ?? ordered[0])
          : (ordered.findLast((entry) => passageTop(entry) < top) ?? ordered.at(-1));
    if (next) open(next, true);
    return true;
  };
  const when = () => !!root.current && !root.current.closest("[hidden]") && root.current.getClientRects().length > 0;
  useShortcut("thread.next", () => step(1), { enabled: ordered.length > 0, when });
  useShortcut("thread.previous", () => step(-1), { enabled: ordered.length > 0, when });
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const click = (event: MouseEvent) => {
      if (window.getSelection()?.isCollapsed === false) return;
      const entry = threadAtPoint(entries, event);
      if (entry) open(entry);
    };
    let frame = 0;
    let latest: PointerEvent;
    const move = (event: PointerEvent) => {
      latest = event;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        element.style.cursor = threadAtPoint(entries, latest) ? "pointer" : "";
      });
    };
    const leave = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      element.style.cursor = "";
    };
    element.addEventListener("click", click);
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerleave", leave);
    return () => {
      leave();
      element.removeEventListener("click", click);
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerleave", leave);
    };
  }, [entries, root, open]);
  useEffect(() => {
    if (!openId) return;
    const outside = (event: PointerEvent) => {
      if (
        !(event.target instanceof Element) ||
        event.target.closest('[role="dialog"], [role="alertdialog"], [role="menu"]')
      )
        return;
      if (
        root.current?.contains(event.target) &&
        (event.target.closest("[data-thread-chip]") || threadAtPoint(entries, event))
      )
        return;
      setOpenId(undefined);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || !popover.current || hasOpenOverlay()) return;
      event.preventDefault();
      (chipsRef.current.get(openId) ?? root.current)?.focus({ preventScroll: true });
      setOpenId(undefined);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", onEscape);
    };
  }, [openId, entries, root]);
  return { entries, chips, chipsRef, openEntry, popover, open, close, returnFocus, index, total: ordered.length, step };
}
