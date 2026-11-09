import { useLayoutEffect, useRef } from "react";
import { appElementId, docHeading, type HeadingDoc } from "./doc-navigation.ts";
import { onReaderInput } from "./reader-input.ts";
import { focusReadingTarget, isReadingFocusMove } from "./reading-focus.ts";
import {
  applyAnchor,
  findAnchor,
  loadReadingPosition,
  type ReadingAnchor,
  saveReadingPosition,
} from "./reading-position.ts";
import type { ReadingEntry } from "./use-reading-trail.ts";

export const restoreDelays = [0, 100, 300, 800, 1500] as const;
const saveInterval = 250;
const captureEvent = "emend:capture-reading-position";

/** The route calls this after a completed jump, while the destination's DOM is mounted. */
export function captureReadingPosition() {
  document.querySelector<HTMLElement>("[data-reading-scroll]")?.dispatchEvent(new Event(captureEvent));
}

const lastVisits = new WeakMap<Element, { key: string; entry?: ReadingEntry }>();
const filesPositions = new Map<string, number>();

export function useFilesPosition({ storageKey, active }: { storageKey: string; active: boolean }) {
  useLayoutEffect(() => {
    if (!active) return;
    const scroller = document.querySelector<HTMLElement>("[data-reading-scroll]");
    if (!scroller) return;
    scroller.scrollTop = filesPositions.get(storageKey) ?? 0;
    lastVisits.set(scroller, { key: storageKey });
    let reader = false;
    const stopInput = onReaderInput(scroller, () => {
      reader = true;
    });
    const onScroll = () => {
      if (reader) filesPositions.set(storageKey, scroller.scrollTop);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      stopInput();
      scroller.removeEventListener("scroll", onScroll);
    };
  }, [active, storageKey]);
}

/** What the route knows about navigation intents that scroll (a link, a thread jump, a Resume). */
export type IntentState = {
  /** The current navigation created a scrolling intent. A hash left over from an earlier one does not count. */
  current: boolean;
  /** Counts scrolling intents ever created, so one that came and went while retries ran still stops them. */
  epoch: number;
};

/**
 * Remembers where the reader is in the reading scroller and puts them back after a mount.
 * The scroller is shared by every reading tab, so this lives in the tab content.
 *
 * Rules:
 * - Reader scrolling, focus and completed jumps save the live pane. A scroll event counts after reader input since
 *   this hook started for its key. Clamping, scroll anchoring and restore retries are programmatic
 *   and neither save nor stop a restore.
 * - Reader input stops the retries at once.
 * - Navigation wins: no restore when the current navigation has a scrolling intent, and the retries stop for
 *   good when a new one appears. A stale hash or an intent that was never fulfilled does not block.
 * - The reader's last anchor is kept in memory and written when the key changes, the pane hides or the tab
 *   unmounts, so nothing depends on measuring the old content late.
 */
export function useReadingPosition({
  storageKey,
  selector,
  active,
  intentState,
  entry,
  doc,
  preserve = false,
}: {
  storageKey: string;
  selector: string;
  active: boolean;
  intentState: () => IntentState;
  entry?: ReadingEntry;
  doc?: HeadingDoc;
  /** A diff-only navigation leaves the mounted reading pane in place. */
  preserve?: boolean;
}) {
  const latestDoc = useRef(doc);
  latestDoc.current = doc;
  const latestIntentState = useRef(intentState);
  latestIntentState.current = intentState;
  useLayoutEffect(() => {
    if (!active) return;
    const scroller = document.querySelector<HTMLElement>("[data-reading-scroll]");
    if (!scroller) return;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const startEpoch = latestIntentState.current().epoch;
    // The scroller outlives every tab and doc, so it remembers which content it last showed.
    const lastVisit = lastVisits.get(scroller);
    const keyChanged = lastVisit !== undefined && lastVisit.key !== storageKey;
    const entryChanged = lastVisit !== undefined && lastVisit.entry !== entry;
    const keepOffset = preserve && entryChanged && lastVisit?.key === storageKey;
    lastVisits.set(scroller, { key: storageKey, entry });
    let restoring = false;
    let reader = false;
    let dirty = false;
    let latest: ReadingAnchor | null = null;
    let throttle: ReturnType<typeof setTimeout> | undefined;
    const stopRestore = () => {
      restoring = false;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    };
    const write = () => {
      if (!dirty) return;
      dirty = false;
      saveReadingPosition(storageKey, latest);
    };
    const capture = () => {
      latest = findAnchor(scroller, selector);
      entry?.positions.set(storageKey, latest);
      dirty = true;
    };
    const onJump = () => {
      stopRestore();
      capture();
      write();
    };
    const onScroll = () => {
      if (!reader) return;
      capture();
      if (throttle === undefined) {
        write();
        throttle = setTimeout(() => {
          throttle = undefined;
          write();
        }, saveInterval);
      }
    };
    const onInput = () => {
      reader = true;
      stopRestore();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") write();
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    scroller.addEventListener(captureEvent, onJump);
    const stopInput = onReaderInput(scroller, onInput);
    window.addEventListener("pagehide", write);
    document.addEventListener("visibilitychange", onVisibility);

    const saved = keepOffset
      ? undefined
      : entry?.positions.has(storageKey)
        ? entry.positions.get(storageKey)
        : loadReadingPosition(storageKey);
    // Entry snapshots describe the live pane, never a storage value awaiting a restore.
    if (keepOffset) onJump();
    restoring = !keepOffset;
    const attempt = (first: boolean) => {
      if (!restoring) return;
      const state = latestIntentState.current();
      if (state.current || state.epoch !== startEpoch) {
        stopRestore();
        return;
      }
      const placed = saved ? applyAnchor(scroller, saved, latestDoc.current, selector) : undefined;
      // Another doc in the same scroller must not inherit the previous doc's offset: take the anchor or the top.
      // A different entry can explicitly restore top even on the same key. A remount keeps the live offset.
      if (first && placed === undefined && (keyChanged || (entryChanged && saved !== undefined)))
        scroller.scrollTop = 0;
      // A present null is an explicit top snapshot. A pending intent never reaches this point.
      entry?.positions.set(storageKey, findAnchor(scroller, selector));
      if (first && entry?.focus) {
        const focus = entry.focus;
        const heading =
          focus.id.startsWith("h-") && latestDoc.current
            ? docHeading(scroller, latestDoc.current, focus.id.slice(2))
            : undefined;
        if (heading) heading.tabIndex = -1;
        let element = heading ?? (appElementId(focus.id) ? document.getElementById(focus.id) : undefined);
        for (const index of focus.children) element = element?.children[index] as HTMLElement | undefined;
        if (element && scroller.contains(element)) focusReadingTarget(element);
      }
    };
    // Set the initial position in the commit, before doc-bar navigation moves focus.
    // The route's intent state includes new navigations even before its passive effect runs.
    if (!keepOffset) attempt(true);
    if (restoring)
      restoreDelays.slice(1).forEach((delay, index) => {
        const timer = setTimeout(() => {
          timers.delete(timer);
          if (saved) attempt(false);
          if (index === restoreDelays.length - 2) stopRestore();
        }, delay);
        timers.add(timer);
      });
    const rememberFocus = () => {
      if (
        isReadingFocusMove(document.activeElement) ||
        !(document.activeElement instanceof HTMLElement) ||
        !scroller.contains(document.activeElement)
      )
        return;
      onInput();
      onScroll();
      if (!entry) return;
      const active = document.activeElement;
      const appRoot = active.closest<HTMLElement>('[id^="block-"], [id^="thread-"], [id^="topic-"]');
      const heading =
        latestDoc.current && docHeading(scroller, latestDoc.current, active.id) === active ? active : undefined;
      const root = heading ?? (appRoot && appElementId(appRoot.id) && scroller.contains(appRoot) ? appRoot : undefined);
      if (!root) {
        entry.focus = undefined;
        return;
      }
      const children: number[] = [];
      for (let child: Element = active; child !== root && child.parentElement; child = child.parentElement)
        children.unshift(Array.from(child.parentElement.children).indexOf(child));
      entry.focus = { id: heading ? `h-${heading.id}` : root.id, children };
    };
    scroller.addEventListener("focusin", rememberFocus);
    return () => {
      write();
      scroller.removeEventListener("focusin", rememberFocus);
      stopRestore();
      clearTimeout(throttle);
      scroller.removeEventListener("scroll", onScroll);
      scroller.removeEventListener(captureEvent, onJump);
      stopInput();
      window.removeEventListener("pagehide", write);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active, storageKey, selector, entry, preserve]);
}
