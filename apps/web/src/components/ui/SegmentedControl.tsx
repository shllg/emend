import { useId, useRef } from "react";
import { Icon, type IconComponent } from "./Icon.tsx";
import { cn, focusRing, selectionIndex } from "./utils.ts";

export interface SegmentOption {
  value: string;
  label: string;
  icon?: IconComponent;
  title?: string;
  disabled?: boolean;
}
export interface SegmentedControlProps {
  options: SegmentOption[];
  value: string;
  onChange?: (value: string) => void;
  size?: "sm" | "md";
  label: string;
  className?: string;
}

export function SegmentedControl({ options, value, onChange, size = "md", label, className }: SegmentedControlProps) {
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const id = useId();
  const enabled = options.filter((option) => !option.disabled);
  const tabValue = enabled.some((option) => option.value === value) ? value : enabled[0]?.value;
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn("inline-flex gap-0.5 rounded-md border border-line-1 bg-sunken p-0.5", className)}
    >
      {options.map((option) => {
        const description = option.disabled && option.title ? `${id}-${option.value}` : undefined;
        const button = (
          // biome-ignore lint/a11y/useSemanticElements: Segmented buttons implement the required roving radio keyboard pattern.
          <button
            key={option.value}
            ref={(node) => {
              if (node) buttons.current.set(option.value, node);
              else buttons.current.delete(option.value);
            }}
            type="button"
            role="radio"
            aria-checked={option.value === value}
            tabIndex={option.value === tabValue ? 0 : -1}
            title={description ? undefined : option.title}
            aria-describedby={description}
            disabled={option.disabled}
            onClick={() => onChange?.(option.value)}
            onKeyDown={(event) => {
              const next = selectionIndex(event.key, enabled.indexOf(option), enabled.length, true);
              if (next === undefined) return;
              event.preventDefault();
              const selected = enabled[next];
              if (selected) {
                buttons.current.get(selected.value)?.focus();
                onChange?.(selected.value);
              }
            }}
            className={cn(
              "inline-flex h-6.5 items-center gap-1.5 rounded-sm border-0 bg-transparent px-2.5 font-sans text-13 font-medium leading-(--lh-snug) text-fg-3 transition-[background,color] duration-(--dur-1) hover:text-fg-1 aria-checked:bg-raised aria-checked:text-fg-1 aria-checked:shadow-1",
              focusRing,
              "disabled:cursor-not-allowed disabled:opacity-48 disabled:hover:text-fg-3",
              description && "pointer-events-none",
              size === "sm" && "h-5.5 px-2 text-12 leading-(--lh-snug)",
            )}
          >
            {option.icon && <Icon icon={option.icon} size={14} />}
            {option.label}
          </button>
        );
        return description ? (
          <span key={option.value} title={option.title} className="inline-flex cursor-not-allowed">
            {button}
            <span id={description} className="sr-only">
              {option.title}
            </span>
          </span>
        ) : (
          button
        );
      })}
    </div>
  );
}
