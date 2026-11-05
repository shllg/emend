import type { RevisionView } from "@emend/contract";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  ChevronRight,
  FileCode,
  Files,
  FileText,
  LayoutList,
  List,
  MessageSquare,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { docFilename, docTitle } from "../../lib/doc-navigation.ts";
import type { DocNavigation, HtmlPosition } from "../../lib/frame-messages.ts";
import { focusReadingTarget } from "../../lib/reading-focus.ts";
import { readingPositionKey } from "../../lib/reading-position.ts";
import type { ReadingEntry } from "../../lib/use-reading-trail.ts";
import type { ReviewSearch } from "../../router.tsx";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { BlockReader, type ReaderGroup, type ReaderProps } from "./BlockReader.tsx";
import { DocContents, useCurrentHeading } from "./DocContents.tsx";
import { HtmlDocFrame, type HtmlNavigation } from "./HtmlDocFrame.tsx";
import { ReadingMenu } from "./ReadingMenu.tsx";

export function DocView({
  docs,
  openDoc,
  search,
  targeted,
  onOpenDoc,
  navigation,
  composingPath,
  onHeading = () => {},
  back,
  entry,
  returning = false,
  headingTarget,
  visit,
  ...props
}: ReaderProps & {
  entry?: ReadingEntry;
  returning?: boolean;
  headingTarget?: string;
  visit?: unknown;
  docs: RevisionView["docs"];
  openDoc?: RevisionView["docs"][number];
  search: ReviewSearch;
  targeted: boolean;
  onOpenDoc: (path: string) => void;
  navigation?: HtmlNavigation;
  composingPath?: string;
  onHeading?: (id: string) => void;
  back?: { title: string; go: () => void };
}) {
  const root = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = bar.current;
    if (!element || !openDoc?.path) return;
    const resize = new ResizeObserver(() => {
      const height = element.getBoundingClientRect().height;
      if (height) root.current?.style.setProperty("--doc-bar-height", `${height}px`);
    });
    resize.observe(element);
    return () => resize.disconnect();
  }, [openDoc?.path]);
  const [filter, setFilter] = useState("");
  const markdownHeading = useCurrentHeading(root, openDoc);
  const [htmlHeading, setHtmlHeading] = useState<{ path: string; heading: number | null }>();
  const [commentsOpen, setCommentsOpen] = useState(false);
  const commentsButton = useRef<HTMLButtonElement>(null);
  const onPosition = useCallback(
    (position: HtmlPosition) => {
      if (openDoc) setHtmlHeading({ path: openDoc.path, heading: position.heading });
    },
    [openDoc],
  );
  const currentHeading =
    openDoc?.kind === "html"
      ? htmlHeading?.path === openDoc.path && htmlHeading.heading !== null
        ? String(htmlHeading.heading)
        : undefined
      : markdownHeading;
  const headings = useMemo(
    () =>
      openDoc?.kind === "html"
        ? (openDoc.headings ?? []).map((heading, index) => ({ ...heading, id: String(index) }))
        : (openDoc?.headings?.filter((heading) => heading.id) ?? []),
    [openDoc],
  );
  const frameReading = useMemo(
    () =>
      entry && openDoc
        ? {
            key: readingPositionKey(props.reviewId, "docs", openDoc.path, props.revision, search.view ?? "original"),
            entry,
            returning,
            target: headingTarget,
            visit,
          }
        : undefined,
    [entry, openDoc, props.reviewId, props.revision, search.view, returning, headingTarget, visit],
  );
  const commentCount = props.threads.filter(
    (thread) =>
      thread.state !== "resolved" &&
      (thread.placement.status === "placed" && "path" in thread.placement.location
        ? thread.placement.location.path === openDoc?.path
        : "path" in thread.target && thread.target.path === openDoc?.path),
  ).length;
  const hasContents = headings.length >= 3;
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const rows = useRef(new Map<string, HTMLAnchorElement>());
  const previous = useRef<{ path?: string; doc?: string } | null>(null);
  const [destination, setDestination] = useState<DocNavigation>();
  const path = openDoc?.path;
  useEffect(() => {
    const last = previous.current;
    previous.current = { path, doc: search.doc };
    if (last && last.path !== path) setCommentsOpen(false);
    if (last && path === last.path) return;
    const focusNavigation = last && last.doc !== search.doc && !targeted;
    setDestination((current) => (current?.path === path ? current : undefined));
    if (path) {
      if (focusNavigation) focusReadingTarget(heading.current);
    } else if (last?.path && focusNavigation) {
      const row = rows.current.get(last.path);
      focusReadingTarget(row);
      row?.scrollIntoView?.({ block: "nearest" });
    }
  }, [path, search.doc, targeted]);
  const follow = (next: DocNavigation) => {
    const doc = docs.find((doc) => doc.path === next.path);
    if (!doc || doc.path === path) return;
    setDestination(doc.kind === "html" && next.fragment ? next : undefined);
    onOpenDoc(doc.path);
  };
  const content =
    openDoc?.kind === "html" ? (
      <HtmlDocFrame
        key={openDoc.contentUrl}
        {...props}
        path={openDoc.path}
        contentUrl={openDoc.contentUrl}
        navigation={navigation}
        docNavigation={destination?.path === openDoc.path ? destination : undefined}
        onNavigate={follow}
        composerOpen={composingPath === openDoc.path}
        headings={openDoc.headings}
        docPaths={docs.map((doc) => doc.path)}
        reading={frameReading}
        onPosition={onPosition}
        commentsOpen={commentsOpen}
        onCommentsOpenChange={setCommentsOpen}
        returnFocus={() => commentsButton.current}
      />
    ) : undefined;
  const groups = useMemo<ReaderGroup[]>(
    () =>
      openDoc
        ? [
            {
              key: openDoc.path,
              id: `doc-${openDoc.path}`,
              labelledBy: headingId,
              path: openDoc.path,
              blocks: openDoc.kind === "markdown" ? openDoc.blocks : [],
              content,
            },
          ]
        : [],
    [openDoc, headingId, content],
  );
  if (!openDoc)
    return (
      <>
        <h2 className="sr-only">Docs</h2>
        <ul className="flex flex-col gap-2 p-4">
          {docs.map((doc) => {
            const title = docTitle(doc);
            return (
              <li key={doc.path}>
                <Link
                  ref={(node) => {
                    if (node) rows.current.set(doc.path, node);
                    else rows.current.delete(doc.path);
                  }}
                  to="/r/$reviewId"
                  params={{ reviewId: props.reviewId }}
                  search={{ ...search, tab: "docs", doc: doc.path, thread: undefined }}
                  hash=""
                  className="em-doc-row grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-lg border border-line-1 bg-surface px-3.5 py-3 text-fg-2 no-underline hover:border-line-2 hover:bg-sunken"
                >
                  <Icon icon={doc.kind === "html" ? FileCode : FileText} size={18} />
                  <span className="flex min-w-0 flex-col gap-[3px]">
                    <span dir="auto" className="truncate font-sans text-14 leading-[1.3] font-semibold text-fg-1">
                      {title}
                    </span>
                    <span dir="auto" className="em-doc-path truncate font-stretch-mono text-fg-3">
                      {doc.path}
                    </span>
                  </span>
                  <Icon icon={ChevronRight} size={16} />
                </Link>
              </li>
            );
          })}
        </ul>
      </>
    );
  return (
    <div
      ref={root}
      className="em-doc-view"
      data-layout={openDoc.kind === "html" ? "original" : undefined}
      data-contents={hasContents ? "" : undefined}
    >
      <div ref={bar} className="em-doc-bar sticky z-(--z-sticky) border-b border-line-1 bg-surface">
        <div className="em-doc-title">
          <h2 ref={heading} id={headingId} title={openDoc.path} tabIndex={-1} dir="auto">
            {docTitle(openDoc)}
          </h2>
          <div className="em-doc-path" dir="auto">
            {docFilename(openDoc, docs)}
          </div>
        </div>
        <div className="em-doc-controls">
          {back && (
            <Button variant="ghost" className="em-doc-control" aria-label={`Back to ${back.title}`} onClick={back.go}>
              <Icon icon={ArrowLeft} />
              <span className="em-doc-control-label" dir="auto">
                Back to {back.title}
              </span>
            </Button>
          )}
          {docs.length > 1 && (
            <ReadingMenu label="Docs" icon={Files}>
              {(pick) => (
                <>
                  {docs.length > 8 && (
                    <input
                      className="em-doc-filter"
                      aria-label="Filter docs"
                      value={filter}
                      onChange={(event) => setFilter(event.target.value)}
                    />
                  )}
                  <ul className="em-doc-options">
                    {docs
                      .filter((doc) => `${docTitle(doc)} ${doc.path}`.toLowerCase().includes(filter.toLowerCase()))
                      .map((doc) => {
                        const count = props.threads.filter(
                          (thread) =>
                            thread.state !== "resolved" &&
                            ((thread.placement.status === "placed" &&
                              "path" in thread.placement.location &&
                              thread.placement.location.path === doc.path) ||
                              (thread.placement.status !== "placed" &&
                                "path" in thread.target &&
                                thread.target.path === doc.path)),
                        ).length;
                        return (
                          <li key={doc.path}>
                            <button
                              type="button"
                              aria-current={doc.path === openDoc.path ? "page" : undefined}
                              onClick={() =>
                                pick(() => {
                                  setFilter("");
                                  onOpenDoc(doc.path);
                                  if (doc.path === openDoc.path) focusReadingTarget(heading.current);
                                })
                              }
                            >
                              <span>
                                <span dir="auto">{docTitle(doc)}</span>
                                <small dir="auto">{docFilename(doc, docs)}</small>
                              </span>
                              <span>
                                {count} open {count === 1 ? "comment" : "comments"}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                  </ul>
                </>
              )}
            </ReadingMenu>
          )}
          {openDoc.kind === "html" && (
            <Button
              ref={commentsButton}
              variant="ghost"
              className="em-doc-control"
              aria-label={`Comments (${commentCount})`}
              aria-haspopup="dialog"
              aria-expanded={commentsOpen}
              onClick={() => setCommentsOpen(true)}
            >
              <Icon icon={MessageSquare} />
              <span className="em-doc-control-label">Comments ({commentCount})</span>
            </Button>
          )}
          {hasContents && (
            <span className="em-doc-contents-control">
              <ReadingMenu label="Contents" icon={List}>
                {(pick) => (
                  <DocContents
                    headings={headings}
                    current={currentHeading}
                    onPick={(id) => pick(() => onHeading(id))}
                  />
                )}
              </ReadingMenu>
            </span>
          )}
          {docs.length > 1 && (
            <Button asChild variant="ghost" className="em-doc-control">
              <Link
                to="/r/$reviewId"
                aria-label="All docs"
                params={{ reviewId: props.reviewId }}
                search={{ ...search, tab: "docs", doc: undefined, thread: undefined }}
                hash=""
              >
                <Icon icon={LayoutList} />
                <span className="em-doc-control-label">All docs</span>
              </Link>
            </Button>
          )}
        </div>
        {openDoc.kind === "html" && (
          <p className="flex items-center gap-1.5 text-fg-3 [font:var(--type-meta)]">
            <Icon icon={ShieldCheck} size={13} />
            Sandboxed, scripts off
          </p>
        )}
      </div>
      <div className="em-doc-body" data-reading-doc={openDoc.path}>
        {openDoc.kind === "html" ? content : <BlockReader key={openDoc.path} {...props} groups={groups} />}
        {hasContents && (
          <aside className="em-doc-contents-rail">
            <DocContents headings={headings} current={currentHeading} onPick={onHeading} />
          </aside>
        )}
      </div>
    </div>
  );
}
