import type { ReviewView, RevisionView } from "@emend/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate, useParams, useRouter } from "@tanstack/react-router";
import {
  type ComponentProps,
  type MouseEvent,
  type Ref,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { placeSpan } from "../../../../packages/core/src/place/span.ts";
import { ApiError, change } from "../api/client.ts";
import { mutationMessage, useViewedErrors, useViewedMutation, useViewedRevision } from "../api/mutations.ts";
import { reviewQuery, revisionQuery } from "../api/queries.ts";
import { LazyDiffPane } from "../components/diff/LazyDiffPane.tsx";
import { isDiffTarget } from "../components/diff/targets.ts";
import { FilesView } from "../components/files/FilesView.tsx";
import { AppFrame } from "../components/layout/AppFrame.tsx";
import { Panes } from "../components/layout/Panes.tsx";
import { PhoneTabs } from "../components/layout/PhoneTabs.tsx";
import { ReviewInbox } from "../components/layout/ReviewInbox.tsx";
import { ReviewTabs } from "../components/layout/ReviewTabs.tsx";
import type { ThreadJump } from "../components/reading/BlockThreads.tsx";
import { DocView } from "../components/reading/DocView.tsx";
import type { HtmlNavigation } from "../components/reading/HtmlDocFrame.tsx";
import { ReadingFoldContext } from "../components/reading/ReadingGroup.tsx";
import { Writeup } from "../components/reading/Writeup.tsx";
import { ReviewHeader } from "../components/review/ReviewHeader.tsx";
import { SendBar } from "../components/send/SendBar.tsx";
import { threadCounts } from "../components/status/ThreadStateBadge.tsx";
import { Composer } from "../components/threads/Composer.tsx";
import { ThreadList } from "../components/threads/ThreadList.tsx";
import { Button } from "../components/ui/Button.tsx";
import { useToast } from "../components/ui/Toast.tsx";
import { claimDraft } from "../lib/composer-owner.ts";
import { useDiffCounts } from "../lib/diff-counts.ts";
import type { NavigateDiff } from "../lib/diff-navigation.ts";
import { appElementId, docHeading, docTitle } from "../lib/doc-navigation.ts";
import { docKey, docView, findDoc } from "../lib/doc-view.ts";
import { draftKey, hasDraft, type SavedDraft, saveDraft, subscribeDrafts } from "../lib/drafts.ts";
import { usePublishedRevision } from "../lib/events.tsx";
import { useInboxCollapsed, useLayout, usePaneMode } from "../lib/layout.ts";
import { openingView } from "../lib/opening-view.ts";
import { focusReadingTarget } from "../lib/reading-focus.ts";
import { readingPositionKey } from "../lib/reading-position.ts";
import { revealReadingTarget } from "../lib/reading-reveal.ts";
import {
  captureReadingPosition,
  type IntentState,
  useFilesPosition,
  useReadingPosition,
} from "../lib/use-reading-position.ts";
import { type ReadingEntry, useReadingTrail } from "../lib/use-reading-trail.ts";
import { useWakeTimer } from "../lib/wake-timer.ts";
import { type ReviewSearch, validateReviewSearch } from "../router.tsx";

function Files({
  reviewId,
  visible,
  ...props
}: ComponentProps<typeof FilesView> & { reviewId: string; visible: boolean }) {
  useFilesPosition({ storageKey: readingPositionKey(reviewId, "files"), active: visible });
  return <FilesView {...props} />;
}

function Reading({
  reviewId,
  revision,
  tab,
  onResume,
  htmlNavigation,
  composingPath,
  resumedBlockId,
  activeThreadId,
  threadJump,
  search,
  phone,
  openDoc,
  targeted,
  onOpenDoc,
  onCurrentTopic,
  onNote,
  visible,
  intentState,
  entry,
  back,
  onHeading,
  preservePosition,
  returning,
  headingTarget,
  visit,
}: {
  reviewId: string;
  revision: RevisionView;
  tab: string;
  onResume: (draft: SavedDraft) => void;
  htmlNavigation?: HtmlNavigation;
  composingPath?: string;
  resumedBlockId?: string;
  activeThreadId?: string;
  threadJump?: ThreadJump;
  search: ReviewSearch;
  phone: boolean;
  openDoc?: RevisionView["docs"][number];
  targeted: boolean;
  onOpenDoc: (doc: RevisionView["docs"][number]) => void;
  onCurrentTopic?: (slug: string | undefined) => void;
  onNote: (id: string) => void;
  visible: boolean;
  intentState: () => IntentState;
  entry: ReadingEntry;
  back?: { title: string; go: () => void };
  onHeading: (id: string) => void;
  preservePosition: boolean;
  returning: boolean;
  headingTarget?: string;
  visit: unknown;
}) {
  useReadingPosition({
    storageKey: readingPositionKey(
      reviewId,
      tab,
      tab === "docs" ? (openDoc?.path ?? "") : "",
      revision.seq,
      docView(openDoc, search.view) ?? (openDoc?.kind === "html" ? "original" : "reading"),
    ),
    selector: tab === "comments" ? '[id^="thread-"]' : '[id^="block-"], [id^="html-doc-"]',
    active: visible && !(tab === "docs" && (openDoc?.kind === "html" || openDoc?.kind === "source")),
    preserve: preservePosition,
    entry,
    doc: tab === "docs" ? openDoc : undefined,
    intentState,
  });
  const props = {
    reviewId,
    revision: revision.seq,
    threads: revision.threads,
    changedBlocks: revision.changedBlocks,
    topics: revision.topics,
    activeThreadId,
    threadJump,
  };
  if (tab === "comments") return <ThreadList {...props} search={search} phone={phone} onResume={onResume} />;
  if (tab === "docs")
    return (
      <DocView
        {...props}
        entry={entry}
        returning={returning}
        headingTarget={headingTarget}
        visit={visit}
        docs={revision.docs}
        openDoc={openDoc}
        search={search}
        targeted={targeted}
        onHeading={onHeading}
        back={back}
        onOpenDoc={onOpenDoc}
        navigation={htmlNavigation}
        composingPath={composingPath}
        resumedBlockId={resumedBlockId}
      />
    );
  return (
    <Writeup
      {...props}
      writeup={revision.writeup}
      files={revision.files}
      search={search}
      phone={phone}
      visible={visible}
      resumedBlockId={resumedBlockId}
      onCurrentTopic={onCurrentTopic}
      onNote={onNote}
    />
  );
}
function draftPlacement(draft: SavedDraft, revision: RevisionView) {
  if (draft.threadId) return revision.threads.find((thread) => thread.id === draft.threadId)?.placement;
  const target = draft.target;
  if (target?.kind === "writeup-span")
    return placeSpan(
      revision.writeup.sections.flatMap((section) => section.blocks),
      target,
    );
  if (target?.kind === "doc-span") {
    const doc = revision.docs.find((doc) => doc.kind === "markdown" && doc.path === target.path);
    return placeSpan(doc?.kind === "markdown" ? doc.blocks : [], target);
  }
  return undefined;
}
function readingIntent(search: ReviewSearch, hash: string, seq: number) {
  let headingId: string | undefined;
  if (hash.startsWith("h-")) {
    try {
      headingId = decodeURIComponent(hash.slice(2));
    } catch {
      headingId = "";
    }
  }
  const reply = headingId === undefined && search.tab === "comments" && !!search.thread;
  return {
    navigation: JSON.stringify([seq, search.tab, search.doc, search.thread, search.view, hash]),
    elementId: reply ? `thread-${search.thread}` : appElementId(hash) ? hash : "",
    headingId,
    reply,
    threadId:
      headingId !== undefined ? undefined : (search.thread ?? (hash.startsWith("thread-") ? hash.slice(7) : undefined)),
    routeThread: true,
    block: "center" as ScrollLogicalPosition,
  };
}
type PendingReadingIntent = ReturnType<typeof readingIntent> & {
  token: object;
  jumpThread: boolean;
  restoreEntry?: boolean;
};
function resolveOpenDoc(
  revision: RevisionView,
  search: ReviewSearch,
  intent: ReturnType<typeof readingIntent>,
  openingDoc: string | undefined,
  docsVisible: boolean,
) {
  const selected = findDoc(revision.docs, search.doc, search.view);
  if (selected) return selected;
  if (search.doc !== undefined) return undefined;
  const thread = revision.threads.find((thread) => thread.id === intent.threadId);
  const placement = thread?.placement.status === "placed" ? thread.placement.location : undefined;
  const target = revision.docs.find(
    (doc) =>
      (doc.kind !== "source" && intent.elementId === `doc-${doc.path}`) ||
      (doc.kind === "html" && intent.elementId === `html-doc-${doc.path}`) ||
      (doc.kind === "markdown" && doc.blocks.some((block) => intent.elementId === `block-${block.id}`)) ||
      ((placement?.kind === "doc-span" || placement?.kind === "html-span" || placement?.kind === "source-lines") &&
        placement.path === doc.path &&
        doc.kind ===
          (placement.kind === "source-lines" ? "source" : placement.kind === "html-span" ? "html" : "markdown")),
  );
  return (
    target ??
    findDoc(revision.docs, openingDoc) ??
    (docsVisible && revision.docs.length === 1 ? revision.docs[0] : undefined)
  );
}
function LoadedReview({
  routeId,
  review,
  published,
  titleRef,
  collapsed,
  setCollapsed,
}: {
  routeId: string;
  review: ReviewView;
  published: number;
  titleRef: Ref<HTMLHeadingElement>;
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
}) {
  // Read search and hash from one location: route matches can lag during navigation.
  const router = useRouter();
  const liveLocation = useLocation();
  const ownsAddress = useCallback(
    (pathname: string) => {
      const [, rawParams, foundRoute] = router.getMatchedRoutes(pathname);
      return foundRoute?.id === "/r/$reviewId" && rawParams.reviewId === routeId && rawParams["**"] === undefined;
    },
    [router, routeId],
  );
  const isOwnLocation = ownsAddress(liveLocation.pathname);
  const [lastOwnLocation, setLastOwnLocation] = useState(() => (isOwnLocation ? liveLocation : undefined));
  if (isOwnLocation && lastOwnLocation !== liveLocation) setLastOwnLocation(liveLocation);
  const location = isOwnLocation ? liveLocation : lastOwnLocation;
  const search = useMemo(() => validateReviewSearch(location?.search ?? {}), [location?.search]);
  const hash = location?.hash ?? "";
  const [initialRevision] = useState(review.newestRevision);
  const seq = search.rev ?? initialRevision;
  const query = useQuery(revisionQuery(review.id, seq));
  const viewedMutation = useViewedMutation(review.id);
  const viewedErrors = useViewedErrors(review.id);
  const onViewed = (paths: string[], viewed: boolean) => viewedMutation.mutate({ revision: seq, paths, viewed });
  const { counts: diffCounts } = useDiffCounts();
  const navigate = useNavigate({ from: "/r/$reviewId" });
  const client = useQueryClient();
  // A timed snooze ends on the server without an event: ask again when this one passes.
  useWakeTimer([review.snoozedUntil], () => {
    void client.invalidateQueries({ queryKey: ["review", review.id] });
    void client.invalidateQueries({ queryKey: ["inbox"] });
  });
  const layout = useLayout();
  const paneMode = usePaneMode();
  const readingId = useId();
  // Resolving the lazy pane does not otherwise rerender this route's pending scroll effect.
  const [, setDiffRendered] = useState(0);
  const onDiffRendered = useCallback(() => setDiffRendered((value) => value + 1), []);
  const navigateDiff = useRef<NavigateDiff | null>(null);
  const onDiffNavigator = useCallback((navigate: NavigateDiff | null) => {
    navigateDiff.current = navigate;
  }, []);
  const [currentTopic, setCurrentTopic] = useState<string>();
  const revision = useViewedRevision(review.id, query.data);
  const diffFiles = revision?.files.filter((file) => file.role === "diff") ?? [];
  const [resumed, setResumed] = useState<(SavedDraft & { tab: NonNullable<ReviewSearch["tab"]> }) | null>(null);
  const resumedPlacement = resumed && revision ? draftPlacement(resumed, revision) : undefined;
  const resumedBlockId =
    resumedPlacement?.status === "placed" && "blockId" in resumedPlacement.location
      ? resumedPlacement.location.blockId
      : undefined;
  const endResume = () => setResumed((current) => (current === resumed ? null : current));
  useEffect(() => {
    if (!resumed) return;
    const refresh = () => {
      if (!hasDraft(resumed.key)) setResumed((current) => (current === resumed ? null : current));
    };
    refresh();
    return subscribeDrafts(refresh);
  }, [resumed]);
  // A resumed editor needs its destination even when the revision has no content there.
  const hasDocs = (revision?.docs.length ?? 0) > 0 || resumed?.tab === "docs";
  const hasDiff = (revision?.files.some((file) => file.role === "diff") ?? false) || resumed?.tab === "diff";
  const hasWriteup =
    (!!revision && (!revision.writeupEmpty || revision.main === "writeup")) || resumed?.tab === "writeup";
  const opening = revision ? openingView(revision) : { tab: "writeup" as const };
  const useOpening =
    !search.tab ||
    !{ writeup: hasWriteup, files: diffFiles.length > 0, diff: hasDiff, docs: hasDocs, comments: true }[search.tab];
  const tab = useOpening ? opening.tab : (search.tab ?? opening.tab);
  const [lastReadingTab, setLastReadingTab] = useState<Exclude<ReviewSearch["tab"], "diff">>();
  if (tab !== "diff" && lastReadingTab !== tab) setLastReadingTab(tab);
  const readingTab =
    tab === "diff"
      ? (layout !== "phone" && paneMode === "tabs" && lastReadingTab) ||
        (hasWriteup ? "writeup" : hasDocs ? "docs" : "comments")
      : tab;
  const docsVisible = readingTab === "docs" && (paneMode === "split" || tab !== "diff");
  const currentIntent = readingIntent(search, hash, seq);
  const openDoc = revision
    ? resolveOpenDoc(revision, search, currentIntent, useOpening ? opening.doc : undefined, docsVisible)
    : undefined;
  const trail = useReadingTrail(
    tab === "diff"
      ? "Diff"
      : readingTab === "docs"
        ? openDoc
          ? docTitle(openDoc)
          : "All docs"
        : readingTab === "writeup"
          ? "Writeup"
          : readingTab === "comments"
            ? "Comments"
            : "Files",
    seq,
    // No own address yet means leaving: unmount without writing history; the trail only needs a history index.
    location ?? liveLocation,
  );
  const readingFolds = useMemo(
    () => ({ reviewId: review.id, revision: seq, choices: trail.entry.folds }),
    [review.id, seq, trail.entry],
  );
  const missingDoc = docsVisible && search.doc !== undefined && !openDoc;
  const positionKey = readingPositionKey(
    review.id,
    readingTab,
    readingTab === "docs" ? (openDoc?.path ?? "") : "",
    seq,
    docView(openDoc, search.view) ?? (openDoc?.kind === "html" ? "original" : "reading"),
  );
  const restoreEntry =
    !(readingTab === "docs" && openDoc?.kind === "source") && trail.returning && trail.entry.positions.has(positionKey);
  const [failedHeading, setFailedHeading] = useState<string>();
  const missingHeading =
    !restoreEntry &&
    docsVisible &&
    !!openDoc &&
    currentIntent.headingId !== undefined &&
    (failedHeading === currentIntent.navigation ||
      !(openDoc.kind === "html"
        ? /^(0|[1-9]\d*)$/.test(currentIntent.headingId) && openDoc.headings?.[Number(currentIntent.headingId)]
        : openDoc.kind === "markdown" && openDoc.headings?.some((heading) => heading.id === currentIntent.headingId)));
  const setRevision = (rev: number) => {
    void navigate({ search: { ...search, tab, rev } });
  };
  const [requested, setRequested] = useState<PendingReadingIntent | null>(null);
  const [threadJump, setThreadJump] = useState<ThreadJump & { navigation: string }>();
  const [htmlNavigation, setHtmlNavigation] = useState<HtmlNavigation>();
  const pending = useRef<PendingReadingIntent | null>(null);
  const previous = useRef<{
    navigation: string;
    elementId: string;
    threadId?: string;
    requested: typeof requested;
    entry: ReadingEntry;
  } | null>(null);
  // The reading position yields to a navigation that scrolls (a new hash or thread, a link, a Resume), never to
  // a hash that stayed in the URL or to an older intent that was never fulfilled: those have another navigation.
  // `navigationCount` counts navigations (a revisit of the same URL is another one); a redirect that continues
  // an intent is not. `scrollIntentAt` is the count at the latest scrolling intent.
  const navigationCount = useRef(0);
  const scrollIntentAt = useRef(-1);
  const scrollIntentEpoch = useRef(0);
  const intentState = useCallback((): IntentState => {
    const explicit = requested && requested !== previous.current?.requested;
    const changed =
      currentIntent.navigation !== previous.current?.navigation || trail.entry !== previous.current?.entry;
    const candidate = explicit ? requested : changed ? currentIntent : undefined;
    const scrolling =
      candidate &&
      (explicit || !restoreEntry) &&
      (candidate.headingId !== undefined ||
        ((explicit ||
          candidate.elementId !== previous.current?.elementId ||
          candidate.threadId !== previous.current?.threadId) &&
          !!(candidate.elementId || candidate.threadId)));
    return {
      current: candidate ? !!scrolling : scrollIntentAt.current === navigationCount.current,
      epoch: scrollIntentEpoch.current,
    };
  }, [currentIntent, requested, restoreEntry, trail.entry]);
  const navigateReading = useCallback(
    (next: ReviewSearch, nextHash = "", replace = false) => {
      // A repeated Resume or link click is a new intent even when the URL is unchanged.
      setRequested({ ...readingIntent(next, nextHash, next.rev ?? initialRevision), token: {}, jumpThread: true });
      void navigate({ search: next, hash: nextHash, replace });
    },
    [initialRevision, navigate],
  );
  const onNote = useCallback(
    (id: string) =>
      navigateReading(
        { ...search, tab: paneMode === "tabs" || layout === "phone" ? "diff" : "writeup", thread: undefined },
        `diff-note-${id}`,
      ),
    [navigateReading, search, paneMode, layout],
  );
  const followReadingLink = (event: MouseEvent) => {
    if (
      event.defaultPrevented ||
      event.altKey ||
      (event.button !== 0 && event.button !== 1) ||
      (event.type === "auxclick" && event.button !== 1)
    )
      return;
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (
      !(link instanceof HTMLAnchorElement) ||
      link.hasAttribute("download") ||
      (link.target && link.target !== "_self")
    )
      return;
    const url = new URL(link.href);
    if (url.origin !== window.location.origin || url.pathname !== `/r/${encodeURIComponent(review.id)}`) return;
    const next = validateReviewSearch(Object.fromEntries(url.searchParams));
    const modified = event.button === 1 || event.metaKey || event.ctrlKey || event.shiftKey;
    if (modified && next.tab !== "docs") return;
    event.preventDefault();
    const destination = {
      ...next,
      view: docView(findDoc(revision?.docs ?? [], next.doc, next.view), next.view ?? search.view),
      rev: next.tab === "docs" ? seq : (next.rev ?? search.rev),
    };
    if (modified) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(destination)) if (value !== undefined) params.set(key, String(value));
      window.open(`${url.pathname}?${params}${url.hash}`, "_blank", "noopener");
    } else {
      navigateReading(
        destination,
        url.hash.slice(1),
        docsVisible && next.tab === "docs" && next.doc === openDoc?.path && destination.view === search.view,
      );
    }
  };
  const onHeading = (id: string) => {
    if (
      !openDoc ||
      !(openDoc.kind === "html"
        ? /^(0|[1-9]\d*)$/.test(id) && openDoc.headings?.[Number(id)]
        : openDoc.kind === "markdown" && openDoc.headings?.some((heading) => heading.id === id))
    )
      return;
    navigateReading(
      { ...search, rev: seq, tab: "docs", doc: openDoc.path, thread: undefined },
      `h-${encodeURIComponent(id)}`,
      true,
    );
  };
  const resume = (draft: SavedDraft) => {
    if (draft.commentId && revision) {
      const thread = revision.threads.find((thread) =>
        thread.comments.some((comment) => comment.id === draft.commentId),
      );
      if (thread) {
        setResumed(null);
        claimDraft(draft.key, "comments");
        navigateReading({ ...search, tab: "comments", thread: undefined });
      }
      return;
    }
    if (!draft.target || !revision) return;
    const thread = draft.threadId ? revision.threads.find((thread) => thread.id === draft.threadId) : undefined;
    if (thread) {
      const location = thread.placement.status === "placed" ? thread.placement.location : undefined;
      setResumed(null);
      navigateReading({
        ...search,
        tab: "comments",
        doc: location?.kind === "doc-span" || location?.kind === "html-span" ? location.path : search.doc,
        view:
          location?.kind === "doc-span" || location?.kind === "html-span"
            ? docView(undefined, search.view)
            : search.view,
        thread: draft.threadId,
      });
      return;
    }
    if (isDiffTarget(draft.target)) {
      claimDraft(draft.key, "diff");
      setResumed({ ...draft, tab: "diff" });
      navigateReading({ ...search, tab: "diff", thread: undefined });
      return;
    }
    claimDraft(draft.key, "resumed");
    if (draft.target.kind === "source-lines") {
      setResumed({ ...draft, tab: "docs" });
      navigateReading({ ...search, tab: "docs", doc: draft.target.path, view: "source", thread: undefined }, "");
      return;
    }
    if (draft.target.kind === "html-span") {
      setResumed({ ...draft, tab: "docs" });
      navigateReading(
        { ...search, tab: "docs", doc: draft.target.path, view: docView(undefined, search.view), thread: undefined },
        `html-doc-${draft.target.path}`,
      );
      return;
    }
    const placement = draftPlacement(draft, revision);
    if (placement?.status === "placed" && "blockId" in placement.location) {
      const destination = placement.location.kind === "doc-span" ? "docs" : "writeup";
      setResumed({ ...draft, tab: destination });
      navigateReading(
        {
          ...search,
          tab: destination,
          doc: draft.target.kind === "doc-span" ? draft.target.path : search.doc,
          view: draft.target.kind === "doc-span" ? docView(undefined, search.view) : search.view,
          thread: undefined,
        },
        `block-${placement.location.blockId}`,
      );
    } else {
      const destination = draft.target.kind === "doc-span" ? "docs" : readingTab;
      setResumed({ ...draft, tab: destination });
      navigateReading({
        ...search,
        tab: destination,
        doc: draft.target.kind === "doc-span" ? draft.target.path : search.doc,
        view: draft.target.kind === "doc-span" ? docView(undefined, search.view) : search.view,
        thread: undefined,
      });
    }
  };
  const commentOnReview = () => {
    const target = { kind: "review" } as const;
    const key = draftKey(review.id, target);
    if (!hasDraft(key)) saveDraft(key, "");
    resume({ key, target });
  };
  // Data/DOM changes may fulfill an existing intent, but only navigation creates one.
  useEffect(() => {
    // The router exposes the next page's address before this review unmounts.
    // Replacing here would overwrite that page's history entry.
    if (!isOwnLocation) return;
    // Navigation may start after render, before this effect writes.
    const replaceAddress = (search: ReviewSearch, hash: string) => {
      if (!ownsAddress(router.latestLocation.pathname)) return;
      void navigate({ to: "/r/$reviewId", params: { reviewId: routeId }, search, hash, replace: true });
    };
    const current = currentIntent;
    let created = false;
    if (requested && requested !== previous.current?.requested) {
      pending.current = { ...requested };
      created = true;
    } else if (
      (current.navigation !== previous.current?.navigation || trail.entry !== previous.current?.entry) &&
      pending.current?.navigation !== current.navigation
    ) {
      pending.current = {
        ...current,
        token: {},
        restoreEntry,
        // A carried-over hash on a tab, doc or revision change is not a new thread jump.
        jumpThread:
          current.elementId !== previous.current?.elementId || current.threadId !== previous.current?.threadId,
      };
      created = true;
    }
    if (created) {
      navigationCount.current += 1;
      if (
        pending.current &&
        !pending.current.restoreEntry &&
        (pending.current.headingId !== undefined ||
          (pending.current.jumpThread && (pending.current.elementId || pending.current.threadId)))
      ) {
        scrollIntentAt.current = navigationCount.current;
        scrollIntentEpoch.current += 1;
      }
    }
    previous.current = {
      navigation: current.navigation,
      elementId: current.elementId,
      threadId: current.threadId,
      requested,
      entry: trail.entry,
    };
    const intent = pending.current;
    if (!intent || intent.navigation !== current.navigation) return;
    const complete = (capture = false) => {
      // A fulfilled jump no longer holds back the reading position; the epoch still stops retries in flight.
      // Completing it also bumps the epoch, so a restore that started before the jump finished stops. Only a
      // scrolling intent counts: completing an empty one at mount must not stop the restore.
      if (scrollIntentAt.current === navigationCount.current) {
        scrollIntentAt.current = -1;
        scrollIntentEpoch.current += 1;
      }
      pending.current = null;
      setThreadJump(undefined);
      if (capture) captureReadingPosition();
    };
    // Back/Forward owns its passage, folds and focus. Its URL target is only a fallback.
    if (intent.restoreEntry && !intent.elementId.startsWith("diff-")) {
      complete();
      return;
    }
    const opensThread =
      intent.jumpThread && !intent.reply && intent.threadId && intent.elementId === `thread-${intent.threadId}`;
    if (opensThread && intent.threadId) {
      if (threadJump?.token !== intent.token || threadJump.navigation !== current.navigation) {
        setThreadJump({ threadId: intent.threadId, token: intent.token, navigation: current.navigation });
        // Mount the destination's cards before fulfilling the scroll in the next commit.
        return;
      }
    } else if (threadJump) {
      setThreadJump(undefined);
      return;
    }
    if (!revision) return;
    if (docsVisible && !missingDoc && (search.doc !== openDoc?.path || search.view !== docView(openDoc, search.view))) {
      const next: ReviewSearch = { ...search, doc: openDoc?.path, view: docView(openDoc, search.view) };
      intent.navigation = readingIntent(next, hash, seq).navigation;
      replaceAddress(next, hash);
      return;
    }
    const thread = revision.threads.find((thread) => thread.id === intent.threadId);
    if (intent.routeThread) {
      if (intent.threadId && !thread) return;
      // Placement selects the destination once for this navigation, never on a refetch.
      intent.routeThread = false;
      setHtmlNavigation(undefined);
      if (thread?.target.kind === "source-lines" && (search.tab !== "comments" || search.thread)) {
        const location = thread.placement.status === "placed" ? thread.placement.location : undefined;
        const placed =
          location?.kind === "source-lines" &&
          revision.docs.find((doc) => doc.kind === "source" && doc.path === location.path && !doc.unrendered);
        const next: ReviewSearch = {
          ...search,
          tab: placed ? "docs" : "comments",
          doc: placed ? placed.path : search.doc,
          view: placed ? "source" : search.view,
        };
        const nextHash = `thread-${thread.id}`;
        intent.elementId = nextHash;
        if (search.tab !== next.tab || search.doc !== next.doc || search.view !== next.view || hash !== nextHash) {
          intent.navigation = readingIntent(next, nextHash, seq).navigation;
          replaceAddress(next, nextHash);
          return;
        }
      }
      if (thread?.target.kind === "html-span" && (search.tab !== "comments" || search.thread)) {
        const location = thread.placement.status === "placed" ? thread.placement.location : undefined;
        const placed =
          location?.kind === "html-span" &&
          revision.docs.some((doc) => doc.kind === "html" && doc.path === location.path);
        const next: ReviewSearch = {
          ...search,
          tab: placed ? "docs" : "comments",
          doc: placed ? (openDoc?.path ?? location.path) : search.doc,
          view: placed ? docView(undefined, search.view) : search.view,
        };
        const nextHash = `thread-${thread.id}`;
        intent.elementId = placed ? `html-doc-${location.path}` : nextHash;
        if (placed) intent.block = "start";
        intent.reply ||= !placed;
        if (placed) setHtmlNavigation({ threadId: thread.id, intent });
        if (search.tab !== next.tab || search.doc !== next.doc || search.view !== next.view || hash !== nextHash) {
          // The redirect continues this intent; it does not create another one.
          intent.navigation = readingIntent(next, nextHash, seq).navigation;
          replaceAddress(next, nextHash);
          return;
        }
      }
    }
    if (intent.headingId !== undefined && docsVisible && openDoc?.kind === "html") {
      const valid = /^(0|[1-9]\d*)$/.test(intent.headingId) && openDoc.headings?.[Number(intent.headingId)];
      setFailedHeading(valid ? undefined : current.navigation);
      complete();
      return;
    }
    if (intent.headingId !== undefined || missingDoc) {
      const scroller = document.querySelector<HTMLElement>("[data-reading-scroll]");
      if (!scroller || (docsVisible && !missingDoc && !openDoc)) return;
      const element =
        docsVisible && openDoc && scroller && intent.headingId !== undefined
          ? docHeading(scroller, openDoc, intent.headingId)
          : undefined;
      setFailedHeading(element ? undefined : current.navigation);
      if (element && openDoc) {
        revealReadingTarget(element);
        element.scrollIntoView?.({ block: "start" });
        element.tabIndex = -1;
        // The validated navigation target belongs to this entry; its focus event is not reader input.
        trail.entry.focus = { id: `h-${element.id}`, children: [] };
        focusReadingTarget(element);
      } else if (docsVisible && scroller) {
        scroller.scrollTop = 0;
      }
      complete(true);
      return;
    }
    if (!intent.elementId) {
      complete();
      return;
    }
    if (intent.reply) {
      if (!thread) return;
      complete();
      claimDraft(draftKey(review.id, thread.target, thread.id), search.tab === "docs" ? "reading" : "comments");
      return;
    }
    if (intent.elementId.startsWith("diff-")) {
      if (paneMode === "tabs" && hasDiff && tab !== "diff") {
        const next = { ...search, tab: "diff" as const };
        intent.navigation = readingIntent(next, hash, seq).navigation;
        replaceAddress(next, hash);
        return;
      }
      if (navigateDiff.current?.({ elementId: intent.elementId })) complete(intent.jumpThread);
      return;
    }
    const element = appElementId(intent.elementId) ? document.getElementById(intent.elementId) : null;
    if (!element) return;
    revealReadingTarget(element);
    element.scrollIntoView?.({ block: intent.block });
    complete(intent.jumpThread);
    if (element.hasAttribute("data-thread-card") && element.closest(".em-source")) {
      element.tabIndex = -1;
      element.focus({ preventScroll: true });
    }
  });
  const tabProps = {
    id: review.id,
    search: { ...search, tab },
    hasDocs,
    hasDiff,
    hasWriteup,
    compactDoc: openDoc?.kind === "markdown",
    threadCounts: revision ? threadCounts(revision.threads) : undefined,
    filesCount: diffFiles.length,
    viewedCount: diffFiles.filter((file) => file.viewed === "viewed").length,
  };
  const ready = Math.max(published, review.newestRevision);
  return (
    <AppFrame isReview onCommentReview={revision ? commentOnReview : undefined}>
      <div className="contents" onClickCapture={followReadingLink} onAuxClickCapture={followReadingLink}>
        <Panes
          inbox={<ReviewInbox collapsed={collapsed} onCollapsedChange={setCollapsed} />}
          tab={tab}
          hasDiff={hasDiff}
          hasWriteup={hasWriteup}
          readingLayout={docsVisible && openDoc?.kind === "html" ? "original" : undefined}
          phoneTabs={<PhoneTabs {...tabProps} />}
          tabs={<ReviewTabs {...tabProps} docsCount={revision?.docs.length ?? 0} idBase={readingId} />}
          sendBar={
            <SendBar
              key={review.id}
              reviewId={review.id}
              revision={revision?.seq}
              newestRevision={ready}
              revisionError={query.isError}
              unsentCount={review.unsentCount}
              approved={review.state === "approved"}
              agent={{
                agentWaiting: review.agentWaiting,
                pendingSend: review.pendingSend,
                pickedUpAt: review.pickedUpAt,
                releasedAt: review.releasedAt,
                newestRevision: review.newestRevision,
              }}
              lifecycle={{
                title: review.title,
                state: review.state,
                snoozed: review.snoozed,
                snoozedUntil: review.snoozedUntil,
                onDeleted: () => {
                  void navigate({ to: "/" }).then(() => {
                    client.removeQueries({ queryKey: ["review", review.id] });
                    client.removeQueries({ queryKey: ["revision", review.id] });
                  });
                },
              }}
              phone={layout === "phone"}
            />
          }
          header={
            <>
              {viewedErrors.errors.map((failure) => (
                <div key={failure.id} role="alert" className="px-4 py-2 text-danger-fg">
                  <p>
                    {failure.error && mutationMessage(failure.error)} <bdi>{failure.failedPaths?.[0]}</bdi>
                    {(failure.failedPaths?.length ?? 0) > 1 &&
                      ` and ${(failure.failedPaths?.length ?? 1) - 1} other files`}
                  </p>
                  <Button size="sm" variant="ghost" onClick={() => viewedErrors.dismiss(failure.id)}>
                    Dismiss
                  </Button>
                </div>
              ))}
              {(layout !== "phone" || tab !== "diff") && (
                <ReviewHeader
                  review={review}
                  revision={revision}
                  counts={diffCounts}
                  seq={seq}
                  ready={ready}
                  phone={layout === "phone"}
                  titleRef={titleRef}
                  onRevisionChange={setRevision}
                  onCommentReview={commentOnReview}
                />
              )}
            </>
          }
          reading={
            <div className="contents">
              <div
                className={docsVisible && openDoc?.kind === "html" ? "em-original-panel" : undefined}
                {...(layout !== "phone"
                  ? {
                      role: "tabpanel" as const,
                      id: `${readingId}-reading-panel`,
                      "aria-labelledby": `${readingId}-tab-${readingTab}`,
                    }
                  : {})}
              >
                {query.isPending && (
                  <p role="status" className="p-5">
                    Loading revision…
                  </p>
                )}
                {query.isError && (
                  <div className="p-5">
                    <p role="alert">Could not load this revision.</p>
                    <Button onClick={() => void query.refetch()}>Retry</Button>
                  </div>
                )}
                {(missingDoc || missingHeading) && (
                  <p role="status" className="px-4 py-2">
                    {missingDoc
                      ? "Document not found. Showing all docs."
                      : "Heading not found. Showing the top of the document."}
                  </p>
                )}
                {revision && (
                  <ReadingFoldContext value={readingFolds}>
                    {readingTab === "files" ? (
                      <Files
                        key={`${seq}:files`}
                        reviewId={review.id}
                        visible={paneMode === "split" || tab !== "diff" || !hasDiff}
                        revision={revision}
                        counts={diffCounts}
                        onViewed={onViewed}
                        onNavigate={(file) =>
                          navigateReading(
                            { ...search, tab: paneMode === "tabs" ? "diff" : "files", thread: undefined },
                            `diff-file-${file.id}`,
                          )
                        }
                      />
                    ) : (
                      <Reading
                        key={`${seq}:${readingTab}`}
                        reviewId={review.id}
                        revision={revision}
                        tab={readingTab}
                        visible={paneMode === "split" || tab !== "diff" || !hasDiff}
                        intentState={intentState}
                        entry={trail.entry}
                        returning={trail.returning}
                        headingTarget={currentIntent.headingId}
                        visit={requested?.token ?? currentIntent.navigation}
                        preservePosition={!trail.returning && currentIntent.elementId.startsWith("diff-")}
                        back={trail.back}
                        onHeading={onHeading}
                        search={search}
                        openDoc={openDoc}
                        targeted={!!hash || !!search.thread || (trail.returning && !!trail.entry.focus)}
                        activeThreadId={currentIntent.threadId}
                        threadJump={threadJump?.navigation === currentIntent.navigation ? threadJump : undefined}
                        onOpenDoc={(doc) =>
                          navigateReading(
                            {
                              ...search,
                              rev: seq,
                              tab: "docs",
                              doc: doc.path,
                              view: docView(doc, search.view),
                              thread: undefined,
                            },
                            "",
                            docsVisible && !!openDoc && docKey(doc) === docKey(openDoc),
                          )
                        }
                        phone={layout === "phone"}
                        onResume={resume}
                        htmlNavigation={htmlNavigation}
                        composingPath={resumed?.target?.kind === "html-span" ? resumed.target.path : undefined}
                        resumedBlockId={resumedBlockId}
                        onCurrentTopic={layout !== "phone" && hasDiff ? setCurrentTopic : undefined}
                        onNote={onNote}
                      />
                    )}
                  </ReadingFoldContext>
                )}
                {resumed?.target && !isDiffTarget(resumed.target) && (
                  <Composer
                    surface="resumed"
                    placeholder={false}
                    reviewId={review.id}
                    revision={seq}
                    target={resumed.target}
                    topics={revision?.topics}
                    threadId={resumed.threadId}
                    storageKey={resumed.key}
                    onSaved={endResume}
                    onCancel={endResume}
                    wrap={(editor) => (
                      <section aria-label="Resumed comment" className="sticky bottom-0 px-4 pt-4 pb-8 md:pr-8 md:pl-14">
                        {editor}
                      </section>
                    )}
                  />
                )}
              </div>
            </div>
          }
          diff={
            <div
              {...(layout !== "phone" && paneMode === "tabs"
                ? {
                    role: "tabpanel",
                    id: `${readingId}-diff-panel`,
                    "aria-labelledby": `${readingId}-tab-diff`,
                  }
                : {})}
            >
              {revision ? (
                <LazyDiffPane
                  key={seq}
                  reviewId={review.id}
                  revision={revision}
                  resume={resumed?.target && isDiffTarget(resumed.target) ? resumed : undefined}
                  onResumeEnd={endResume}
                  onRendered={onDiffRendered}
                  onNavigator={onDiffNavigator}
                  currentTopic={currentTopic}
                  writeupVisible={readingTab === "writeup" && paneMode === "split"}
                  search={search}
                  onViewed={onViewed}
                />
              ) : (
                <p role={query.isError ? "alert" : "status"} className="p-5">
                  {query.isError ? "Could not load this revision." : "Loading revision…"}
                </p>
              )}
            </div>
          }
        />
      </div>
    </AppFrame>
  );
}
/** A review in the bin keeps its address: say so, and offer Restore, the bin and the inbox. */
function BinNotice({ reviewId }: { reviewId: string }) {
  const client = useQueryClient();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const restore = async () => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    try {
      await change(`/api/v1/reviews/${encodeURIComponent(reviewId)}/restore`, "POST");
      await Promise.all([
        client.invalidateQueries({ queryKey: ["review", reviewId] }),
        client.invalidateQueries({ queryKey: ["revision", reviewId] }),
        client.invalidateQueries({ queryKey: ["inbox"] }),
        client.invalidateQueries({ queryKey: ["bin"] }),
      ]);
    } catch (error) {
      toast.show({ tone: "danger", title: mutationMessage(error as Error) });
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  return (
    <AppFrame isReview>
      <main className="flex flex-col items-start gap-3 p-5">
        <p role="status">This review is in the bin.</p>
        <Button variant="primary" loading={pending} onClick={() => void restore()}>
          Restore
        </Button>
        <Link to="/settings">Open the bin</Link>
        <Link to="/">Back to the inbox</Link>
      </main>
    </AppFrame>
  );
}
export function ReviewPage() {
  const { reviewId } = useParams({ from: "/r/$reviewId" });
  const query = useQuery(reviewQuery(reviewId));
  const published = usePublishedRevision(reviewId);
  const [collapsed, setCollapsed] = useInboxCollapsed();
  const previousReviewId = useRef(reviewId);
  const pendingFocus = useRef(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (previousReviewId.current !== reviewId) {
      previousReviewId.current = reviewId;
      pendingFocus.current = true;
    }
    if (query.isError && !query.data) pendingFocus.current = false;
    if (pendingFocus.current && query.data?.id === reviewId) {
      pendingFocus.current = false;
      titleRef.current?.focus();
    }
  }, [reviewId, query.data, query.isError]);
  // A refetch that answers 404 keeps the old data, so this check comes first.
  if (query.error instanceof ApiError && query.error.status === 404 && query.error.code === "unknown_review")
    return (
      <AppFrame isReview>
        <main className="p-5">
          <p role="status">This review was deleted or never existed.</p>
          <Link to="/">Back to the inbox</Link>
        </main>
      </AppFrame>
    );
  // Same reason: a refetch that answers 409 keeps the old data.
  if (query.error instanceof ApiError && query.error.status === 409 && query.error.code === "review_in_bin")
    return <BinNotice reviewId={reviewId} />;
  if (query.data)
    return (
      <LoadedReview
        key={reviewId}
        routeId={reviewId}
        review={query.data}
        published={published}
        titleRef={titleRef}
        collapsed={collapsed}
        setCollapsed={setCollapsed}
      />
    );
  return (
    <AppFrame isReview>
      <main className="p-5">
        {query.isError ? (
          <>
            <p role="alert">Could not load this review.</p>
            <Button onClick={() => void query.refetch()}>Retry</Button>
          </>
        ) : (
          <p role="status">Loading review…</p>
        )}
      </main>
    </AppFrame>
  );
}
