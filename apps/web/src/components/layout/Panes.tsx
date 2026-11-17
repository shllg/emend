import {
  type CSSProperties,
  createContext,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useLayout } from "../../lib/layout.ts";
import { defaultLayout, layoutStore, useLayoutPreferences } from "../../lib/layout-store.ts";
import { clampWidth, RESIZE_HANDLE_WIDTH, ResizeHandle } from "./ResizeHandle.tsx";

const ReadingHandleContext = createContext<(handle: boolean) => void>(() => {});

export function PaneFrame({ inbox, children }: { inbox: ReactNode; children: ReactNode }) {
  const layout = useLayout();
  const preferences = useLayoutPreferences();
  const [showReadingHandle, setShowReadingHandle] = useState(false);
  const [inboxPreview, setInboxPreview] = useState<number>();
  const frame = useRef<HTMLDivElement>(null);
  const [layoutWidth, setLayoutWidth] = useState(0);
  useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    const measure = () => setLayoutWidth(element.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const maxInbox = clampWidth(layoutWidth - RESIZE_HANDLE_WIDTH * (showReadingHandle ? 2 : 1) - 360 - 440, 220, 520);
  const inboxWidth =
    layout === "desktop" ? clampWidth(inboxPreview ?? preferences.inboxWidth, 220, maxInbox) : defaultLayout.inboxWidth;
  return (
    <div
      ref={frame}
      className="em-panes flex min-h-0 flex-1"
      style={{ "--inbox-w": `${inboxWidth}px` } as CSSProperties}
    >
      {layout !== "phone" && inbox}
      {layout === "desktop" && inbox && !preferences.inboxCollapsed && (
        <ResizeHandle
          label="Resize inbox"
          value={inboxWidth}
          min={220}
          max={maxInbox}
          onPreview={setInboxPreview}
          onCommit={(inboxWidth) => layoutStore.update({ inboxWidth })}
          onReset={() => layoutStore.update({ inboxWidth: defaultLayout.inboxWidth })}
        />
      )}
      <ReadingHandleContext.Provider value={setShowReadingHandle}>{children}</ReadingHandleContext.Provider>
    </div>
  );
}

export function Panes({
  header,
  reading,
  diff,
  phoneTabs,
  sendBar,
  tab,
  hasDiff,
  tabs,
  readingLayout,
  codePanel,
}: {
  header: ReactNode;
  reading: ReactNode;
  diff: ReactNode;
  phoneTabs: ReactNode;
  sendBar?: ReactNode;
  tab: string;
  hasDiff: boolean;
  tabs?: ReactNode;
  readingLayout?: "original";
  codePanel?: string;
}) {
  const layout = useLayout();
  const preferences = useLayoutPreferences();
  const split = layout !== "phone" && preferences.pane[layout] === "split";
  const panel = layout !== "phone" && !split && tab !== "diff" ? codePanel : undefined;
  const showReadingHandle = split && hasDiff;
  const setReadingHandle = useContext(ReadingHandleContext);
  useLayoutEffect(() => {
    setReadingHandle(showReadingHandle);
  }, [setReadingHandle, showReadingHandle]);
  useLayoutEffect(() => () => setReadingHandle(false), [setReadingHandle]);
  const [readingPreview, setReadingPreview] = useState<number>();
  const area = useRef<HTMLDivElement>(null);
  const readingPane = useRef<HTMLElement>(null);
  const hasTabs = Boolean(tabs);
  const [areaWidth, setAreaWidth] = useState(0);
  useLayoutEffect(() => {
    const element = area.current;
    if (!element) return;
    const measure = () => setAreaWidth(element.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // Only Split puts tabs inside the reading scroller; sticky content offsets itself by their height.
  useLayoutEffect(() => {
    const element = readingPane.current;
    if (!element || !split || !hasTabs) return;
    const tabRow = element.querySelector<HTMLElement>(":scope > .em-review-tabs");
    if (!tabRow) return;
    const measure = () => {
      element.style.setProperty("--reading-tabs-height", `${tabRow.getBoundingClientRect().height}px`);
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => {
        window.removeEventListener("resize", measure);
        element.style.removeProperty("--reading-tabs-height");
      };
    }
    const observer = new ResizeObserver(measure);
    observer.observe(tabRow);
    return () => {
      observer.disconnect();
      element.style.removeProperty("--reading-tabs-height");
    };
  }, [split, hasTabs]);
  const maxReading = Math.max(360, areaWidth - RESIZE_HANDLE_WIDTH - 440);
  const preferredReading =
    preferences.readingShare === defaultLayout.readingShare
      ? clampWidth(areaWidth * defaultLayout.readingShare, 420, 760)
      : areaWidth * preferences.readingShare;
  const readingWidth = clampWidth(readingPreview ?? preferredReading, 360, maxReading);
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col">
      {header}
      {layout !== "phone" && !split && tabs}
      <div ref={area} className="flex min-h-0 flex-1">
        {(layout !== "phone" || tab !== "diff" || !hasDiff) && (
          <section
            key="reading"
            ref={readingPane}
            aria-label="Reading"
            data-testid="reading-pane"
            data-reading-scroll
            data-reading-layout={readingLayout}
            hidden={!split && hasDiff && tab === "diff"}
            tabIndex={-1}
            className={`relative min-w-0 flex-1 bg-reading ${readingLayout === "original" ? "overflow-hidden" : "overflow-y-auto"}`}
            style={showReadingHandle ? { flex: `0 0 ${readingWidth}px` } : undefined}
          >
            {split && tabs}
            {reading}
          </section>
        )}
        {showReadingHandle && (
          <ResizeHandle
            key="reading-handle"
            label="Resize reading pane"
            value={readingWidth}
            min={360}
            max={maxReading}
            onPreview={setReadingPreview}
            onCommit={(width) => {
              if (areaWidth > 0) layoutStore.update({ readingShare: width / areaWidth });
            }}
            onReset={() => layoutStore.update({ readingShare: defaultLayout.readingShare })}
          />
        )}
        {hasDiff && (layout !== "phone" || tab === "diff") && (
          <section
            key="diff"
            aria-label={panel ?? "Diff"}
            data-testid="diff-pane"
            data-diff-scroll
            hidden={!split && tab !== "diff" && !panel}
            className={`relative min-w-0 overflow-y-auto ${panel ? "em-code-panel" : "flex-1"}`}
          >
            {diff}
          </section>
        )}
      </div>
      {sendBar}
      {layout === "phone" && phoneTabs}
    </main>
  );
}
