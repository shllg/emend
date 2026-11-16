import { type CSSProperties, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { useLayout } from "../../lib/layout.ts";
import { defaultLayout, layoutStore, useLayoutPreferences } from "../../lib/layout-store.ts";
import { clampWidth, RESIZE_HANDLE_WIDTH, ResizeHandle } from "./ResizeHandle.tsx";

export function Panes({
  inbox,
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
  inbox: ReactNode;
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
  const [inboxPreview, setInboxPreview] = useState<number>();
  const [readingPreview, setReadingPreview] = useState<number>();
  const frame = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const readingPane = useRef<HTMLElement>(null);
  const hasTabs = Boolean(tabs);
  const [areaWidth, setAreaWidth] = useState(0);
  const [layoutWidth, setLayoutWidth] = useState(0);
  useLayoutEffect(() => {
    const element = area.current;
    const layoutElement = frame.current;
    if (!element || !layoutElement) return;
    const measure = () => {
      setAreaWidth(element.getBoundingClientRect().width);
      setLayoutWidth(layoutElement.getBoundingClientRect().width);
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    observer.observe(layoutElement);
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
    </div>
  );
}
