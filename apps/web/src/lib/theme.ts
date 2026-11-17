import {
  DEFAULT_THEME_FONTS,
  THEME_SCALE_STEPS,
  THEME_TOKENS,
  ThemeColor,
  ThemeFont,
  type ThemeList,
  ThemeName,
  ThemeValid,
} from "@emend/contract";
import { useSyncExternalStore } from "react";
import { useMedia } from "./layout.ts";

export type ThemePick = "system" | "dark" | "light" | `theme:${ThemeName}`;
export const themeKey = "emend.theme";
export const customThemeKey = "emend.theme.custom";
// Keep these stacks in sync with typography.css; theme.test.tsx checks the full declarations.
export const themeFontStacks = {
  text: `"${DEFAULT_THEME_FONTS.text}", ui-sans-serif, system-ui, sans-serif`,
  code: `"${DEFAULT_THEME_FONTS.code}", ui-monospace, "SF Mono", Menlo, monospace`,
};
// Light --bg-app = --n-25 = oklch(0.985 0.001 260), rounded to sRGB bytes.
const themeColors = { dark: "#171717", light: "#fafafb" };
const scaleSteps = new Set<string>(THEME_SCALE_STEPS);
const applied = new Set<string>();
type ThemeState = { pick: ThemePick; custom: ThemeValid | undefined };
type CachedTheme = { savedAt: number; theme: ThemeValid };
const serverState: ThemeState = { pick: "system", custom: undefined };

export function pickedThemeName(pick: ThemePick): ThemeName | undefined {
  return pick.startsWith("theme:") ? ThemeName.safeParse(pick.slice(6)).data : undefined;
}
function parse(raw: string | null | undefined): ThemePick {
  if (raw === "dark" || raw === "light") return raw;
  if (raw?.startsWith("theme:") && ThemeName.safeParse(raw.slice(6)).success) return `theme:${raw.slice(6)}`;
  return "system";
}
function read(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return undefined;
  }
}
function parseCustom(raw: string | null | undefined): CachedTheme | undefined {
  try {
    const cached = JSON.parse(raw ?? "null");
    if (!cached || typeof cached.savedAt !== "number" || !Number.isFinite(cached.savedAt) || cached.savedAt < 0)
      return undefined;
    const theme = ThemeValid.safeParse(cached.theme).data;
    return theme ? { savedAt: cached.savedAt, theme } : undefined;
  } catch {
    return undefined;
  }
}
export function pickedTheme({ pick, custom }: ThemeState) {
  return custom?.name === pickedThemeName(pick) ? custom : undefined;
}

function apply(state: ThemeState) {
  const root = document.documentElement;
  for (const property of applied) root.style.removeProperty(property);
  applied.clear();
  const custom = pickedTheme(state);
  const base = custom?.base ?? (state.pick === "dark" || state.pick === "light" ? state.pick : undefined);
  if (base) root.dataset.theme = base;
  else delete root.dataset.theme;
  const set = (name: string, value: string) => {
    root.style.setProperty(`--${name}`, value);
    applied.add(`--${name}`);
  };
  if (custom) {
    for (const name of THEME_SCALE_STEPS) {
      const value = custom.scales[name];
      if (value !== undefined && ThemeColor.safeParse(value).success) set(name, value);
    }
    for (const name of THEME_TOKENS) {
      const value = custom.tokens[name];
      if (value === undefined) continue;
      if (ThemeColor.safeParse(value).success) set(name, value);
      else if (scaleSteps.has(value)) set(name, `var(--${value})`);
    }
    for (const [font, property] of [
      ["text", "font-sans"],
      ["code", "font-mono"],
    ] as const) {
      const name = custom.fonts[font];
      if (name !== undefined && ThemeFont.safeParse(name).success) set(property, `"${name}", ${themeFontStacks[font]}`);
    }
  }
  for (const scheme of ["light", "dark"] as const) {
    const meta = document.querySelector<HTMLMetaElement>(
      `meta[name="theme-color"][media="(prefers-color-scheme: ${scheme})"]`,
    );
    if (meta) meta.content = custom?.themeColor ?? themeColors[base ?? scheme];
  }
}

export function createThemeStore() {
  let saved: string | null | undefined;
  let savedCustom: string | null | undefined;
  let cache: CachedTheme | undefined;
  let state = serverState;
  const listeners = new Set<() => void>();
  const getState = () => {
    const raw = read(themeKey);
    const rawCustom = read(customThemeKey);
    if (raw !== undefined && raw !== saved) {
      saved = raw;
      state = { ...state, pick: parse(raw) };
    }
    if (rawCustom !== undefined && rawCustom !== savedCustom) {
      savedCustom = rawCustom;
      // Validate untrusted storage only when its text changes, including writes by another tab.
      cache = parseCustom(rawCustom);
      state = { ...state, custom: cache?.theme };
    }
    return state;
  };
  const notify = () => {
    apply(getState());
    for (const listener of listeners) listener();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== themeKey && event.key !== customThemeKey) return;
    try {
      if (event.storageArea && event.storageArea !== localStorage) return;
    } catch {
      return;
    }
    notify();
  };
  const writePick = (pick: ThemePick) => {
    state = { ...state, pick };
    try {
      if (pick === "system") localStorage.removeItem(themeKey);
      else localStorage.setItem(themeKey, pick);
      saved = pick === "system" ? null : pick;
    } catch {
      // The choice still applies to this page when storage is denied or full.
    }
  };
  return {
    getState,
    getSnapshot: () => getState().pick,
    subscribe(listener: () => void) {
      if (listeners.size === 0) window.addEventListener("storage", onStorage);
      listeners.add(listener);
      notify();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) window.removeEventListener("storage", onStorage);
      };
    },
    set(pick: ThemePick) {
      // Read before a possibly failed write, preserving this page's in-memory choice.
      getState();
      writePick(parse(pick));
      notify();
    },
    setCustom(entry: ThemeValid, savedAt: number, select = false) {
      const parsed = ThemeValid.safeParse(entry);
      if (!parsed.success || !Number.isFinite(savedAt) || savedAt < 0) return;
      getState();
      const custom = parsed.data;
      const pick = `theme:${custom.name}` as const;
      if (!select && state.pick !== pick) return;
      if (cache?.theme.name !== custom.name || savedAt >= cache.savedAt) {
        cache = { savedAt, theme: custom };
        state = { ...state, custom };
        try {
          const raw = JSON.stringify(cache);
          localStorage.setItem(customThemeKey, raw);
          savedCustom = raw;
        } catch {
          // The validated last version also survives in memory when storage is unavailable.
        }
      }
      if (select) writePick(pick);
      notify();
    },
  };
}

const themeStore = createThemeStore();
export const setThemePick = themeStore.set;
export const updateCustomTheme = (entry: ThemeValid, savedAt: number) => themeStore.setCustom(entry, savedAt);
export const selectCustomTheme = (entry: ThemeValid, savedAt: number) => themeStore.setCustom(entry, savedAt, true);
export function useThemeState() {
  return useSyncExternalStore(themeStore.subscribe, themeStore.getState, () => serverState);
}
export function useThemePick() {
  return useThemeState().pick;
}
export function useResolvedTheme(): "dark" | "light" {
  const state = useThemeState();
  const dark = useMedia("(prefers-color-scheme: dark)");
  return (
    pickedTheme(state)?.base ?? (state.pick === "dark" || state.pick === "light" ? state.pick : dark ? "dark" : "light")
  );
}

export function downloadTheme(state: ThemeState, list: ThemeList | undefined) {
  if (state.pick === "system") return undefined;
  if (state.pick === "dark" || state.pick === "light") return state.pick;
  const name = pickedThemeName(state.pick);
  return list?.themes.some((entry) => entry.name === name && entry.valid) ? name : pickedTheme(state)?.base;
}

/** Apply before React starts; keep tabs in sync even on pages without a theme hook. */
export function initializeTheme() {
  return themeStore.subscribe(() => {});
}
