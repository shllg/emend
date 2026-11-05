import type { DocHeading } from "@emend/contract";
import { type RefObject, useEffect, useState } from "react";
import { findDocHeadings, type HeadingDoc } from "../../lib/doc-navigation.ts";

export function useCurrentHeading(root: RefObject<HTMLDivElement | null>, doc?: HeadingDoc) {
  const [current, setCurrent] = useState<string>();
  useEffect(() => {
    const container = root.current;
    const scroller = container?.closest<HTMLElement>("[data-reading-scroll]");
    if (!container || !scroller || !doc) return;
    const found = findDocHeadings(container, doc);
    const elements =
      doc.headings?.flatMap((heading) => {
        const element = heading.id ? found.get(heading.id) : undefined;
        return element ? [element] : [];
      }) ?? [];
    let frame: number | undefined;
    const update = () => {
      frame = undefined;
      const bar = container.querySelector(".em-doc-bar")?.getBoundingClientRect();
      const edge = Math.max(scroller.getBoundingClientRect().top, bar?.bottom ?? 0) + 8;
      setCurrent((elements.findLast((element) => element.getBoundingClientRect().top <= edge) ?? elements[0])?.id);
    };
    const schedule = () => {
      if (frame === undefined) frame = requestAnimationFrame(update);
    };
    update();
    scroller.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(container);
    return () => {
      scroller.removeEventListener("scroll", schedule);
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [root, doc]);
  return current;
}

export function DocContents({
  headings,
  current,
  onPick,
}: {
  headings: readonly DocHeading[];
  current?: string;
  onPick: (id: string) => void;
}) {
  return (
    <nav aria-label="Document contents">
      <ul className="em-doc-contents">
        {headings.map(
          (heading) =>
            heading.id && (
              <li key={heading.id} data-level={heading.level}>
                <button
                  type="button"
                  dir="auto"
                  aria-current={current === heading.id ? "location" : undefined}
                  onClick={() => heading.id && onPick(heading.id)}
                >
                  {heading.text}
                </button>
              </li>
            ),
        )}
      </ul>
    </nav>
  );
}
