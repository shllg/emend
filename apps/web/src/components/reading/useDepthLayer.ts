import { type RefObject, useEffect, useState } from "react";
import type { ReaderGroup } from "./BlockReader.tsx";

export type DepthLayer = NonNullable<ReaderGroup["layer"]>;
export const depthLayers: readonly DepthLayer[] = ["decide", "frame", "topics", "trail"];

export function useDepthLayer(root: RefObject<HTMLElement | null>, visible: boolean, layout: string) {
  const [depth, setDepth] = useState<{ current: DepthLayer; present: DepthLayer[] }>({
    current: "decide",
    present: [],
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: A group layout change requires a fresh DOM measurement.
  useEffect(() => {
    const content = root.current;
    const scroll = content?.closest<HTMLElement>("[data-reading-scroll]");
    if (!visible || !content || scroll?.closest("[hidden]")) return;
    let stopped = false;
    let frame: number | undefined;
    const report = () => {
      frame = undefined;
      if (stopped || scroll?.closest("[hidden]")) return;
      const sections = depthLayers.flatMap((layer) => {
        const section = content.querySelector<HTMLElement>(`section[data-depth-layer="${layer}"]`);
        return section ? [{ layer, section }] : [];
      });
      const present = sections.map(({ layer }) => layer);
      let current = present[0] ?? "decide";
      if (scroll) {
        const top = scroll.getBoundingClientRect().top;
        const tabs = scroll.querySelector(".em-review-tabs")?.getBoundingClientRect().height ?? 0;
        const edge = top + tabs + 96;
        const bounds = sections.map(({ layer, section }) => ({ layer, rect: section.getBoundingClientRect() }));
        const max = scroll.scrollHeight - scroll.clientHeight;
        const atBottom = max > 0 && scroll.scrollTop >= max - 1;
        const lastVisible = atBottom
          ? bounds.findLast(({ rect }) => rect.bottom > top + tabs && rect.top < top + scroll.clientHeight)
          : undefined;
        current = (lastVisible ?? bounds.findLast(({ rect }) => rect.top <= edge))?.layer ?? current;
      }
      setDepth((previous) =>
        previous.current === current && previous.present.join() === present.join() ? previous : { current, present },
      );
    };
    const schedule = () => {
      if (!stopped && !scroll?.closest("[hidden]") && frame === undefined) frame = requestAnimationFrame(report);
    };
    report();
    const resize = new ResizeObserver(schedule);
    resize.observe(content);
    if (scroll) resize.observe(scroll);
    scroll?.addEventListener("scroll", schedule, { passive: true });
    return () => {
      stopped = true;
      if (frame !== undefined) cancelAnimationFrame(frame);
      resize.disconnect();
      scroll?.removeEventListener("scroll", schedule);
    };
  }, [root, visible, layout]);
  return depth;
}
