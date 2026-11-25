import { type DocHeading, type HtmlDocChanges, type HtmlSpanTarget, RepoUrl } from "@recense/contract";
import { TextSelect } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { claimDraft, useDraftClaim } from "../../lib/composer-owner.ts";
import { draftKey, listDrafts, subscribeDrafts } from "../../lib/drafts.ts";
import {
  type DiagramJob,
  type DocNavigation,
  FrameToParent,
  type HtmlPosition,
  type ParentToFrame,
} from "../../lib/frame-messages.ts";
import { useLayout, useMedia } from "../../lib/layout.ts";
import { useLayoutPreferences } from "../../lib/layout-store.ts";
import { useReadOnlyReview } from "../../lib/read-only-review.ts";
import { focusReadingTarget } from "../../lib/reading-focus.ts";
import { loadReadingPosition, saveReadingPosition } from "../../lib/reading-position.ts";
import { pickedTheme, themeColors, useResolvedTheme, useThemeState } from "../../lib/theme.ts";
import type { ReadingEntry } from "../../lib/use-reading-trail.ts";
import { Composer } from "../threads/Composer.tsx";
import { ThreadCard } from "../threads/ThreadCard.tsx";
import { Button } from "../ui/Button.tsx";
import { Sheet } from "../ui/Sheet.tsx";
import type { ReaderProps } from "./BlockReader.tsx";
import { HtmlDiagramRenderer } from "./HtmlDiagramRenderer.tsx";
import { Lightbox } from "./Lightbox.tsx";
import type { LightboxSubject } from "./screenshots.ts";

export type HtmlNavigation = { threadId: string; intent: unknown };
export function HtmlDocFrame({
  path,
  contentUrl,
  repoUrl,
  images = [],
  look,
  colorScheme,
  reviewId,
  revision,
  threads,
  topics,
  changedBlocks,
  changes,
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
  repoUrl?: string | null;
  changes?: HtmlDocChanges;
  images?: readonly string[];
  look?: "recense" | "custom";
  colorScheme?: "light";
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
  const parsedRepo = RepoUrl.safeParse(repoUrl);
  const checkedRepoUrl = parsedRepo.success ? parsedRepo.data : undefined;
  const readOnly = useReadOnlyReview();
  const phone = useLayout() === "phone";
  const wide = useMedia("(min-width: 768px)");
  const { readingWidth, proseSize, codePx } = useLayoutPreferences();
  const recenseLook = look === "recense";
  const lightOnly = colorScheme === "light";
  const resolvedTheme = useResolvedTheme();
  const mode = lightOnly ? "light" : resolvedTheme;
  const custom = pickedTheme(useThemeState());
  const colors = JSON.stringify(
    recenseLook && custom && (!lightOnly || custom.base === "light") ? themeColors(custom) : { scales: {}, tokens: {} },
  );
  const currentMode = useRef(mode);
  useLayoutEffect(() => {
    currentMode.current = mode;
  }, [mode]);
  const frameSrc = useCallback(
    (fragment?: string) =>
      `${contentUrl}${recenseLook && !lightOnly ? `?theme=${currentMode.current}` : ""}${fragment === undefined ? "" : `#${encodeURIComponent(fragment)}`}`,
    [contentUrl, recenseLook, lightOnly],
  );
  const width = recenseLook ? readingWidth : undefined;
  const prose = recenseLook ? proseSize : undefined;
  const code = recenseLook ? codePx : undefined;
  const savedDrafts = JSON.parse(
    useSyncExternalStore(subscribeDrafts, () =>
      JSON.stringify(
        (readOnly ? [] : listDrafts(reviewId)).filter(
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
  const [src, setSrc] = useState(() => frameSrc());
  const readyNow = useRef(false);
  const repoSent = useRef(false);
  const [ready, setReady] = useState(0);
  const [selectionTarget, setSelectionTarget] = useState<HtmlSpanTarget | null>(null);
  const [formTarget, setFormTarget] = useState<HtmlSpanTarget | null>(null);
  const composing = formTarget !== null;
  const guardUntil = useRef(0);
  const pendingDeselect = useRef(false);
  const deselectTimer = useRef<number | undefined>(undefined);
  const [show, setShow] = useState<HtmlNavigation>();
  const [gallery, setGallery] = useState<{ items: LightboxSubject[]; index: number } | null>(null);
  const [diagramJob, setDiagramJob] = useState<DiagramJob | null>(null);
  const closeGallery = useCallback(() => setGallery(null), []);
  const lastScroll = useRef<HtmlNavigation | undefined>(undefined);
  // A parent-requested src change mounts a fresh window and starts its load baseline.
  const mountFrame = useCallback((element: HTMLIFrameElement | null) => {
    frame.current = element;
    if (element) {
      setSelectionTarget(null);
      setGallery(null);
      setDiagramJob(null);
      loads.current = 0;
      gone.current = false;
      readyNow.current = false;
      repoSent.current = false;
    }
  }, []);
  useEffect(() => {
    if (!docNavigation) return;
    setSrc(frameSrc(docNavigation.fragment));
    setReady(0);
    setAway(false);
    setShow(undefined);
    setGeneration((value) => value + 1);
  }, [frameSrc, docNavigation]);
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
    setGallery(null);
    setDiagramJob(null);
    setReady(0);
    setSelectionTarget(null);
  }, []);
  const endPress = useCallback(() => {
    if (guardUntil.current !== Number.POSITIVE_INFINITY) return;
    guardUntil.current = Date.now() + 600;
    window.clearTimeout(deselectTimer.current);
    deselectTimer.current = window.setTimeout(() => {
      deselectTimer.current = undefined;
      if (pendingDeselect.current) {
        pendingDeselect.current = false;
        setSelectionTarget(null);
      }
    }, 600);
  }, []);
  useEffect(() => {
    document.addEventListener("pointerup", endPress, true);
    document.addEventListener("pointercancel", endPress, true);
    return () => {
      window.clearTimeout(deselectTimer.current);
      document.removeEventListener("pointerup", endPress, true);
      document.removeEventListener("pointercancel", endPress, true);
    };
  }, [endPress]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (gone.current || !frame.current?.contentWindow || event.source !== frame.current.contentWindow) return;
      const parsed = FrameToParent.safeParse(event.data);
      if (!parsed.success) return;
      if (parsed.data.type === "recense:ready") {
        if (readyNow.current) {
          markAway();
          return;
        }
        readyNow.current = true;
        setReady((value) => value + 1);
      } else if (parsed.data.type === "recense:issue") {
        if (readyNow.current && checkedRepoUrl)
          window.open(
            String(new URL(`${checkedRepoUrl}/issues/${parsed.data.number}`)),
            "_blank",
            "noopener,noreferrer",
          );
      } else if (parsed.data.type === "recense:position") {
        if (!readyNow.current || (parsed.data.heading !== null && !headings[parsed.data.heading])) return;
        const position = { heading: parsed.data.heading, fraction: parsed.data.fraction };
        onPosition?.(position);
        if (reading && !readOnly) {
          const anchor =
            position.heading === null ? null : { id: `h-${position.heading}`, fraction: position.fraction };
          reading.entry.positions.set(reading.key, anchor);
          saveReadingPosition(reading.key, anchor);
        }
      } else if (parsed.data.type === "recense:diagrams") {
        if (readyNow.current) setDiagramJob(parsed.data);
      } else if (parsed.data.type === "recense:image") {
        if (!readyNow.current) return;
        const allowed = new Set(images);
        const clicked = parsed.data.images[parsed.data.index];
        const prefix = /^\/content\/[A-Za-z0-9_-]+\//.exec(contentUrl)?.[0];
        if (!clicked || !allowed.has(clicked.path) || !prefix) return;
        const kept = parsed.data.images.filter((image) => allowed.has(image.path));
        setGallery({
          items: kept.map(({ path, caption }) => ({
            kind: "image",
            src: prefix + path.split("/").map(encodeURIComponent).join("/"),
            caption: caption || "Screenshot",
          })),
          index: kept.indexOf(clicked),
        });
      } else if (parsed.data.type === "recense:navigate") onNavigate?.(parsed.data);
      else if (parsed.data.type === "recense:deselect") {
        pendingDeselect.current = Date.now() < guardUntil.current;
        if (!pendingDeselect.current) setSelectionTarget(null);
      } else if (!readOnly && !composerOpen && !(composing && commentsOpen)) {
        const { quote, prefix, suffix } = parsed.data;
        pendingDeselect.current = false;
        setSelectionTarget({ kind: "html-span", path, quote, prefix, suffix });
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [
    readOnly,
    path,
    contentUrl,
    checkedRepoUrl,
    images,
    composing,
    commentsOpen,
    composerOpen,
    onNavigate,
    headings,
    reading,
    onPosition,
    markAway,
  ]);
  useEffect(() => {
    if (!ready) return;
    if (width !== undefined && prose !== undefined && code !== undefined)
      post({ type: "recense:layout", wide, width, prose, code });
    else post({ type: "recense:layout", wide });
  }, [ready, wide, width, prose, code, post]);
  useEffect(() => {
    if (ready && recenseLook) post({ type: "recense:theme", mode, ...JSON.parse(colors) });
  }, [ready, recenseLook, mode, colors, post]);
  useEffect(() => {
    if (!ready || !readyNow.current || gone.current || repoSent.current || !checkedRepoUrl) return;
    post({ type: "recense:repo", url: checkedRepoUrl });
    repoSent.current = true;
  }, [ready, checkedRepoUrl, post]);
  useEffect(() => {
    if (ready && !gone.current)
      frame.current?.contentWindow?.postMessage({ type: "recense:highlight", anchors: JSON.parse(anchors) }, "*");
  }, [ready, anchors]);
  const paths = JSON.stringify(docPaths);
  const changedParts = JSON.stringify(changes);
  useEffect(() => {
    if (ready && !gone.current && changedParts !== undefined)
      post({ type: "recense:changed", ...JSON.parse(changedParts) });
  }, [ready, changedParts, post]);
  const handledPosition = useRef<{ reading: typeof reading; window: Window | null } | undefined>(undefined);
  useEffect(() => {
    if (ready && !gone.current) post({ type: "recense:docs", paths: JSON.parse(paths) });
  }, [ready, paths, post]);
  useEffect(() => {
    if (readOnly || !ready || gone.current || !reading) return;
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
          type: "recense:goto",
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
      setSrc(frameSrc());
      setReady(0);
      setGeneration((value) => value + 1);
    }
    if (!navigation && !docNavigation) reading.entry.positions.set(reading.key, null);
  }, [readOnly, ready, reading, headings, navigation, docNavigation, post, frameSrc]);
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
    frame.current?.contentWindow?.postMessage({ type: "recense:scroll", threadId: show.threadId }, "*");
    lastScroll.current = show;
  }, [ready, show, placed, reading]);
  const close = () => {
    setFormTarget(null);
    setSelectionTarget(null);
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
          className={`h-full min-h-0 w-full border-0 ${look === "recense" && colorScheme !== "light" ? "bg-reading" : "bg-[#fff]"}`}
          onLoad={() => {
            if (++loads.current <= 1) return;
            markAway();
          }}
        />
      </div>
      {gallery && <Lightbox gallery={gallery} onClose={closeGallery} />}
      {diagramJob && ready && !away ? (
        <HtmlDiagramRenderer key={generation} job={diagramJob} look={look} post={post} />
      ) : null}
      {away && (
        <div role="status" className="space-y-2">
          <p>This doc navigated away.</p>
          <Button
            onClick={() => {
              setSrc(frameSrc());
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
                  if (ready) post({ type: "recense:scroll", threadId: thread.id });
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
                setFormTarget(draft.target);
                setSelectionTarget(null);
                claimDraft(draft.key, "reading");
              }}
            >
              Resume selection comment
            </Button>
          ))}
        {!readOnly && formTarget && !composerOpen && (
          <Composer
            reviewId={reviewId}
            revision={revision}
            target={formTarget}
            topics={topics}
            onSaved={close}
            onCancel={close}
            returnFocus={() => returnFocus?.() ?? root.current}
          />
        )}
      </Sheet>
      {!readOnly && selectionTarget && !composerOpen && !(composing && commentsOpen) && (
        <div className="em-html-selection">
          <Button
            variant="primary"
            size="sm"
            icon={TextSelect}
            // A tap can collapse the frame selection before the button receives its click.
            onPointerDown={(event) => {
              window.clearTimeout(deselectTimer.current);
              pendingDeselect.current = false;
              guardUntil.current = Number.POSITIVE_INFINITY;
              try {
                event.currentTarget.setPointerCapture(event.pointerId);
              } catch {
                // Document release listeners still handle a press when capture is unavailable.
              }
            }}
            onLostPointerCapture={endPress}
            onClick={() => {
              pendingDeselect.current = false;
              claimDraft(draftKey(reviewId, selectionTarget), "reading");
              setFormTarget(selectionTarget);
              setSelectionTarget(null);
              onCommentsOpenChange(true);
            }}
          >
            Comment on selection
          </Button>
        </div>
      )}
    </div>
  );
}
