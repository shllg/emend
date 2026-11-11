import { useId, useRef } from "react";
import { Tooltip } from "./Tooltip.tsx";
import { cn, selectionIndex } from "./utils.ts";

export interface TabItem {
  id: string;
  label: string;
  count?: number | string;
  countLabel?: string;
  accent?: boolean;
  hidden?: boolean;
  "aria-controls"?: string;
}
export interface TabsProps {
  items: TabItem[];
  value: string;
  onChange?: (id: string) => void;
  label: string;
  className?: string;
  idBase?: string;
}

function TabCount({ count, countLabel, accent }: Pick<TabItem, "count" | "countLabel" | "accent">) {
  if (count == null || count === 0) return null;
  const bubble = (
    <span
      aria-hidden={countLabel ? true : undefined}
      className={cn(
        "inline-grid h-[18px] min-w-[18px] place-items-center rounded-[9px] bg-active px-[5px] font-sans text-[10.5px] leading-none font-semibold text-fg-2 tabular-nums",
        accent && "bg-accent text-accent-fg",
      )}
    >
      {count}
    </span>
  );
  return countLabel ? (
    <>
      <Tooltip content={countLabel}>{bubble}</Tooltip>
      <span className="sr-only"> {countLabel}</span>
    </>
  ) : (
    bubble
  );
}

export function Tabs({ items, value, onChange, label, className, idBase }: TabsProps) {
  const generatedId = useId();
  const id = idBase ?? generatedId;
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const visible = items.filter((item) => !item.hidden);
  const tabValue = visible.some((item) => item.id === value) ? value : visible[0]?.id;
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn(
        "flex items-stretch gap-0.5 overflow-x-auto border-b border-line-1 px-2 [scrollbar-width:none]",
        className,
      )}
    >
      {visible.map((item, index) => (
        <button
          key={item.id}
          ref={(node) => {
            if (node) buttons.current.set(item.id, node);
            else buttons.current.delete(item.id);
          }}
          type="button"
          role="tab"
          id={`${id}-tab-${item.id}`}
          aria-selected={item.id === value}
          aria-controls={item["aria-controls"]}
          tabIndex={item.id === tabValue ? 0 : -1}
          onClick={() => onChange?.(item.id)}
          onKeyDown={(event) => {
            const next = selectionIndex(event.key, index, visible.length);
            if (next === undefined) return;
            event.preventDefault();
            const selected = visible[next];
            if (selected) {
              buttons.current.get(selected.id)?.focus();
              onChange?.(selected.id);
            }
          }}
          className="relative inline-flex h-10 shrink-0 items-center gap-1.5 whitespace-nowrap border-0 bg-transparent px-2.5 font-sans text-13 font-medium leading-(--lh-snug) text-fg-3 [-webkit-tap-highlight-color:transparent] hover:text-fg-1 focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--ochre-500)] aria-selected:text-fg-1 aria-selected:after:absolute aria-selected:after:right-2 aria-selected:after:-bottom-px aria-selected:after:left-2 aria-selected:after:h-0.5 aria-selected:after:rounded-t-[2px] aria-selected:after:bg-(--ochre-500) aria-selected:after:content-['']"
        >
          {item.label}
          <TabCount count={item.count} countLabel={item.countLabel} accent={item.accent} />
        </button>
      ))}
    </div>
  );
}
