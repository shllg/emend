import type { InboxItem } from "@recense/contract";
import { cn } from "../ui/utils.ts";

const tints = [
  ["bg-origin-1-bg text-origin-1-fg", "bg-origin-1-fg"],
  ["bg-origin-2-bg text-origin-2-fg", "bg-origin-2-fg"],
  ["bg-origin-3-bg text-origin-3-fg", "bg-origin-3-fg"],
  ["bg-origin-4-bg text-origin-4-fg", "bg-origin-4-fg"],
  ["bg-origin-5-bg text-origin-5-fg", "bg-origin-5-fg"],
  ["bg-origin-6-bg text-origin-6-fg", "bg-origin-6-fg"],
  ["bg-origin-7-bg text-origin-7-fg", "bg-origin-7-fg"],
  ["bg-origin-8-bg text-origin-8-fg", "bg-origin-8-fg"],
] as const;

export function OriginBadge({
  origin,
  size = "md",
  dot = false,
  className,
}: {
  origin: InboxItem["origin"];
  size?: "md" | "sm";
  dot?: boolean;
  className?: string;
}) {
  let hash = 0;
  for (const char of origin.id) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  const tint = tints[hash % tints.length];
  if (dot)
    return (
      <span
        role="img"
        aria-label={`From ${origin.name}`}
        className={cn("inline-block size-[0.5rem] shrink-0 rounded-[2px]", tint?.[1], className)}
      />
    );
  return (
    <span
      title={`From ${origin.name}`}
      className={cn(
        "inline-flex shrink-0 items-center whitespace-nowrap rounded-sm pr-1.5 pl-[5px] font-mono font-medium leading-none",
        size === "sm" ? "h-[18px] text-[11px]" : "h-[1.25rem] text-[11.5px]",
        tint?.[0],
        className,
      )}
    >
      {origin.name}
    </span>
  );
}
