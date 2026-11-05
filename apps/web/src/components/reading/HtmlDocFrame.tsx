import type { DocHeading, HtmlSpanTarget } from "@emend/contract";
import { TextSelect } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { claimDraft, useDraftClaim } from "../../lib/composer-owner.ts";
import { draftKey, listDrafts, subscribeDrafts } from "../../lib/drafts.ts";
import { type DocNavigation, FrameToParent, type HtmlPosition, type ParentToFrame } from "../../lib/frame-messages.ts";
import { useLayout } from "../../lib/layout.ts";
import { focusReadingTarget } from "../../lib/reading-focus.ts";
import { loadReadingPosition, saveReadingPosition } from "../../lib/reading-position.ts";
import type { ReadingEntry } from "../../lib/use-reading-trail.ts";
import { Composer } from "../threads/Composer.tsx";
import { ThreadCard } from "../threads/ThreadCard.tsx";
import { Button } from "../ui/Button.tsx";
import { Sheet } from "../ui/Sheet.tsx";
import type { ReaderProps } from "./BlockReader.tsx";

export type HtmlNavigation = { threadId: string; intent: unknown };
export function HtmlDocFrame({
  path,
  contentUrl,
  reviewId,
  revision,
  threads,
  topics,
  changedBlocks,
  navigation,
  docNavigation,
  onNavigate,
  composerOpen = false,
  headings = [],
  docPaths = [],
  reading,
  onPosition,
  commentsOpen = false,
  onCommentsOpenChange = () => {},
  returnFocus,
}: ReaderProps & {
  path: string;
  contentUrl: string;
  navigation?: HtmlNavigation;
  docNavigation?: DocNavigation;
  onNavigate?: (navigation: DocNavigation) => void;
  composerOpen?: boolean;
  headings?: readonly DocHeading[];
  docPaths?: string[];
  reading?: { key: string; entry: ReadingEntry; returning: boolean; target?: string; visit: unknown };
  onPosition?: (position: HtmlPosition) => void;
  commentsOpen?: boolean;
  onCommentsOpenChange?: (open: boolean) => void;
  returnFocus?: () => HTMLElement | null;
}) {
  const phone = useLayout() === "phone";
  const savedDrafts = JSON.parse(
    useSyncExternalStore(subscribeDrafts, () =>
      JSON.stringify(
        listDrafts(reviewId).filter(
          (draft) => !draft.threadId && draft.target?.kind === "html-span" && draft.target.path === path,
        ),
      ),
    ),
  ) as ReturnType<typeof listDrafts>;
  const frame = useRef<HTMLIFrameElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const loads = useRef(0);
  const gone = useRef(false);
  const [away, setAway] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [src, setSrc] = useState(contentUrl);
  const readyNow = useRef(false);
  const [ready, setReady] = useState(0);
  const [target, setTarget] = useState<HtmlSpanTarget | null>(null);
  const [composing, setComposing] = useState(false);
  const [show, setShow] = useState<HtmlNavigation>();
  const lastScroll = useRef<HtmlNavigation | undefined>(undefined);
  // A parent-requested src change mounts a fresh window and starts its load baseline.
  const mountFrame = useCallback((element: HTMLIFrameElement | null) => {
    frame.current = element;
    if (element) {
      loads.current = 0;
      gone.current = false;
      readyNow.current = false;
    }
  }, []);
  useEffect(() => {
    if (!docNavigation) return;
    setSrc(`${contentUrl}#${encodeURIComponent(docNavigation.fragment)}`);
    setReady(0);
    setAway(false);
    setShow(undefined);
    setGeneration((value) => value + 1);
  }, [contentUrl, docNavigation]);
  const placed = threads
    .filter(
      (thread) =>
        thread.placement.status === "placed" &&
        thread.placement.location.kind === "html-span" &&
        thread.placement.location.path === path,
    )
    .sort((a, b) => {
      const start = (thread: typeof a) =>
        thread.placement.status === "placed" && thread.placement.location.kind === "html-span"
          ? thread.placement.location.start
          : 0;
      return start(a) - start(b);
    });
  const docThreads = [
    ...placed,
    ...threads.filter(
      (thread) =>
        thread.placement.status !== "placed" && thread.target.kind === "html-span" && thread.target.path === path,
    ),
  ];
  const anchors = JSON.stringify(
    placed.flatMap((thread) =>
      thread.target.kind === "html-span"
        ? [
            {
              threadId: thread.id,
              quote: thread.target.quote,
              prefix: thread.target.prefix,
              suffix: thread.target.suffix,
            },
          ]
        : [],
    ),
  );
  const replyClaim = useDraftClaim(
    placed.map((thread) => draftKey(reviewId, thread.target, thread.id)),
    "reading",
  );
  useEffect(() => {
    if (replyClaim) onCommentsOpenChange(true);
  }, [replyClaim, onCommentsOpenChange]);
  const post = useCallback((message: ParentToFrame) => {
    if (readyNow.current && !gone.current) frame.current?.contentWindow?.postMessage(message, "*");
  }, []);
  const markAway = useCallback(() => {
    gone.current = true;
    readyNow.current = false;
    setAway(true);
    setReady(0);
    if (!composing) setTarget(null);
  }, [composing]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (gone.current || !frame.current?.contentWindow || event.source !== frame.current.contentWindow) return;
      const parsed = FrameToParent.safeParse(event.data);
      if (!parsed.success) return;
      if (parsed.data.type === "emend:ready") {
        if (readyNow.current) {
          markAway();
          return;
        }
        readyNow.current = true;
        setReady((value) => value + 1);
      } else if (parsed.data.type === "emend:position") {
        if (!readyNow.current || (parsed.data.heading !== null && !headings[parsed.data.heading])) return;
        const position = { heading: parsed.data.heading, fraction: parsed.data.fraction };
        onPosition?.(position);
        if (reading) {
          const anchor =
            position.heading === null ? null : { id: `h-${position.heading}`, fraction: position.fraction };
          reading.entry.positions.set(reading.key, anchor);
          saveReadingPosition(reading.key, anchor);
        }
      } else if (parsed.data.type === "emend:navigate") onNavigate?.(parsed.data);
      else if (!composing && !composerOpen) {
        const { quote, prefix, suffix } = parsed.data;
        setTarget({ kind: "html-span", path, quote, prefix, suffix });
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [path, composing, composerOpen, onNavigate, headings, reading, onPosition, markAway]);
  useEffect(() => {
    if (ready && !gone.current)
      frame.current?.contentWindow?.postMessage({ type: "emend:highlight", anchors: JSON.parse(anchors) }, "*");
  }, [ready, anchors]);
  const paths = JSON.stringify(docPaths);
  const handledPosition = useRef<{ reading: typeof reading; window: Window | null } | undefined>(undefined);
  useEffect(() => {
    if (ready && !gone.current) post({ type: "emend:docs", paths: JSON.parse(paths) });
  }, [ready, paths, post]);
  useEffect(() => {
    if (!ready || gone.current || !reading) return;
    const currentWindow = frame.current?.contentWindow ?? null;
    const previous = handledPosition.current;
    if (previous?.reading === reading && previous.window === currentWindow) return;
    handledPosition.current = { reading, window: currentWindow };
    const entrySaved = reading.entry.positions.get(reading.key);
    const restoreEntry = reading.returning && reading.entry.positions.has(reading.key);
    const target =
      reading.target !== undefined && /^(0|[1-9]\d*)$/.test(reading.target) ? Number(reading.target) : undefined;
    const saved = restoreEntry
      ? entrySaved
      : reading.target !== undefined
        ? target !== undefined
          ? { id: `h-${target}`, fraction: 0 }
          : null
        : navigation || docNavigation
          ? null
          : loadReadingPosition(reading.key);
    if (saved && /^h-(0|[1-9]\d*)$/.test(saved.id)) {
      const index = Number(saved.id.slice(2));
      const heading = headings[index];
      if (heading) {
        const picking = !restoreEntry && reading.target !== undefined;
        if (picking) {
          reading.entry.positions.delete(reading.key);
          reading.entry.focus = { id: `h-${index}`, children: [] };
        }
        post({
          type: "emend:goto",
          heading: index,
          label: heading.text,
          ...(picking ? {} : { fraction: saved.fraction }),
        });
        if (reading.target !== undefined || (restoreEntry && reading.entry.focus)) focusReadingTarget(frame.current);
        return;
      }
    }
    // An explicit top or missing target must also reset an already mounted frame.
    if (previous && previous.reading !== reading && ((restoreEntry && !entrySaved) || reading.target !== undefined)) {
      setSrc(contentUrl);
      setReady(0);
      setGeneration((value) => value + 1);
    }
    if (!navigation && !docNavigation) reading.entry.positions.set(reading.key, null);
  }, [ready, reading, headings, navigation, docNavigation, post, contentUrl]);
  useEffect(() => {
    setShow(navigation);
  }, [navigation]);
  useEffect(() => {
    if (
      !ready ||
      gone.current ||
      reading?.target !== undefined ||
      (reading?.returning && reading.entry.positions.has(reading.key)) ||
      !show ||
      lastScroll.current === show ||
      !placed.some((thread) => thread.id === show.threadId)
    )
      return;
    frame.current?.contentWindow?.postMessage({ type: "emend:scroll", threadId: show.threadId }, "*");
    lastScroll.current = show;
  }, [ready, show, placed, reading]);
  const close = () => {
    setComposing(false);
    setTarget(null);
  };
  return (
    <div ref={root} tabIndex={-1} className="em-html-doc" id={`html-doc-${path}`}>
      <div className="em-html-frame">
        <iframe
          ref={mountFrame}
          key={generation}
          sandbox="allow-scripts"
          src={src}
          title={path}
          referrerPolicy="no-referrer"
          className="h-full min-h-0 w-full border-0 bg-[#fff]"
          onLoad={() => {
            if (++loads.current <= 1) return;
            markAway();
          }}
        />
      </div>
      {away && (
        <div role="status" className="space-y-2">
          <p>This doc navigated away.</p>
          <Button
            onClick={() => {
              setSrc(contentUrl);
              setAway(false);
              setReady(0);
              lastScroll.current = undefined;
              setGeneration((value) => value + 1);
            }}
          >
            Reload {path}
          </Button>
        </div>
      )}
      <Sheet
        side={phone ? "bottom" : "right"}
        title="Comments"
        open={commentsOpen}
        onOpenChange={onCommentsOpenChange}
        returnFocus={returnFocus}
      >
        {docThreads.map((thread) => (
          <div key={thread.id} className="space-y-2">
            {thread.placement.status === "placed" && (
              <Button
                onClick={() => {
                  if (phone) onCommentsOpenChange(false);
                  if (ready) post({ type: "emend:scroll", threadId: thread.id });
                  else if (!gone.current) setShow({ threadId: thread.id, intent: {} });
                }}
              >
                Show in doc
              </Button>
            )}
            <ThreadCard
              reviewId={reviewId}
              revision={revision}
              changedBlocks={changedBlocks}
              thread={thread}
              topics={topics}
            />
          </div>
        ))}
        {!docThreads.length && <p>No comments on this doc yet.</p>}
        {!composing &&
          savedDrafts.map((draft) => (
            <Button
              key={draft.key}
              onClick={() => {
                if (draft.target?.kind !== "html-span") return;
                setTarget(draft.target);
                claimDraft(draft.key, "reading");
                setComposing(true);
              }}
            >
              Resume selection comment
            </Button>
          ))}
        {target && composing && !composerOpen && (
          <Composer
            reviewId={reviewId}
            revision={revision}
            target={target}
            topics={topics}
            onSaved={close}
            onCancel={() => setComposing(false)}
            returnFocus={() => returnFocus?.() ?? root.current}
          />
        )}
      </Sheet>
      {target && !composing && !composerOpen && (
        <div className="em-html-selection">
          <Button
            variant="primary"
            size="sm"
            icon={TextSelect}
            onClick={() => {
              claimDraft(draftKey(reviewId, target), "reading");
              onCommentsOpenChange(true);
              setComposing(true);
            }}
          >
            Comment on selection
          </Button>
        </div>
      )}
    </div>
  );
}
