import type { NeedsYouKind, RenderedBlock, RevisionView, Target, TopicMeta } from "@emend/contract";
import { TextSelect } from "lucide-react";
import { type ReactNode, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { claimDraft } from "../../lib/composer-owner.ts";
import { draftKey } from "../../lib/drafts.ts";
import { useLayout } from "../../lib/layout.ts";
import { useReadOnlyReview } from "../../lib/read-only-review.ts";
import { revealReadingTarget } from "../../lib/reading-reveal.ts";
import { blockAnchor, selectionToAnchor } from "../../lib/selection.ts";
import { Composer } from "../threads/Composer.tsx";
import { Button } from "../ui/Button.tsx";
import { useAgentNoteRefs } from "./agent-note-refs.ts";
import { Block } from "./Block.tsx";
import type { ThreadJump } from "./BlockThreads.tsx";
import { Lightbox } from "./Lightbox.tsx";
import { ReadingGroup } from "./ReadingGroup.tsx";
import { ReadingThreads } from "./ReadingThreads.tsx";
import { type LightboxItem, useScreenshots } from "./screenshots.ts";
import { useReaderThreads } from "./use-reader-threads.ts";
import { WriteupDetails } from "./WriteupDetails.tsx";

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
export type ReaderFact = {
  key: string;
  label: string;
  blocks?: RenderedBlock[];
  content?: ReactNode;
  hideLabel?: boolean;
  fold?: { key: string; summary: string };
};
export type ReaderGroup = {
  key: string;
  id?: string;
  heading?: ReactNode;
  labelledBy?: string;
  blocks: RenderedBlock[];
  /** The Markdown doc's TL;DR section, including its heading and excluding the next section. */
  tldr?: { start: number; end: number };
  path?: string;
  content?: ReactNode;
  topic?: TopicMeta;
  rank?: number;
  commentCount?: number;
  presentation?:
    | "tldr"
    | "newInRevision"
    | "needsYou"
    | "decisions"
    | "glossary"
    | "outOfScope"
    | "whereToLook"
    | "context"
    | "facts"
    | "pair";
  news?: { key: string; blocks: RenderedBlock[]; jump?: ReactNode }[];
  needs?: { key: string; kind: NeedsYouKind; label: string; blocks: RenderedBlock[]; jump?: ReactNode }[];
  action?: ReactNode;
  meta?: ReactNode;
  files?: ReactNode;
  factGroups?: { key: string; label: string; facts: ReaderFact[] }[];
  subsections?: {
    key: string;
    heading: string;
    kind: "why" | "example" | "body" | "matters";
    blocks: RenderedBlock[];
  }[];
};
export function groupBlocks(group: ReaderGroup) {
  return [
    ...group.blocks,
    ...(group.news?.flatMap((item) => item.blocks) ?? []),
    ...(group.needs?.flatMap((item) => item.blocks) ?? []),
    ...(group.subsections?.flatMap((section) => section.blocks) ?? []),
    ...(group.factGroups?.flatMap((factGroup) => factGroup.facts.flatMap((fact) => fact.blocks ?? [])) ?? []),
  ];
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
  files = emptyFiles,
  onNote,
  lead,
}: ReaderProps & {
  groups: ReaderGroup[];
  lead?: ReactNode;
  files?: RevisionView["files"];
  onNote?: (id: string) => void;
}) {
  const readOnly = useReadOnlyReview();
  const headingBase = useId();
  const root = useRef<HTMLDivElement>(null);
  useAgentNoteRefs(root, groups, files, onNote);
  const selectionPrompt = useRef<HTMLDivElement>(null);
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
  const screenshotBlocks = useMemo(
    () =>
      new Map(
        groups.flatMap((group) => groupBlocks(group).map((block) => [block.id, { block, path: group.path }] as const)),
      ),
    [groups],
  );
  const { gallery, closeGallery } = useScreenshots(
    root,
    () => {
      latched.current = null;
      guardUntil.current = 0;
      if (!composing) setTarget(null);
      setError("");
    },
    (blockId) => {
      const block = screenshotBlocks.get(blockId)?.block;
      return block?.kind === "diagram" ? (block.source ?? block.text) : undefined;
    },
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: A gallery's DOM snapshot belongs to one review revision.
  useLayoutEffect(() => closeGallery(), [reviewId, revision, closeGallery]);
  const openComposer = (next: Target, from?: HTMLElement) => {
    if (readOnly) return;
    readingThreads.close();
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
  const latestChange = (blocks: RenderedBlock[]) =>
    blocks.reduce((latest, block) => Math.max(latest, changes.get(block.id) ?? 0), 0) || undefined;
  const targets = useMemo(
    () => new Map(groups.flatMap((group) => groupBlocks(group).map((block) => [block.id, group.path] as const))),
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
  const topicThreads = useMemo(() => {
    const byTopic = new Map<string, RevisionView["threads"]>();
    for (const thread of threads) {
      if (thread.placement.status !== "placed" || thread.placement.location.kind !== "topic") continue;
      const slug = thread.placement.location.slug;
      const placed = byTopic.get(slug) ?? [];
      placed.push(thread);
      byTopic.set(slug, placed);
    }
    return byTopic;
  }, [threads]);
  const readingThreads = useReaderThreads({
    root,
    blockThreads,
    topicThreads,
    reviewId,
    revision,
    activeThreadId,
    threadJump,
    composing: composing || !!resumedBlockId,
  });
  useEffect(() => {
    const capture = (event?: Event) => {
      if (readOnly || !root.current || composing) return;
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
      if ("slug" in anchor) setTarget({ kind: "topic", ...anchor });
      else {
        const path = targets.get(anchor.blockId);
        setTarget(path === undefined ? { kind: "writeup-span", ...anchor } : { kind: "doc-span", path, ...anchor });
      }
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
  }, [readOnly, composing, targets]);
  const composer = !readOnly && composing && target && (
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
  );
  const renderBlocks = (blocks: RenderedBlock[], path?: string, presentation?: ReaderGroup["presentation"]) =>
    blocks.map((block, index) => (
      <Block
        key={block.id}
        block={block}
        drift={presentation === "decisions" && /^drift:/i.test(block.text.trimStart())}
        changedIn={presentation === "newInRevision" ? undefined : changes.get(block.id)}
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
        {target && "blockId" in target && target.blockId === block.id && composer}
      </Block>
    ));
  const renderNews = (news: NonNullable<ReaderGroup["news"]>, path?: string) => (
    <ul className="em-revision-news">
      {news.map(({ key, blocks, jump }) => (
        <li key={key}>
          {renderBlocks(blocks, path, "newInRevision")}
          {jump}
        </li>
      ))}
    </ul>
  );
  return (
    <div ref={root} tabIndex={-1} className="em-reading-column pt-4 pb-8 md:pt-7 md:pb-[72px]">
      {lead}
      {groups.map((group, index) => (
        <ReadingGroup
          key={`${reviewId}:${revision}:${group.key}`}
          group={group}
          headingId={`${headingBase}-${index}`}
          changedIn={group.presentation === "newInRevision" ? undefined : latestChange(groupBlocks(group))}
          onCommentTopic={(slug, from) => openComposer({ kind: "topic", slug }, from)}
          discussion={group.topic && target?.kind === "topic" && target.slug === group.topic.slug && composer}
        >
          {group.content}
          {group.news && (
            <>
              {renderNews(group.news.slice(0, 4), group.path)}
              {group.news.length > 4 && (
                <WriteupDetails
                  reviewId={reviewId}
                  revision={revision}
                  sectionKey="newInRevision-more"
                  summary={`and ${group.news.length - 4} more`}
                >
                  {renderNews(group.news.slice(4), group.path)}
                </WriteupDetails>
              )}
            </>
          )}
          {group.needs && (
            <dl className="em-writeup-facts em-needs-you">
              {group.needs.map(({ key, kind, label, blocks, jump }) => (
                <div key={key} className="em-writeup-fact" data-needs-kind={kind}>
                  <dt>{label}</dt>
                  <dd>
                    {renderBlocks(blocks, group.path)}
                    {jump}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          {group.tldr ? (
            <>
              {renderBlocks(group.blocks.slice(0, group.tldr.start), group.path)}
              <div className="em-writeup-card em-doc-tldr">
                {renderBlocks(group.blocks.slice(group.tldr.start, group.tldr.end), group.path)}
              </div>
              {renderBlocks(group.blocks.slice(group.tldr.end), group.path)}
            </>
          ) : (
            renderBlocks(group.blocks, group.path, group.presentation)
          )}
          {group.factGroups?.map((factGroup) => (
            <div key={factGroup.key} className="em-writeup-fact-group" data-fact-group={factGroup.key}>
              <h3 className="em-writeup-kicker">{factGroup.label}</h3>
              <dl className="em-writeup-facts">
                {factGroup.facts.map((fact) => (
                  <div
                    key={fact.key}
                    className="em-writeup-fact"
                    data-fact={fact.key}
                    data-hide-label={fact.hideLabel ? "" : undefined}
                  >
                    <dt>{fact.label}</dt>
                    <dd>
                      {fact.content}
                      {fact.fold ? (
                        <WriteupDetails
                          reviewId={reviewId}
                          revision={revision}
                          sectionKey={fact.fold.key}
                          summary={fact.fold.summary}
                          changedIn={latestChange(fact.blocks ?? [])}
                        >
                          {renderBlocks(fact.blocks ?? [], group.path)}
                        </WriteupDetails>
                      ) : (
                        renderBlocks(fact.blocks ?? [], group.path)
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
          {group.subsections?.map((section) =>
            section.kind === "body" ? (
              <WriteupDetails
                key={section.key}
                reviewId={reviewId}
                revision={revision}
                sectionKey={section.key}
                changedIn={latestChange(section.blocks)}
              >
                {renderBlocks(section.blocks, group.path)}
              </WriteupDetails>
            ) : (
              <div key={section.key} className={`em-writeup-${section.kind}`}>
                <h3 className={section.kind === "why" ? "sr-only" : "em-writeup-kicker"}>{section.heading}</h3>
                {renderBlocks(section.blocks, group.path)}
              </div>
            ),
          )}
          {group.files}
        </ReadingGroup>
      ))}
      <ReadingThreads
        state={readingThreads}
        root={root}
        reviewId={reviewId}
        revision={revision}
        changedBlocks={changedBlocks}
        topics={topics}
      />
      {!readOnly && !composing && (error || target) && (
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
