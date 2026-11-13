import type { ReactNode } from "react";
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
  return (
    <nav className="em-dash-outline" aria-label={label}>
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
