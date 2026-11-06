import type { AgentNoteView, FileView, RevisionView, Target, ThreadView } from "@emend/contract";
import type {
  DiffLineAnnotation,
  FileDiffMetadata,
  FileDiffOptions,
  GetHoveredLineResult,
  SelectedLineRange,
} from "@pierre/diffs";
import { FileDiff as PierreFileDiff, WorkerPoolContextProvider } from "@pierre/diffs/react";
import DiffWorker from "@pierre/diffs/worker/worker.js?worker";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { splitLines } from "../../../../../packages/core/src/place/linemap.ts";
import { getText } from "../../api/client.ts";
import { plural } from "../../lib/count.ts";
import { diffLoads } from "../../lib/diff-loads.ts";
import { linesErrorMessage } from "../../lib/line-context.ts";
import { useStickyHeight } from "../../lib/sticky-stack.ts";
import { Composer } from "../threads/Composer.tsx";
import { ThreadCard } from "../threads/ThreadCard.tsx";
import { Button } from "../ui/Button.tsx";
import { AgentNoteCard } from "./AgentNoteCard.tsx";
import { annotationExpansions } from "./annotation-expansion.ts";
import { CommentLinesContext, createCommentLines } from "./comment-lines.ts";
import { FileHeader } from "./FileHeader.tsx";
import { GutterComment } from "./GutterComment.tsx";
import { LineComposer } from "./LineComposer.tsx";
import { linesTarget } from "./linesTarget.ts";
import { type DiffParser, parseOffThread } from "./parse-client.ts";
import { type DiffCounts, type DiffStyle, diffCounts } from "./presentation.ts";
import { diffShadowCSS } from "./shadow.ts";
import type { FileLocation } from "./targets.ts";
import { diffTheme } from "./theme.ts";

export type ParsedDiff = FileDiffMetadata;
export type DiffPostRender = NonNullable<FileDiffOptions<ReactElement, undefined>["onPostRender"]>;
type Annotation = DiffLineAnnotation<ReactElement> & { startLine?: number };
type BodyState = { diff?: ParsedDiff; blocked: boolean; loading?: boolean };
type SlotState = { names: Set<string>; rendered: boolean };
// Highlighting costs about 0.09 ms per line, so a 5000-line file takes about half a second on either path.
export const TOKENIZE_MAX_LINES = 5000;
const poolOptions = { workerFactory: () => new DiffWorker(), poolSize: 2 };
const highlighterOptions = {
  theme: diffTheme.name,
  preferredHighlighter: "shiki-js" as const,
  tokenizeMaxLineLength: 1000,
};
// Pierre skips highlighting when either side of the whole file has more lines than the cap.
export function HighlightNote({ diff }: { diff: ParsedDiff }) {
  const lines = Math.max(diff.additionLines.length, diff.deletionLines.length);
  if (lines <= TOKENIZE_MAX_LINES) return null;
  return (
    <p className="em-diff-summary">
      Not highlighted: {lines.toLocaleString("en-US")} lines is over {TOKENIZE_MAX_LINES.toLocaleString("en-US")}.
    </p>
  );
}
export function DiffWorkers({ children, workerFactory }: { children: ReactNode; workerFactory?: () => Worker }) {
  const pool = useMemo(() => (workerFactory ? { ...poolOptions, workerFactory } : poolOptions), [workerFactory]);
  return (
    <WorkerPoolContextProvider poolOptions={pool} highlighterOptions={highlighterOptions}>
      {children}
    </WorkerPoolContextProvider>
  );
}
export function DiffView({
  fileDiff,
  diffStyle,
  overflow = "scroll",
  annotations,
  onSelect,
  selected,
  onSlots,
}: {
  fileDiff: ParsedDiff;
  diffStyle: "split" | "unified";
  overflow?: "scroll" | "wrap";
  annotations: Annotation[];
  onSelect: (range: SelectedLineRange | null) => void;
  selected: SelectedLineRange | null;
  onSlots?: (slots: SlotState) => void;
}) {
  const [commentLines] = useState(createCommentLines);
  const hoveredLine = useRef<GetHoveredLineResult<"diff"> | undefined>(undefined);
  const expansionState = useRef<{
    instance: Parameters<DiffPostRender>[1];
    diff: ParsedDiff;
    counts: Map<string, number>;
  } | null>(null);
  // Pierre rebuilds a file's diff whenever an option or the annotations array changes by
  // reference. Hand it stable options and a positions-only array; the callbacks read the
  // latest props through this ref, assigned during render because Pierre's own layout
  // effect (which runs before this component's) can call them.
  const latest = useRef({ fileDiff, annotations, onSelect, onSlots });
  latest.current = { fileDiff, annotations, onSelect, onSlots };
  const onPostRender = useCallback<DiffPostRender>(
    (node, instance, phase) => {
      const { fileDiff, annotations, onSlots } = latest.current;
      commentLines.postRender(node, instance, phase);
      if (phase === "unmount") expansionState.current = null;
      // The initial mount callback can precede async rendering. Once code exists,
      // Pierre has committed its annotation slots in the same render as the lines.
      const rendered = phase !== "unmount" && !!node.shadowRoot?.querySelector("[data-line]");
      if (rendered) {
        if (expansionState.current?.instance !== instance || expansionState.current.diff !== fileDiff)
          expansionState.current = { instance, diff: fileDiff, counts: new Map() };
        const counts = expansionState.current.counts;
        const pending = [];
        for (const [key, expansion] of annotationExpansions(fileDiff, annotations)) {
          const previous = counts.get(key) ?? 0;
          if (expansion.count <= previous) continue;
          // Record before expanding: an unmanaged instance can render synchronously.
          counts.set(key, expansion.count);
          pending.push({ ...expansion, count: expansion.count - previous });
        }
        for (const { index, direction, count } of pending) instance.expandHunk(index, direction, count);
      }
      onSlots?.({
        rendered,
        names: new Set(
          [...(rendered ? (node.shadowRoot?.querySelectorAll('slot[name^="annotation-"]') ?? []) : [])].map(
            (slot) => slot.getAttribute("name") ?? "",
          ),
        ),
      });
    },
    [commentLines],
  );
  const stableSelect = useCallback((range: SelectedLineRange | null) => latest.current.onSelect(range), []);
  const options = useMemo<FileDiffOptions<string, undefined>>(
    () => ({
      preferredHighlighter: "shiki-js",
      tokenizeMaxLength: TOKENIZE_MAX_LINES,
      diffStyle,
      theme: diffTheme.name,
      themeType: "system",
      lineDiffType: "word",
      diffIndicators: "classic",
      hunkSeparators: "line-info",
      lineHoverHighlight: "both",
      enableGutterUtility: true,
      onLineEnter: ({ lineNumber, annotationSide, numberElement }) => {
        hoveredLine.current = { lineNumber, side: annotationSide };
        // 1.6.1 pins the utility to a selection's end. This pointer affordance
        // belongs to the hovered row even while another composer is open.
        const root = numberElement.getRootNode();
        const utility = root instanceof ShadowRoot ? root.querySelector("[data-gutter-utility-slot]") : null;
        if (utility) numberElement.append(utility);
      },
      onLineLeave: () => {
        hoveredLine.current = undefined;
      },
      unsafeCSS: diffShadowCSS,
      overflow,
      disableFileHeader: true,
      enableLineSelection: true,
      expandUnchanged: false,
      onLineSelectionEnd: stableSelect,
      onPostRender: onPostRender as unknown as FileDiffOptions<string, undefined>["onPostRender"],
    }),
    [diffStyle, overflow, stableSelect, onPostRender],
  );
  // Positions only: the array changes when an annotation is added, removed or moved,
  // not when a card's content changes.
  // FileBody groups to one annotation per side and line; on a duplicate key the last one wins.
  const unique = [...new Map(annotations.map((a) => [`${a.side}-${a.lineNumber}`, a])).values()];
  const positionKey = JSON.stringify(unique.map((a) => [a.side, a.lineNumber, a.startLine ?? null]));
  // biome-ignore lint/correctness/useExhaustiveDependencies: positionKey encodes exactly the fields read.
  const positions = useMemo<DiffLineAnnotation<string>[]>(
    () =>
      unique.map((a) => ({
        side: a.side,
        lineNumber: a.lineNumber,
        startLine: a.startLine,
        metadata: `${a.side}-${a.lineNumber}`,
      })),
    [positionKey],
  );
  const content = new Map<string, ReactElement>();
  for (const { side, lineNumber, metadata } of unique) content.set(`${side}-${lineNumber}`, metadata);
  // biome-ignore lint/correctness/useExhaustiveDependencies: compared by value, not reference.
  const selection = useMemo(
    () => (selected ? { ...selected } : null),
    [selected?.side, selected?.endSide, selected?.start, selected?.end],
  );
  return (
    <div className="em-diff-code">
      <CommentLinesContext value={commentLines}>
        <PierreFileDiff<string>
          className="em-diff-host"
          style={{ colorScheme: "inherit" }}
          fileDiff={fileDiff}
          options={options}
          selectedLines={selection}
          lineAnnotations={positions}
          renderAnnotation={(annotation) => content.get(annotation.metadata)}
          renderGutterUtility={(getHoveredLine) => (
            <GutterComment getHoveredLine={() => hoveredLine.current ?? getHoveredLine()} onSelect={stableSelect} />
          )}
        />
      </CommentLinesContext>
    </div>
  );
}
const lockfiles = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "composer.lock",
  "go.sum",
  "flake.lock",
  "pubspec.lock",
  "mix.lock",
  "Podfile.lock",
]);
export type DiffContext = {
  reviewId: string;
  revision: number;
  threads: ThreadView[];
  changedBlocks: RevisionView["changedBlocks"];
  topics?: RevisionView["topics"];
  active: Target | null;
  onActive: (target: Target | null) => void;
  parser?: DiffParser;
  fileForTarget: (target: FileLocation) => FileView | undefined;
  diffStyle: DiffStyle;
  overflow?: "scroll" | "wrap";
  counts: Map<string, DiffCounts>;
  notes?: boolean;
  onParsed: (id: string, counts: DiffCounts) => void;
  onViewed?: (paths: string[], viewed: boolean) => void;
  collapsedFiles: Set<string>;
  toggleFile: (id: string) => void;
  revealedFile?: string;
  onContentRendered: () => void;
};
export function FileDiff({
  file,
  topicCollapsed,
  ...context
}: DiffContext & { file: FileView; topicCollapsed: boolean }) {
  const ref = useRef<HTMLElement>(null);
  const header = useRef<HTMLElement>(null);
  // Lines and threads below this sticky header scroll to the bottom of the stack, not under it.
  useStickyHeight(header, ref, "--em-file-height");
  const [near, setNear] = useState(false);
  const [viewportKnown, setViewportKnown] = useState(false);
  const loads = diffLoads(useQueryClient());
  const [height, setHeight] = useState(200);
  const [expanded, setExpanded] = useState(false);
  const [slotState, setSlots] = useState<SlotState>({ names: new Set(), rendered: false });
  const slots = slotState.names;
  const [bodyState, setBodyState] = useState<BodyState>({ blocked: false });
  const onBodyState = useCallback((next: BodyState) => {
    setBodyState((previous) =>
      previous.diff === next.diff && previous.blocked === next.blocked && previous.loading === next.loading
        ? previous
        : next,
    );
  }, []);
  const onSlots = useCallback(
    (next: SlotState) =>
      setSlots((previous) =>
        previous.rendered === next.rendered &&
        previous.names.size === next.names.size &&
        [...previous.names].every((name) => next.names.has(name))
          ? previous
          : next,
      ),
    [],
  );
  const lineThreads = context.threads.flatMap((thread) => {
    if (thread.placement.status !== "placed") return [];
    const location = thread.placement.location;
    return location.kind === "lines" && context.fileForTarget(location)?.id === file.id ? [{ thread, location }] : [];
  });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        if (!entry.isIntersecting) setHeight(Math.max(200, element.getBoundingClientRect().height));
        setNear(entry.isIntersecting);
        setViewportKnown(true);
      },
      { root: element.closest("[data-diff-scroll]"), rootMargin: "800px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const fileThreads = context.threads.filter(
    (thread) =>
      thread.placement.status === "placed" &&
      thread.placement.location.kind === "file" &&
      context.fileForTarget(thread.placement.location)?.id === file.id,
  );
  const close = () => context.onActive(null);
  const active = context.active;
  const selected = active?.kind === "lines" && context.fileForTarget(active)?.id === file.id ? active : null;
  const mounted = near || !!selected || context.revealedFile === file.id;
  const lockfile = lockfiles.has(file.path.split("/").at(-1) ?? "");
  const collapsed = context.collapsedFiles.has(file.id);
  const { onContentRendered } = context;
  const foreground =
    !collapsed &&
    !topicCollapsed &&
    !file.flag &&
    (!lockfile || expanded) &&
    (!viewportKnown || (mounted && (bodyState.loading ?? true)));
  useLayoutEffect(() => (foreground ? loads.hold() : undefined), [foreground, loads]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Navigation retries after the fallback or annotation DOM commits.
  useEffect(() => onContentRendered(), [onContentRendered, slotState, bodyState, mounted, expanded]);
  const slotPending = (side: "old" | "new", end: number) => {
    if (file.flag || (lockfile && !expanded) || bodyState.blocked || slotState.rendered) return false;
    const diff = bodyState.diff;
    // The parser uses complete contents; per-region expansion exposes annotations.
    // Identical files (no hunks) and out-of-range lines have permanent fallbacks.
    return (
      !diff ||
      (diff.hunks.length > 0 && end > 0 && end <= (side === "old" ? diff.deletionLines : diff.additionLines).length)
    );
  };
  return (
    <section
      ref={ref}
      data-diff-section
      data-diff-file
      aria-label={`File ${file.path}`}
      className="em-diff-file"
      style={{ minHeight: collapsed || topicCollapsed || mounted || file.flag ? undefined : height }}
    >
      <FileHeader
        ref={header}
        file={file}
        collapsed={collapsed}
        counts={context.counts.get(file.id)}
        threads={fileThreads.length + lineThreads.length}
        onToggle={() => context.toggleFile(file.id)}
        onComment={() => context.onActive({ kind: "file", path: file.path })}
        onViewed={context.onViewed}
      />
      <div className="em-diff-discussion">
        {context.notes !== false &&
          file.notes
            ?.filter((note) => !slots.has(`annotation-${note.side === "old" ? "deletions" : "additions"}-${note.end}`))
            .map((note) => (
              <div key={note.id} data-slot-pending={slotPending(note.side, note.end) || undefined}>
                <AgentNoteCard file={file} note={note} onComment={context.onActive} />
              </div>
            ))}
        {active?.kind === "file" && context.fileForTarget(active)?.id === file.id && (
          <Composer
            surface="diff"
            reviewId={context.reviewId}
            revision={context.revision}
            target={active}
            topics={context.topics}
            onSaved={close}
            onCancel={close}
          />
        )}
        {fileThreads.map((thread) => (
          <ThreadCard surface="diff" key={thread.id} {...context} thread={thread} />
        ))}
        {lineThreads
          .filter(
            ({ location }) =>
              !slots.has(`annotation-${location.side === "old" ? "deletions" : "additions"}-${location.end}`),
          )
          .map(({ thread, location }) => (
            <div key={thread.id} data-slot-pending={slotPending(location.side, location.end) || undefined}>
              <ThreadCard surface="diff" {...context} thread={thread} />
            </div>
          ))}
      </div>
      {selected && !slots.has(`annotation-${selected.side === "old" ? "deletions" : "additions"}-${selected.end}`) && (
        <div data-slot-pending={slotPending(selected.side, selected.end) || undefined}>
          <LineComposer
            reviewId={context.reviewId}
            revision={context.revision}
            target={selected}
            topics={context.topics}
            onSaved={close}
            onCancel={close}
          />
        </div>
      )}
      {(collapsed || topicCollapsed) && !file.flag && !lockfile && !context.counts.has(file.id) && (
        <FileCounts file={file} parser={context.parser} onParsed={context.onParsed} />
      )}
      {!collapsed && !topicCollapsed && (
        <div className="em-diff-body">
          {file.flag ? (
            <p className="em-diff-summary">
              {file.flag === "binary" ? "Not shown: binary file" : "Not shown: larger than 1 MiB"}
            </p>
          ) : lockfile && !expanded ? (
            <Summary text="Collapsed: lockfile" onExpand={() => setExpanded(true)} />
          ) : mounted ? (
            <FileBody
              {...context}
              file={file}
              expanded={expanded}
              slots={slots}
              onSlots={onSlots}
              onBodyState={onBodyState}
              onExpand={() => setExpanded(true)}
            />
          ) : (
            <p className="em-diff-summary">Loads near viewport</p>
          )}
        </div>
      )}
    </section>
  );
}
function Summary({ text, onExpand }: { text: string; onExpand: () => void }) {
  return (
    <div className="em-diff-summary">
      <p>{text}</p>
      <Button size="sm" variant="ghost" onClick={onExpand}>
        Show diff
      </Button>
    </div>
  );
}
function fileSideQuery(file: FileView, side: "old" | "new") {
  return {
    queryKey: ["file", file.id, side],
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      getText(`/api/v1/files/${encodeURIComponent(file.id)}/${side}`, signal),
    staleTime: Infinity,
  };
}
function parsedFileQuery(file: FileView, old: string, next: string, parser: DiffParser | undefined) {
  return {
    queryKey: ["file-diff", file.id],
    staleTime: Infinity,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      (parser ?? parseOffThread)(
        {
          oldFile: file.hasOld ? { name: file.oldPath ?? file.path, contents: old, cacheKey: `${file.id}:old` } : null,
          newFile: file.hasNew ? { name: file.path, contents: next, cacheKey: `${file.id}:new` } : null,
        },
        signal,
      ),
  };
}
function useParsedFile(
  file: FileView,
  parser: DiffParser | undefined,
  expanded: boolean,
  onParsed: DiffContext["onParsed"],
) {
  const old = useQuery({ ...fileSideQuery(file, "old"), enabled: file.hasOld });
  const next = useQuery({ ...fileSideQuery(file, "new"), enabled: file.hasNew });
  const ready = (!file.hasOld || old.isSuccess) && (!file.hasNew || next.isSuccess);
  const lines = ready ? splitLines(old.data ?? "").length + splitLines(next.data ?? "").length : 0;
  const collapsed = !expanded && lines > 20000;
  const parsed = useQuery({
    ...parsedFileQuery(file, old.data ?? "", next.data ?? "", parser),
    enabled: ready && !collapsed,
  });
  useEffect(() => {
    if (parsed.data) onParsed(file.id, diffCounts(parsed.data));
  }, [file.id, parsed.data, onParsed]);
  return { old, next, parsed, collapsed, lines };
}
function FileCounts({ file, parser, onParsed }: Pick<DiffContext, "parser" | "onParsed"> & { file: FileView }) {
  const client = useQueryClient();
  const { data } = useQuery({
    queryKey: ["file-counts", file.id],
    staleTime: Infinity,
    queryFn: ({ signal }) =>
      diffLoads(client).run(signal, async () => {
        const old = file.hasOld ? await client.fetchQuery(fileSideQuery(file, "old")) : "";
        signal.throwIfAborted();
        const next = file.hasNew ? await client.fetchQuery(fileSideQuery(file, "new")) : "";
        signal.throwIfAborted();
        if (splitLines(old).length + splitLines(next).length > 20000) return null;
        const parsed = await client.fetchQuery(parsedFileQuery(file, old, next, parser));
        return diffCounts(parsed);
      }),
  });
  useEffect(() => {
    if (data) onParsed(file.id, data);
  }, [data, file.id, onParsed]);
  return null;
}
function FileBody({
  file,
  expanded,
  onExpand,
  slots,
  onSlots,
  onBodyState,
  ...context
}: DiffContext & {
  file: FileView;
  expanded: boolean;
  slots: Set<string>;
  onSlots: (slots: SlotState) => void;
  onBodyState: (state: BodyState) => void;
  onExpand: () => void;
}) {
  const { old, next, parsed, collapsed, lines } = useParsedFile(file, context.parser, expanded, context.onParsed);
  const loading = !old.isError && !next.isError && !parsed.isError && !collapsed && !parsed.isSuccess;
  useEffect(() => {
    onBodyState({ diff: parsed.data, blocked: collapsed, loading });
  }, [onBodyState, parsed.data, collapsed, loading]);
  const [error, setError] = useState("");
  const active = context.active;
  const selected = active?.kind === "lines" && context.fileForTarget(active)?.id === file.id ? active : null;
  const onSelect = (range: SelectedLineRange | null) => {
    setError("");
    if (!range) {
      context.onActive(null);
      return;
    }
    if (!range.side || (range.endSide && range.endSide !== range.side)) {
      context.onActive(null);
      setError("Select lines on one side.");
      return;
    }
    const side = range.side === "deletions" ? "old" : "new";
    const result = linesTarget(
      file,
      side,
      Math.min(range.start, range.end),
      Math.max(range.start, range.end),
      (side === "old" ? old.data : next.data) ?? "",
    );
    if ("error" in result) {
      context.onActive(null);
      setError(linesErrorMessage(result.error));
    } else context.onActive(result);
  };
  const grouped = new Map<
    string,
    {
      side: "deletions" | "additions";
      lineNumber: number;
      startLine?: number;
      threads: ThreadView[];
      notes: AgentNoteView[];
    }
  >();
  for (const note of context.notes === false ? [] : (file.notes ?? [])) {
    const side = note.side === "old" ? "deletions" : "additions";
    const key = `annotation-${side}-${note.end}`;
    const group = grouped.get(key) ?? { side, lineNumber: note.end, startLine: note.start, threads: [], notes: [] };
    group.startLine = Math.min(group.startLine ?? note.start, note.start);
    group.notes.push(note);
    grouped.set(key, group);
  }
  for (const thread of context.threads) {
    if (thread.placement.status !== "placed") continue;
    const location = thread.placement.location;
    if (location.kind !== "lines" || context.fileForTarget(location)?.id !== file.id) continue;
    const side = location.side === "old" ? "deletions" : "additions";
    const key = `annotation-${side}-${location.end}`;
    const group = grouped.get(key) ?? { side, lineNumber: location.end, threads: [], notes: [] };
    group.threads.push(thread);
    grouped.set(key, group);
  }
  const selectedKey = selected
    ? `annotation-${selected.side === "old" ? "deletions" : "additions"}-${selected.end}`
    : null;
  if (selected && selectedKey && !grouped.has(selectedKey))
    grouped.set(selectedKey, {
      side: selected.side === "old" ? "deletions" : "additions",
      lineNumber: selected.end,
      threads: [],
      notes: [],
    });
  const annotations: Annotation[] = [...grouped].map(([key, group]) => ({
    side: group.side,
    lineNumber: group.lineNumber,
    startLine: group.startLine,
    metadata: (
      <div className="em-diff-annotation">
        {slots.has(key) && (
          <>
            {group.notes.map((note) => (
              <AgentNoteCard key={note.id} file={file} note={note} onComment={context.onActive} />
            ))}
            {group.threads.map((thread) => (
              <ThreadCard surface="diff" key={thread.id} {...context} thread={thread} />
            ))}
            {selected && key === selectedKey && (
              <Composer
                surface="diff"
                reviewId={context.reviewId}
                revision={context.revision}
                target={selected}
                topics={context.topics}
                onSaved={() => context.onActive(null)}
                onCancel={() => context.onActive(null)}
              />
            )}
          </>
        )}
      </div>
    ),
  }));
  const selection: SelectedLineRange | null = selected
    ? { side: selected.side === "old" ? "deletions" : "additions", start: selected.start, end: selected.end }
    : null;
  if (old.isError || next.isError || parsed.isError)
    return (
      <div className="p-3">
        <p role="alert">Could not load this diff.</p>
        <Button
          onClick={() => {
            if (old.isError) void old.refetch();
            if (next.isError) void next.refetch();
            if (parsed.isError) void parsed.refetch();
          }}
        >
          Retry
        </Button>
      </div>
    );
  if (collapsed) return <Summary text={`Collapsed: ${lines} ${plural(lines, "line")}`} onExpand={onExpand} />;
  return (
    <div>
      {error && (
        <p role="alert" className="p-3">
          {error}
        </p>
      )}
      {parsed.data ? (
        <>
          <HighlightNote diff={parsed.data} />
          <DiffWorkers>
            <DiffView
              fileDiff={parsed.data}
              diffStyle={context.diffStyle}
              overflow={context.overflow}
              annotations={annotations}
              onSlots={onSlots}
              onSelect={onSelect}
              selected={selection}
            />
          </DiffWorkers>
        </>
      ) : (
        <p role="status" className="p-3">
          Loading diff…
        </p>
      )}
    </div>
  );
}
