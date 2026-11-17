import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { themesQuery } from "../api/queries.ts";
import { downloadTheme, pickedThemeName, updateCustomTheme, useThemeState } from "./theme.ts";

/** One subscription at the app root keeps a picked theme current on every page. */
export function ThemeSync({ enabled = true }: { enabled?: boolean }) {
  const { pick } = useThemeState();
  const name = pickedThemeName(pick);
  const themes = useQuery({ ...themesQuery(), enabled: enabled && name !== undefined });
  useEffect(() => {
    if (!enabled || name === undefined) return;
    const entry = themes.data?.themes.find((entry) => entry.name === name);
    if (entry?.valid) updateCustomTheme(entry);
  }, [enabled, name, themes.data]);
  return null;
}

export function useDownloadTheme() {
  const state = useThemeState();
  // ThemeSync owns fetching; download links only observe the current list.
  const themes = useQuery({ ...themesQuery(), enabled: false });
  return downloadTheme(state, themes.data);
}
