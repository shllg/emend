import { pickedTheme, useThemeState } from "./theme.ts";

export function useDiagramThemeKey() {
  const state = useThemeState();
  return JSON.stringify([state.pick, pickedTheme(state)]);
}
