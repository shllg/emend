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
    synPlain: string;
    synKeyword: string;
    synType: string;
    synFunction: string;
    synString: string;
    synNumber: string;
    synComment: string;
    synPunct: string;
    diffAddFg: string;
    diffDelFg: string;
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
      synPlain: colors["syn-plain"],
      synKeyword: colors["syn-keyword"],
      synType: colors["syn-type"],
      synFunction: colors["syn-function"],
      synString: colors["syn-string"],
      synNumber: colors["syn-number"],
      synComment: colors["syn-comment"],
      synPunct: colors["syn-punct"],
      diffAddFg: colors["diff-add-fg"],
      diffDelFg: colors["diff-del-fg"],
    },
  };
}
