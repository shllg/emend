import type { ThemeBase } from "@emend/contract";
import { resolveTheme, type ThemeSource } from "./theme.ts";

export type DownloadLook = {
  base: ThemeBase;
  colors: {
    bg: string;
    sunken: string;
    fg: string;
    strong: string;
    muted: string;
    border: string;
    link: string;
    diffAdd: string;
    diffDel: string;
  };
};
export function themeDownloadLook(source: ThemeSource): DownloadLook {
  const colors = resolveTheme(source);
  return {
    base: typeof source === "string" ? source : source.base,
    colors: {
      bg: colors["bg-reading"],
      sunken: colors["bg-sunken"],
      fg: colors["fg-reading"],
      strong: colors["fg-reading-strong"],
      muted: colors["fg-reading-muted"],
      border: colors["border-1"],
      link: colors["fg-link"],
      diffAdd: colors["diff-add-bg"],
      diffDel: colors["diff-del-bg"],
    },
  };
}
