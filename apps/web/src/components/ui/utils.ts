import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// R.1's numeric type and shadow scales are not Tailwind's default theme names.
const merge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["11", "12", "13", "14", "15", "16", "18", "20", "24", "30", "40"],
      shadow: ["1", "2", "3", "inset"],
    },
  },
});

export function cn(...values: ClassValue[]) {
  return merge(clsx(values));
}

export const focusRing = "focus-visible:outline-none focus-visible:shadow-(--focus-ring)";

export function selectionIndex(key: string, index: number, length: number, vertical = false) {
  if (!length) return undefined;
  if (key === "Home") return 0;
  if (key === "End") return length - 1;
  if (key === "ArrowRight" || (vertical && key === "ArrowDown")) return (index + 1) % length;
  if (key === "ArrowLeft" || (vertical && key === "ArrowUp")) return (index - 1 + length) % length;
  return undefined;
}
