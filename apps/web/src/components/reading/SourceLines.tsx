import type { RevisionView, SourceLinesTarget, SourceToken } from "@emend/contract";
import { type CSSProperties, memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ComposerVisibilityContext } from "../../lib/composer-owner.ts";
import { Composer } from "../threads/Composer.tsx";
import { ThreadCard } from "../threads/ThreadCard.tsx";
import type { ReaderProps } from "./BlockReader.tsx";
import { BlockThreads } from "./BlockThreads.tsx";
import { ThreadComposerContext } from "./ThreadComposerContext.ts";

// Plain rows have no subscriptions or thread components. Stable tokens and the select callback
// let memo skip every row whose selection/highlight did not change, even for very large docs.
const SourceLine = memo(function SourceLine({
  tokens,
  number,
  selected,
  commented,
  active,
}: {
  tokens: SourceToken[];
  number: number;
  selected: boolean;
  commented: boolean;
  active: boolean;
}) {
  return (
    <div
      className="em-source-line"
      data-source-line={number}
      data-selected={selected ? "" : undefined}
      data-commented={commented ? "" : undefined}
      data-active={active ? "" : undefined}
    >
      <button
        type="button"
        className="em-source-number"
        aria-label={`Comment on line ${number}`}
        aria-pressed={selected}
        data-source-number={number}
      >
        {number}
      </button>
      <code className="em-source-code">
        {tokens.map((token, index) => (
          // Tokens have no identity beyond their place within this immutable server row.
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: A source row is replaced as a whole on revision changes.
            key={index}
            style={
              token.light || token.dark
                ? ({ "--shiki-light": token.light, "--shiki-dark": token.dark } as CSSProperties)
                : undefined
            }
          >
            {token.text}
          </span>
        ))}
      </code>
    </div>
  );
});

// Unchanged chunks skip reconciliation too: a selection must not walk every row of a large file.
export const SourceLines = memo(function SourceLines({
  lines,
  start,
  selectionStart,
  selectionEnd,
  required,
  target,
  byEnd,
  marked,
  active,
  onClose,
  returnFocus,
  reviewId,
  revision,
  changedBlocks,
  topics,
  threadJump,
}: Omit<ReaderProps, "threads"> & {
  lines: SourceToken[][];
  start: number;
  required: boolean;
  selectionStart?: number;
  selectionEnd?: number;
  target: SourceLinesTarget | null;
  byEnd: Map<number, RevisionView["threads"]>;
  marked: Set<number>;
  active: Set<number>;
  onClose: () => void;
  returnFocus: () => HTMLElement | null;
}) {
  const root = useRef<HTMLDivElement>(null);
  const height = useRef<number | undefined>(undefined);
  const [near, setNear] = useState(start <= 400);
  const [manual, setManual] = useState(false);
  const [composers, setComposers] = useState(0);
  const [composerVisibility] = useState(() => new Map<string, boolean>());
  const registerComposer = useCallback(() => {
    setComposers((count) => count + 1);
    return () => setComposers((count) => count - 1);
  }, []);
  const needed = near || required || manual || composers > 0;
  const [mounted, setMounted] = useState(start <= 400);
  const hasThreads = lines.some((_, index) => byEnd.has(start + index));
  useLayoutEffect(() => {
    if (mounted === needed) return;
    // Keep the rows for this commit so the measurement includes discussion cards.
    // The next commit replaces them before paint, retaining their last actual height.
    if (!needed && hasThreads && root.current?.getClientRects().length) {
      const rect = root.current.getBoundingClientRect();
      if (Number.isFinite(rect.height) && rect.height > 0 && Number.isFinite(rect.width) && rect.width > 0)
        height.current = rect.height;
    }
    setMounted(needed);
  }, [mounted, needed, hasThreads]);
  useEffect(() => {
    if (!root.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) if (entry.target === root.current) setNear(entry.isIntersecting);
      },
      { rootMargin: "1200px 0px" },
    );
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  if (!mounted && !needed)
    return (
      <div
        ref={root}
        data-source-chunk={start}
        style={{
          height:
            hasThreads && height.current !== undefined
              ? height.current
              : `calc(${lines.length} * var(--source-line-height))`,
        }}
      >
        {typeof IntersectionObserver === "undefined" && (
          <button type="button" className="em-source-show" onClick={() => setManual(true)}>
            Show lines {start}–{start + lines.length - 1}
          </button>
        )}
      </div>
    );
  return (
    <div ref={root} data-source-chunk={start}>
      {lines.flatMap((tokens, index) => {
        const number = start + index;
        const placed = byEnd.get(number);
        const composing = target?.end === number;
        const row = (
          <SourceLine
            key={number}
            tokens={tokens}
            number={number}
            selected={
              selectionStart !== undefined && number >= selectionStart && number <= (selectionEnd ?? selectionStart)
            }
            commented={marked.has(number)}
            active={active.has(number)}
          />
        );
        if (!placed && !composing) return [row];
        return [
          row,
          <div key={`discussion-${number}`} className="em-source-discussion" data-source-end={number}>
            {placed && (
              <BlockThreads
                compact={false}
                reviewId={reviewId}
                threads={placed}
                composing={composing}
                jump={threadJump}
              >
                <ThreadComposerContext value={registerComposer}>
                  <ComposerVisibilityContext value={composerVisibility}>
                    {placed.map((thread) => (
                      <ThreadCard
                        key={thread.id}
                        reviewId={reviewId}
                        revision={revision}
                        thread={thread}
                        changedBlocks={changedBlocks}
                        topics={topics}
                      />
                    ))}
                  </ComposerVisibilityContext>
                </ThreadComposerContext>
              </BlockThreads>
            )}
            {composing && target && (
              <Composer
                surface="reading"
                reviewId={reviewId}
                revision={revision}
                target={target}
                topics={topics}
                onSaved={onClose}
                onCancel={onClose}
                returnFocus={returnFocus}
              />
            )}
          </div>,
        ];
      })}
    </div>
  );
});
