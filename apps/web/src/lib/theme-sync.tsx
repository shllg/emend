import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { themesQuery } from "../api/queries.ts";
import { downloadTheme, pickedThemeName, updateCustomTheme, useThemeState } from "./theme.ts";

const pickedThemesQuery = (name: string | undefined) => ({
  ...themesQuery(),
  queryKey: name === undefined ? ["themes", "pick"] : ["themes", "pick", name],
  gcTime: 0,
});

/** One subscription at the app root keeps a picked theme current on every page. */
export function ThemeSync({ enabled = true }: { enabled?: boolean }) {
  const { pick } = useThemeState();
  const name = pickedThemeName(pick);
  const themes = useQuery({ ...pickedThemesQuery(name), enabled: enabled && name !== undefined });
  useEffect(() => {
    if (!enabled || name === undefined) return;
    const entry = themes.data?.themes.find((entry) => entry.name === name);
    if (entry?.valid) updateCustomTheme(entry);
  }, [enabled, name, themes.data]);
  return null;
}

export function useDownloadTheme() {
  const state = useThemeState();
  // ThemeSync owns fetching; download links observe only this pick's fresh list.
  const themes = useQuery({ ...pickedThemesQuery(pickedThemeName(state.pick)), enabled: false });
  return downloadTheme(state, themes.data);
}
