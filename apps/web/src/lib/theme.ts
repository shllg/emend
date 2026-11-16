import { useSyncExternalStore } from "react";
import { useMedia } from "./layout.ts";

export type ThemePick = "system" | "dark" | "light";
export const themeKey = "emend.theme";
// Light --bg-app = --n-25 = oklch(0.985 0.001 260), rounded to sRGB bytes.
const themeColors = { dark: "#171717", light: "#fafafb" };
const parse = (raw: string | null | undefined): ThemePick => (raw === "dark" || raw === "light" ? raw : "system");

function read() {
  try {
    return localStorage.getItem(themeKey);
  } catch {
    return undefined;
  }
}

function apply(pick: ThemePick) {
  if (pick === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = pick;
  for (const scheme of ["light", "dark"] as const) {
    const meta = document.querySelector<HTMLMetaElement>(
      `meta[name="theme-color"][media="(prefers-color-scheme: ${scheme})"]`,
    );
    if (meta) meta.content = themeColors[pick === "system" ? scheme : pick];
  }
}

export function createThemeStore() {
  let saved = read();
  let snapshot = parse(saved);
  const listeners = new Set<() => void>();
  const getSnapshot = () => {
    const raw = read();
    if (raw !== undefined && raw !== saved) {
      saved = raw;
      snapshot = parse(raw);
    }
    return snapshot;
  };
  const notify = () => {
    apply(getSnapshot());
    for (const listener of listeners) listener();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== themeKey) return;
    try {
      if (event.storageArea && event.storageArea !== localStorage) return;
    } catch {
      return;
    }
    notify();
  };
  return {
    getSnapshot,
    subscribe(listener: () => void) {
      if (listeners.size === 0) window.addEventListener("storage", onStorage);
      listeners.add(listener);
      // Include writes between render and subscription, even if a render already read them.
      notify();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) window.removeEventListener("storage", onStorage);
      };
    },
    set(pick: ThemePick) {
      // Remember the old stored value before a write that might fail, so a later read
      // does not replace this page's in-memory choice with that unchanged old value.
      getSnapshot();
      snapshot = pick;
      try {
        if (pick === "system") localStorage.removeItem(themeKey);
        else localStorage.setItem(themeKey, pick);
        saved = pick === "system" ? null : pick;
      } catch {
        // The choice still applies to this page when storage is denied or full.
      }
      notify();
    },
  };
}

const themeStore = createThemeStore();
export const setThemePick = themeStore.set;
export function useThemePick() {
  return useSyncExternalStore(themeStore.subscribe, themeStore.getSnapshot, () => "system" as const);
}
export function useResolvedTheme(): "dark" | "light" {
  const pick = useThemePick();
  const dark = useMedia("(prefers-color-scheme: dark)");
  return pick === "system" ? (dark ? "dark" : "light") : pick;
}

/** Apply before React starts; keep tabs in sync even on pages without a theme hook. */
export function initializeTheme() {
  return themeStore.subscribe(() => {});
}
