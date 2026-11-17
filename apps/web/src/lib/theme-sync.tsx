import { useEffect } from "react";
import { startThemeSync } from "./theme.ts";

/** One sync loop at the app root keeps a picked theme current on every page. */
export function ThemeSync({ enabled = true }: { enabled?: boolean }) {
  useEffect(() => {
    if (enabled) return startThemeSync();
  }, [enabled]);
  return null;
}
