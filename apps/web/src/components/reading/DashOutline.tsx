import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { plural } from "../../lib/count.ts";
import { TopicRank } from "../status/TopicRank.tsx";

export interface DashOutlineItem {
  id: string;
  label: ReactNode;
  level?: number;
  rank?: number;
  count?: number;
}

function reveal(nav: HTMLElement | null) {
  if (!nav) return;
  const active = document.activeElement;
  const item =
    active instanceof HTMLButtonElement && nav.contains(active)
      ? active
      : nav.querySelector<HTMLElement>('button[aria-current="location"]');
  if (!item) return;
  const top = item.offsetTop;
  const bottom = top + item.offsetHeight;
  if (top < nav.scrollTop) nav.scrollTop = top;
  else if (bottom > nav.scrollTop + nav.clientHeight) nav.scrollTop = bottom - nav.clientHeight;
}

export function DashOutline({
  label,
  items,
  current,
  onPick,
}: {
  label: string;
  items: readonly DashOutlineItem[];
  current?: string;
  onPick: (id: string) => void;
}) {
  const nav = useRef<HTMLElement>(null);
  const [maxHeight, setMaxHeight] = useState<number>();
  useLayoutEffect(() => {
    const element = nav.current;
    const pane = element?.closest("[data-reading-scroll]");
    if (!element || !pane) return;
    const measure = () => {
      const room = pane.getBoundingClientRect().bottom - element.getBoundingClientRect().top - 12;
      setMaxHeight(Math.max(0, Math.floor(room)));
    };
    const onPointerEnter = () => {
      measure();
      reveal(element);
    };
    const onFocusIn = (event: FocusEvent) => {
      if (event.relatedTarget instanceof Node && element.contains(event.relatedTarget)) return;
      measure();
      reveal(element);
    };
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : undefined;
    observer?.observe(pane);
    element.addEventListener("pointerenter", onPointerEnter);
    element.addEventListener("focusin", onFocusIn);
    return () => {
      observer?.disconnect();
      element.removeEventListener("pointerenter", onPointerEnter);
      element.removeEventListener("focusin", onFocusIn);
    };
  }, []);
  useLayoutEffect(() => {
    if (current !== undefined) reveal(nav.current);
  }, [current]);
  useLayoutEffect(() => {
    if (maxHeight !== undefined) reveal(nav.current);
  }, [maxHeight]);
  return (
    <nav ref={nav} className="em-dash-outline" aria-label={label} style={{ maxHeight }}>
      <ul>
        {items.map(({ id, label, level, rank, count }) => (
          <li key={id} data-level={level}>
            <button
              type="button"
              className="em-dash-outline__item"
              aria-current={current === id ? "location" : undefined}
              onClick={() => onPick(id)}
            >
              {rank !== undefined && <TopicRank rank={rank} />}
              <span className="em-dash-outline__text" dir="auto">
                {label}
              </span>
              {count !== undefined && count > 0 && (
                <span className="em-dash-outline__count" title={`${count} ${plural(count, "comment")}`}>
                  {count}
                  <span className="sr-only"> {plural(count, "comment")}</span>
                </span>
              )}
              <span className="em-dash-outline__dash" aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
