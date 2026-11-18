import {
  DEFAULT_THEME_FONTS,
  THEME_SCALE_STEPS,
  THEME_TOKENS,
  ThemeColor,
  ThemeDensity,
  ThemeFont,
  ThemeList,
  ThemeName,
  ThemeValid,
} from "@emend/contract";
import { useSyncExternalStore } from "react";
import { get } from "../api/client.ts";
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
type ThemeState = {
  pick: ThemePick;
  custom: ThemeValid | undefined;
  checked: { name: ThemeName; valid: boolean } | undefined;
};
const serverState: ThemeState = { pick: "system", custom: undefined, checked: undefined };

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
function parseCustom(raw: string | null | undefined): ThemeValid | undefined {
  try {
    return ThemeValid.safeParse(JSON.parse(raw ?? "null")).data;
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
  const density = ThemeDensity.safeParse(custom?.density).data;
  if (density === "compact" || density === "roomy") root.dataset.density = density;
  else delete root.dataset.density;
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
  let parsedText: string | null | undefined;
  let parsedName: ThemeName | undefined;
  let cached: ThemeValid | undefined;
  let state = serverState;
  let notified: ThemeState | undefined;
  const listeners = new Set<() => void>();
  const seed = (name: ThemeName) => {
    const raw = read(customThemeKey);
    if (raw !== parsedText || name !== parsedName) {
      parsedText = raw;
      parsedName = name;
      cached = parseCustom(raw);
    }
    return cached?.name === name ? cached : undefined;
  };
  const changePick = (pick: ThemePick) => {
    if (pick !== state.pick) state = { ...state, pick, checked: undefined };
  };
  const getState = () => {
    const raw = read(themeKey);
    if (raw !== undefined && raw !== saved) {
      saved = raw;
      changePick(parse(raw));
    }
    const name = pickedThemeName(state.pick);
    if (name !== undefined && state.custom?.name !== name) {
      const custom = seed(name);
      if (custom) state = { ...state, custom };
    }
    return state;
  };
  const notify = () => {
    const current = getState();
    if (current === notified) return;
    notified = current;
    apply(current);
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
  const writeCustom = (custom: ThemeValid) => {
    try {
      const raw = JSON.stringify(custom);
      if (raw !== read(customThemeKey)) localStorage.setItem(customThemeKey, raw);
    } catch {
      // The validated last version also survives in memory when storage is unavailable.
    }
  };
  const writePick = (pick: ThemePick) => {
    changePick(pick);
    try {
      const raw = pick === "system" ? null : pick;
      if (read(themeKey) !== raw) {
        if (raw === null) localStorage.removeItem(themeKey);
        else localStorage.setItem(themeKey, raw);
      }
      saved = raw;
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
    selectCustomTheme(entry: ThemeValid) {
      const parsed = ThemeValid.safeParse(entry);
      if (!parsed.success) return;
      getState();
      const name = parsed.data.name;
      if (state.custom?.name !== name) {
        const custom = seed(name) ?? parsed.data;
        state = { ...state, custom };
      }
      // Save before publishing the pick so other tabs find the matching version.
      if (state.custom) writeCustom(state.custom);
      writePick(`theme:${name}`);
      notify();
    },
    applyList(name: ThemeName, list: ThemeList) {
      if (pickedThemeName(getState().pick) !== name) return;
      const entry = list.themes.find((entry) => entry.name === name);
      const valid = entry?.valid === true;
      if (state.checked?.name !== name || state.checked.valid !== valid) state = { ...state, checked: { name, valid } };
      if (entry?.valid) {
        if (JSON.stringify(state.custom) !== JSON.stringify(entry)) state = { ...state, custom: entry };
        // A different tab may have overwritten the saved copy, even if ours is unchanged.
        writeCustom(entry);
      }
      notify();
    },
  };
}

export function createThemeSync(
  store: ReturnType<typeof createThemeStore>,
  fetchList: (signal: AbortSignal) => Promise<ThemeList> = (signal) => get("/api/v1/themes", ThemeList, signal),
) {
  let running: { controller?: AbortController; again: boolean; stop: () => void } | undefined;
  const request = () => {
    const run = running;
    if (!run) return;
    const name = pickedThemeName(store.getState().pick);
    if (name === undefined) return;
    if (run.controller) {
      run.again = true;
      return;
    }
    const controller = new AbortController();
    run.controller = controller;
    void (async () => {
      try {
        const list = await fetchList(controller.signal);
        if (running === run) store.applyList(name, list);
      } catch {
        // Keep the held version; only another trigger requests a new attempt.
      } finally {
        if (running === run) {
          run.controller = undefined;
          if (run.again) {
            run.again = false;
            request();
          }
        }
      }
    })();
  };
  const start = () => {
    if (running) return running.stop;
    let name = pickedThemeName(store.getState().pick);
    const unsubscribe = store.subscribe(() => {
      const next = pickedThemeName(store.getState().pick);
      if (next === name) return;
      name = next;
      request();
    });
    const run = {
      controller: undefined as AbortController | undefined,
      again: false,
      stop: () => {
        if (running !== run) return;
        running = undefined;
        unsubscribe();
        run.controller?.abort();
      },
    };
    running = run;
    request();
    return run.stop;
  };
  return { start, request };
}

const themeStore = createThemeStore();
const themeSync = createThemeSync(themeStore);
export const startThemeSync = themeSync.start;
export const requestThemeSync = themeSync.request;
export const setThemePick = themeStore.set;
export const selectCustomTheme = themeStore.selectCustomTheme;
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

export function downloadTheme(state: ThemeState) {
  if (state.pick === "system") return undefined;
  if (state.pick === "dark" || state.pick === "light") return state.pick;
  const name = pickedThemeName(state.pick);
  return state.checked?.name === name && state.checked?.valid ? name : pickedTheme(state)?.base;
}

export function useDownloadTheme() {
  return downloadTheme(useThemeState());
}

/** Apply before React starts; keep tabs in sync even on pages without a theme hook. */
export function initializeTheme() {
  return themeStore.subscribe(() => {});
}
