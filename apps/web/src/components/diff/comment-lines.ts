import { LIMITS } from "@recense/contract";
import { createContext, useCallback, useContext, useLayoutEffect } from "react";
import { refreshCommentCards, trackCommentCard } from "../../lib/comment-highlights.ts";
import type { DiffPostRender } from "./FileDiff.tsx";

type Lines = { side: "deletions" | "additions"; start: number; end: number };
type Location = { kind: string; side?: string; start?: number; end?: number };

export function createCommentLines() {
  const active = new Map<HTMLElement, Lines>();
  const rows = {
    deletions: new Map<string, Element>(),
    additions: new Map<string, Element>(),
    unified: new Map<string, Element>(),
  };
  let marked = new Set<Element>();
  let instance: Parameters<DiffPostRender>[1] | undefined;
  const refresh = () => {
    if (!instance) return;
    const next = new Set<Element>();
    for (const { side, start, end } of active.values()) {
      for (let line = start; line <= end; line++) {
        // Unified context displays the new number even for an old-side comment.
        // Pierre maps either side to the row's numeric unified/split index pair.
        const pair = instance.getLineIndex(line, side);
        if (!pair?.every((index) => Number.isSafeInteger(index) && index >= 0)) continue;
        const index = pair.join(",");
        const row = rows[side].get(index) ?? rows.unified.get(index);
        if (row) next.add(row);
      }
    }
    for (const row of marked) if (!next.has(row)) row.removeAttribute("data-comment-active");
    for (const row of next) if (!marked.has(row)) row.setAttribute("data-comment-active", "");
    marked = next;
  };
  return {
    setActive(card: HTMLElement, lines: Lines | null) {
      if (lines) active.set(card, lines);
      else active.delete(card);
      refresh();
    },
    postRender: ((node, renderedInstance, phase) => {
      // Pierre can replace rows on expansion, layout changes and highlighting.
      // Only a render rebuilds the index; activity visits active lines and changed markers.
      for (const row of marked) row.removeAttribute("data-comment-active");
      marked.clear();
      for (const index of Object.values(rows)) index.clear();
      instance = phase !== "unmount" && node.shadowRoot ? renderedInstance : undefined;
      if (!instance) return;
      for (const row of node.shadowRoot?.querySelectorAll("[data-column-number][data-line-index]") ?? []) {
        const index = row.getAttribute("data-line-index") ?? "";
        const column = row.closest("[data-deletions], [data-additions], [data-unified]");
        if (column?.hasAttribute("data-deletions")) rows.deletions.set(index, row);
        else if (column?.hasAttribute("data-additions")) rows.additions.set(index, row);
        else if (column?.hasAttribute("data-unified")) rows.unified.set(index, row);
      }
      refresh();
    }) satisfies DiffPostRender,
  };
}

export const CommentLinesContext = createContext<ReturnType<typeof createCommentLines> | null>(null);

/** Share the writeup's pointer/focus tracking; no React update or dynamic CSS on hover. */
export function useCommentCard(threadId: string | null, location?: Location | null) {
  const lines = useContext(CommentLinesContext);
  const { kind, side, start, end } = location ?? {};
  useLayoutEffect(() => {
    // Unmounting a focused editor need not emit focusout. Reconcile its parent
    // after DOM removal, without doing global work on ordinary renders or typing.
    return () => queueMicrotask(refreshCommentCards);
  }, []);
  return useCallback(
    (card: HTMLElement | null) => {
      if (!card) return;
      const range: Lines | null =
        kind === "lines" &&
        (side === "old" || side === "new") &&
        start !== undefined &&
        end !== undefined &&
        Number.isSafeInteger(start) &&
        Number.isSafeInteger(end) &&
        start > 0 &&
        end >= start &&
        end - start < LIMITS.targetLines
          ? { side: side === "old" ? "deletions" : "additions", start, end }
          : null;
      return trackCommentCard(
        card,
        threadId,
        lines && range ? (active) => lines.setActive(card, active ? range : null) : undefined,
      );
    },
    [threadId, lines, kind, side, start, end],
  );
}
