import type { ComponentProps } from "react";
import { cn } from "./utils.ts";

export function Kbd({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      {...props}
      className={cn(
        "inline-grid h-[18px] min-w-[18px] place-items-center rounded-[4px] border border-b-2 border-line-2 bg-surface px-1 font-mono text-[11px] font-medium leading-none text-fg-2",
        className,
      )}
    />
  );
}
