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
      setMaxHeight(Math.max(96, Math.floor(room)));
    };
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : undefined;
    observer?.observe(pane);
    element.addEventListener("pointerenter", measure);
    element.addEventListener("focusin", measure);
    return () => {
      observer?.disconnect();
      element.removeEventListener("pointerenter", measure);
      element.removeEventListener("focusin", measure);
    };
  }, []);
  useLayoutEffect(() => {
    if (current === undefined) return;
    const element = nav.current;
    const item = element?.querySelector<HTMLElement>('button[aria-current="location"]');
    if (!element || !item) return;
    const top = item.offsetTop;
    const bottom = top + item.offsetHeight;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (bottom > element.scrollTop + element.clientHeight) element.scrollTop = bottom - element.clientHeight;
  }, [current]);
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
