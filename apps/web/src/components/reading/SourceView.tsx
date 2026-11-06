import type { RevisionView, SourceLinesTarget } from "@emend/contract";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import { claimDraft } from "../../lib/composer-owner.ts";
import { draftKey } from "../../lib/drafts.ts";
import { linesErrorMessage } from "../../lib/line-context.ts";
import type { ReaderProps } from "./BlockReader.tsx";
import { SourceLines } from "./SourceLines.tsx";
import { sourceLinesTarget } from "./sourceLinesTarget.ts";

type SourceDoc = Extract<RevisionView["docs"][number], { kind: "source" }>;

export const SourceView = memo(function SourceView({
  doc,
  reviewId,
  revision,
  threads,
  changedBlocks,
  topics,
  activeThreadId,
  threadJump,
}: ReaderProps & { doc: SourceDoc }) {
  const root = useRef<HTMLDivElement>(null);
  const anchor = useRef<number | undefined>(undefined);
  const opener = useRef<HTMLButtonElement | null>(null);
  const [target, setTarget] = useState<SourceLinesTarget | null>(null);
  const [error, setError] = useState("");
  const texts = useMemo(() => doc.lines.map((line) => line.map((token) => token.text).join("")), [doc.lines]);
  const chunks = useMemo(() => {
    const chunks = [];
    for (let offset = 0; offset < doc.lines.length; offset += 200)
      chunks.push({ start: offset + 1, lines: doc.lines.slice(offset, offset + 200) });
    return chunks;
  }, [doc.lines]);
  const { byEnd, marked, active, requiredChunks } = useMemo(() => {
    const byEnd = new Map<number, RevisionView["threads"]>();
    const marked = new Set<number>();
    const active = new Set<number>();
    const requiredChunks = new Set<number>();
    for (const thread of threads) {
      if (thread.placement.status !== "placed") continue;
      const location = thread.placement.location;
      if (location.kind !== "source-lines" || location.path !== doc.path || location.end > texts.length) continue;
      const group = byEnd.get(location.end) ?? [];
      group.push(thread);
      byEnd.set(location.end, group);
      for (let line = location.start; line <= location.end; line++) {
        marked.add(line);
        if (thread.id === activeThreadId || thread.id === threadJump?.threadId)
          requiredChunks.add(Math.floor((line - 1) / 200) * 200 + 1);
        if (thread.id === activeThreadId) active.add(line);
      }
    }
    return { byEnd, marked, active, requiredChunks };
  }, [threads, doc.path, texts.length, activeThreadId, threadJump?.threadId]);
  const select = useCallback(
    (line: number, extend: boolean, button: HTMLButtonElement) => {
      if (!extend || anchor.current === undefined) anchor.current = line;
      opener.current = button;
      const next = sourceLinesTarget(doc.path, texts, Math.min(anchor.current, line), Math.max(anchor.current, line));
      if ("error" in next) {
        setTarget(null);
        setError(linesErrorMessage(next.error));
        return;
      }
      claimDraft(draftKey(reviewId, next), "reading");
      setTarget(next);
      setError("");
    },
    [doc.path, texts, reviewId],
  );
  const close = useCallback(() => {
    setTarget(null);
    anchor.current = undefined;
  }, []);
  const returnFocus = useCallback(() => (opener.current?.isConnected ? opener.current : root.current), []);
  return (
    <div ref={root} id={`source-doc-${doc.path}`} className="em-source" tabIndex={-1}>
      {error && (
        <p role="alert" className="p-3">
          {error}
        </p>
      )}
      {!doc.lines.length && (
        <p className="p-3">{doc.unrendered ? "This file could not be shown." : "This file is empty."}</p>
      )}
      <div
        className="em-source-scroll"
        onClickCapture={(event) => {
          const button =
            event.target instanceof Element
              ? event.target.closest<HTMLButtonElement>("button[data-source-number]")
              : null;
          if (button) select(Number(button.dataset.sourceNumber), event.shiftKey, button);
        }}
      >
        {chunks.map(({ start, lines }) => {
          const end = start + lines.length - 1;
          const selected = target && target.start <= end && target.end >= start;
          return (
            <SourceLines
              key={start}
              lines={lines}
              start={start}
              required={!!selected || requiredChunks.has(start)}
              selectionStart={selected ? Math.max(start, target.start) : undefined}
              selectionEnd={selected ? Math.min(end, target.end) : undefined}
              target={target && target.end >= start && target.end <= end ? target : null}
              byEnd={byEnd}
              marked={marked}
              active={active}
              onClose={close}
              returnFocus={returnFocus}
              reviewId={reviewId}
              revision={revision}
              changedBlocks={changedBlocks}
              topics={topics}
              threadJump={threadJump}
            />
          );
        })}
      </div>
    </div>
  );
});
