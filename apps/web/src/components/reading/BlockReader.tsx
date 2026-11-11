import type { RenderedBlock, RevisionView, Target, TopicMeta } from "@emend/contract";
import { TextSelect } from "lucide-react";
import { type ReactNode, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { mapBlockText } from "../../lib/block-ranges.ts";
import { registerCommentRanges, supportsCommentHighlights } from "../../lib/comment-highlights.ts";
import { claimDraft } from "../../lib/composer-owner.ts";
import { draftKey } from "../../lib/drafts.ts";
import { useLayout } from "../../lib/layout.ts";
import { revealReadingTarget } from "../../lib/reading-reveal.ts";
import { blockAnchor, selectionToAnchor } from "../../lib/selection.ts";
import { Composer } from "../threads/Composer.tsx";
import { ThreadCard } from "../threads/ThreadCard.tsx";
import { Button } from "../ui/Button.tsx";
import { useAgentNoteRefs } from "./agent-note-refs.ts";
import { Block } from "./Block.tsx";
import { BlockThreads, type ThreadJump } from "./BlockThreads.tsx";
import { Lightbox } from "./Lightbox.tsx";
import { ReadingGroup } from "./ReadingGroup.tsx";
import { type LightboxItem, useScreenshots } from "./screenshots.ts";

const emptyFiles: RevisionView["files"] = [];

export type ReaderProps = {
  reviewId: string;
  revision: number;
  changedBlocks: RevisionView["changedBlocks"];
  threads: RevisionView["threads"];
  topics?: RevisionView["topics"];
  resumedBlockId?: string;
  activeThreadId?: string;
  threadJump?: ThreadJump;
};
export type ReaderGroup = {
  key: string;
  id?: string;
  heading?: ReactNode;
  labelledBy?: string;
  blocks: RenderedBlock[];
  path?: string;
  content?: ReactNode;
  topic?: TopicMeta;
  rank?: number;
  commentCount?: number;
  presentation?: "tldr" | "decisions" | "glossary";
  action?: ReactNode;
  meta?: ReactNode;
  subsections?: { key: string; heading: string; kind: "why" | "example" | "body"; blocks: RenderedBlock[] }[];
};
function groupBlocks(group: ReaderGroup) {
  return [...group.blocks, ...(group.subsections?.flatMap((section) => section.blocks) ?? [])];
}
export function BlockReader({
  reviewId,
  revision,
  changedBlocks,
  threads,
  topics,
  groups,
  resumedBlockId,
  activeThreadId,
  threadJump,
  focus = false,
  files = emptyFiles,
  onNote,
}: ReaderProps & {
  groups: ReaderGroup[];
  focus?: boolean;
  files?: RevisionView["files"];
  onNote?: (id: string) => void;
}) {
  const headingBase = useId();
  const root = useRef<HTMLDivElement>(null);
  useAgentNoteRefs(root, groups, files, onNote);
  const selectionPrompt = useRef<HTMLDivElement>(null);
  const highlights = useRef<ReturnType<typeof registerCommentRanges>>(undefined);
  const opener = useRef<HTMLElement | null>(null);
  // A press on the prompt: the target latched at pointerdown, and until when selection changes are ignored
  // (Infinity while the pointer is down, then 600 ms past its release).
  const latched = useRef<Target | null>(null);
  const guardUntil = useRef(0);
  const mouseHeld = useRef(false);
  const [target, setTarget] = useState<Target | null>(null);
  const [composing, setComposing] = useState(false);
  const [error, setError] = useState("");
  const phone = useLayout() === "phone";
  const screenshotOpener = useRef<HTMLElement | null>(null);
  const { gallery, closeGallery } = useScreenshots(root, () => {
    latched.current = null;
    guardUntil.current = 0;
    if (!composing) setTarget(null);
    setError("");
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: A gallery's DOM snapshot belongs to one review revision.
  useLayoutEffect(() => closeGallery(), [reviewId, revision, closeGallery]);
  const openComposer = (next: Target, from?: HTMLElement) => {
    screenshotOpener.current = from ?? null;
    opener.current =
      from ??
      (document.activeElement instanceof HTMLElement && root.current?.contains(document.activeElement)
        ? document.activeElement
        : null);
    claimDraft(draftKey(reviewId, next), "reading");
    setTarget(next);
    setComposing(true);
    setError("");
  };
  const close = () => {
    latched.current = null;
    setComposing(false);
    setTarget(null);
    // On phones Sheet restores focus after its focus trap unmounts.
    if (!phone && screenshotOpener.current?.isConnected) screenshotOpener.current.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (!target) latched.current = null;
  }, [target]);
  const changes = new Map(changedBlocks.map((block) => [block.blockId, block.revision]));
  const targets = useMemo(
    () => new Map(groups.flatMap((group) => groupBlocks(group).map((block) => [block.id, group.path] as const))),
    [groups],
  );
  const screenshotBlocks = useMemo(
    () =>
      new Map(
        groups.flatMap((group) => groupBlocks(group).map((block) => [block.id, { block, path: group.path }] as const)),
      ),
    [groups],
  );
  const screenshotTarget = (item: LightboxItem): Target | undefined => {
    const entry = screenshotBlocks.get(item.blockId);
    if (!entry || entry.block.kind === "heading") return;
    const anchor = blockAnchor(entry.block);
    if (!anchor.quote) return;
    return entry.path === undefined
      ? { kind: "writeup-span", ...anchor }
      : { kind: "doc-span", path: entry.path, ...anchor };
  };
  const blockThreads = useMemo(() => {
    const byBlock = new Map<string, RevisionView["threads"]>();
    for (const thread of threads) {
      if (thread.placement.status !== "placed") continue;
      const location = thread.placement.location;
      if (!("blockId" in location) || !targets.has(location.blockId)) continue;
      const path = targets.get(location.blockId);
      if (
        path === undefined ? location.kind !== "writeup-span" : location.kind !== "doc-span" || location.path !== path
      )
        continue;
      const group = byBlock.get(location.blockId) ?? [];
      group.push(thread);
      byBlock.set(location.blockId, group);
    }
    return byBlock;
  }, [threads, targets]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A revision/review change retires ranges even if the cached blocks and threads are shared.
  useLayoutEffect(() => {
    if (!root.current || !supportsCommentHighlights()) return;
    const blocks: Map<string, Range>[] = [];
    for (const block of root.current.querySelectorAll<HTMLElement>("[data-block-id]")) {
      try {
        const placed = blockThreads.get(block.dataset.blockId ?? "");
        if (!placed) continue;
        const map = mapBlockText(block);
        if (!map) continue;
        const ranges = new Map<string, Range>();
        for (const thread of placed) {
          if (thread.state === "resolved" || thread.placement.status !== "placed") continue;
          const location = thread.placement.location;
          if (location.kind !== "writeup-span" && location.kind !== "doc-span") continue;
          const range = map(location.start, location.end);
          if (range) ranges.set(thread.id, range);
        }
        blocks.push(ranges);
      } catch {
        // A failed block contributes no ranges; the rest of the reader still works.
      }
    }
    const registration = registerCommentRanges(blocks);
    highlights.current = registration;
    return () => {
      registration?.unregister();
      highlights.current = undefined;
    };
  }, [blockThreads, revision, reviewId]);
  // Apply the current intent to new registrations too, without remapping text.
  useLayoutEffect(() => highlights.current?.setActiveThread(activeThreadId));
  useEffect(() => {
    const capture = (event?: Event) => {
      if (!root.current || composing) return;
      if (event?.target instanceof Node && selectionPrompt.current?.contains(event.target)) return;
      const selection = window.getSelection();
      if (!event) {
        // A settled selectionchange (touch selection, handle drag, shift-arrows). A press on the prompt may
        // collapse the selection first; the guard ignores that. A selection outside the reader retires the prompt.
        if (mouseHeld.current || Date.now() < guardUntil.current) return;
        if (
          selection &&
          !selection.isCollapsed &&
          !(root.current.contains(selection.anchorNode) && root.current.contains(selection.focusNode))
        ) {
          setTarget(null);
          setError("");
          return;
        }
      }
      if (!selection || selection.isCollapsed) {
        setTarget(null);
        setError("");
        return;
      }
      const anchor = selectionToAnchor(selection, root.current);
      if ("error" in anchor) {
        setTarget(null);
        setError(
          anchor.error === "cross-block"
            ? "Select text within one paragraph"
            : anchor.error === "too-long"
              ? "Select at most 2000 characters."
              : "",
        );
        return;
      }
      const path = targets.get(anchor.blockId);
      setTarget(path === undefined ? { kind: "writeup-span", ...anchor } : { kind: "doc-span", path, ...anchor });
      setError("");
    };
    const element = root.current;
    element?.addEventListener("mouseup", capture);
    element?.addEventListener("keyup", capture);
    let timer = 0;
    const onSelectionChange = () => {
      // The mouseup path handles mouse selections once the button is released.
      if (mouseHeld.current || Date.now() < guardUntil.current) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => capture(), 200);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === "mouse") mouseHeld.current = true;
    };
    const onPointerEnd = () => {
      mouseHeld.current = false;
      if (guardUntil.current === Number.POSITIVE_INFINITY) guardUntil.current = Date.now() + 600;
    };
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointerup", onPointerEnd, true);
    document.addEventListener("pointercancel", onPointerEnd, true);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointerup", onPointerEnd, true);
      document.removeEventListener("pointercancel", onPointerEnd, true);
      element?.removeEventListener("mouseup", capture);
      element?.removeEventListener("keyup", capture);
    };
  }, [composing, targets]);
  const renderBlocks = (blocks: RenderedBlock[], path?: string, decisions = false) =>
    blocks.map((block, index) => (
      <Block
        key={block.id}
        block={block}
        drift={decisions && /^drift:/i.test(block.text.trimStart())}
        changedIn={changes.get(block.id)}
        continuesChange={index > 0 && changes.get(blocks[index - 1]?.id ?? "") === changes.get(block.id)}
        commenting={
          resumedBlockId === block.id || (composing && !!target && "blockId" in target && target.blockId === block.id)
        }
        onComment={() => {
          const anchor = blockAnchor(block);
          if (!anchor.quote) return;
          openComposer(
            path === undefined ? { kind: "writeup-span", ...anchor } : { kind: "doc-span", path, ...anchor },
          );
        }}
      >
        <BlockThreads
          focus={focus}
          reviewId={reviewId}
          threads={blockThreads.get(block.id) ?? []}
          composing={
            resumedBlockId === block.id || (composing && !!target && "blockId" in target && target.blockId === block.id)
          }
          jump={threadJump}
        >
          {blockThreads.get(block.id)?.map((thread) => (
            <div key={thread.id} className="mt-2.5 mb-1.5">
              <ThreadCard
                reviewId={reviewId}
                revision={revision}
                thread={thread}
                changedBlocks={changedBlocks}
                topics={topics}
              />
            </div>
          ))}
        </BlockThreads>
        {composing && target && "blockId" in target && target.blockId === block.id && (
          <Composer
            reviewId={reviewId}
            revision={revision}
            target={target}
            topics={topics}
            onSaved={close}
            onCancel={close}
            returnFocus={() =>
              opener.current?.isConnected
                ? opener.current
                : (root.current?.closest<HTMLElement>("[data-reading-scroll]") ?? root.current)
            }
            wrap={(editor) => <div className="mt-3">{editor}</div>}
          />
        )}
      </Block>
    ));
  return (
    <div
      ref={root}
      tabIndex={-1}
      className={focus ? "em-reading-column em-focus-prose" : "em-reading-column pt-4 pb-8 md:pt-7 md:pb-[72px]"}
    >
      {groups.map((group, index) => (
        <ReadingGroup
          key={`${reviewId}:${revision}:${group.key}`}
          group={group}
          headingId={`${headingBase}-${index}`}
          changedIn={
            groupBlocks(group).reduce((latest, block) => Math.max(latest, changes.get(block.id) ?? 0), 0) || undefined
          }
        >
          {group.content}
          {renderBlocks(group.blocks, group.path, group.presentation === "decisions")}
          {group.subsections?.map((section) => (
            <div
              key={section.key}
              className={
                section.kind === "body" ? "em-writeup-details" : `em-writeup-callout em-writeup-${section.kind}`
              }
            >
              <h3 className={section.kind === "body" ? "sr-only" : "em-writeup-kicker"}>{section.heading}</h3>
              {renderBlocks(section.blocks, group.path)}
            </div>
          ))}
        </ReadingGroup>
      ))}
      {!composing && (error || target) && (
        <div
          ref={selectionPrompt}
          className="sticky bottom-0 space-y-3 rounded-lg border border-line-2 bg-raised p-3 shadow-2"
          // A non-selectable bar keeps a tap here from collapsing the text selection on iOS.
          style={{
            userSelect: "none",
            WebkitUserSelect: "none",
            WebkitTouchCallout: "none",
            touchAction: "manipulation",
          }}
        >
          {error && <p role="status">{error}</p>}
          {target && (
            <Button
              variant="primary"
              size="sm"
              icon={TextSelect}
              // Keep the selection and its native handles: a press here must not move focus or collapse it.
              onPointerDown={(event) => {
                event.preventDefault();
                latched.current = target;
                guardUntil.current = Number.POSITIVE_INFINITY;
              }}
              onClick={() => {
                const latch = Date.now() < guardUntil.current ? latched.current : null;
                latched.current = null;
                openComposer(latch ?? target);
              }}
            >
              Comment on selection
            </Button>
          )}
        </div>
      )}
      {gallery && (
        <Lightbox
          gallery={gallery}
          onClose={closeGallery}
          canComment={(item) => !!screenshotTarget(item)}
          onComment={(item) => {
            const next = screenshotTarget(item);
            if (next) {
              if (item.element.isConnected) revealReadingTarget(item.element);
              openComposer(next, item.element);
            }
          }}
        />
      )}
    </div>
  );
}
