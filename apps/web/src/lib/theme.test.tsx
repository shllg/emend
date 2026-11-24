import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { ThemeFont, ThemeValid } from "@recense/contract";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { Window as HappyWindow } from "happy-dom";
import type { CSSProperties } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { customTheme } from "../test/themes.ts";
import {
  createThemeStore,
  customThemeKey,
  downloadTheme,
  initializeTheme,
  selectCustomTheme,
  setThemePick,
  themeFontStacks,
  themeKey,
  useResolvedTheme,
  useThemePick,
} from "./theme.ts";

const boot = readFileSync(resolve(import.meta.dirname, "../../public/theme-boot.js"), "utf8");
const index = readFileSync(resolve(import.meta.dirname, "../../index.html"), "utf8");
let stop = () => {};
let restoreFonts = () => {};
beforeEach(() => {
  vi.stubGlobal("localStorage", new Storage());
  setThemePick("system");
  const html = new DOMParser().parseFromString(index, "text/html");
  for (const meta of html.querySelectorAll('meta[name="theme-color"]'))
    document.head.append(document.importNode(meta, true));
});
afterEach(() => {
  cleanup();
  setThemePick("system");
  stop();
  stop = () => {};
  restoreFonts();
  restoreFonts = () => {};
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.remove();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.density;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Reader() {
  return (
    <output>
      {useThemePick()}:{useResolvedTheme()}
    </output>
  );
}
function expectApplied(pick: "system" | "dark" | "light") {
  expect(document.documentElement.dataset.theme).toBe(pick === "system" ? undefined : pick);
  const colors = [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].map(
    (meta) => meta.content,
  );
  expect(colors).toEqual(
    pick === "system" ? ["#fafafb", "#171717"] : Array(2).fill(pick === "dark" ? "#171717" : "#fafafb"),
  );
}

test("fresh devices use System, explicit picks persist, and System removes only its key", () => {
  localStorage.setItem("recense.layout.v1", "untouched");
  expect(createThemeStore().getSnapshot()).toBe("system");
  for (const pick of ["dark", "light", "system"] as const) {
    setThemePick(pick);
    expect(createThemeStore().getSnapshot()).toBe(pick);
    expect(localStorage.getItem(themeKey)).toBe(pick === "system" ? null : pick);
    expectApplied(pick);
  }
  expect(localStorage.getItem("recense.layout.v1")).toBe("untouched");
});

test.each(["invalid", "DARK", '"light"', "", "system"])("stored %j reads as System", (value) => {
  localStorage.setItem(themeKey, value);
  expect(createThemeStore().getSnapshot()).toBe("system");
});

test("storage events update hooks, the document and browser bars, including clear", () => {
  render(<Reader />);
  for (const pick of ["dark", "light", "invalid", null]) {
    act(() => {
      if (pick === null) localStorage.clear();
      else localStorage.setItem(themeKey, pick);
      window.dispatchEvent(
        new StorageEvent("storage", { key: pick === null ? null : themeKey, storageArea: localStorage }),
      );
    });
    const expected = pick === "dark" || pick === "light" ? pick : "system";
    expect(screen.getByRole("status").textContent).toMatch(new RegExp(`^${expected}:`));
    expectApplied(expected);
  }
});

test("startup applies stored picks and follows other tabs without a mounted hook", () => {
  localStorage.setItem(themeKey, "dark");
  stop = initializeTheme();
  expectApplied("dark");
  localStorage.setItem(themeKey, "light");
  window.dispatchEvent(new StorageEvent("storage", { key: themeKey, storageArea: sessionStorage }));
  expectApplied("dark");
  window.dispatchEvent(new StorageEvent("storage", { key: "unrelated" }));
  expectApplied("dark");
  window.dispatchEvent(new StorageEvent("storage", { key: themeKey, storageArea: localStorage }));
  expectApplied("light");
});

test.each(["denied", "full"])("%s storage keeps picks in memory through hook rerenders", (failure) => {
  localStorage.setItem(themeKey, "dark");
  const fail = () => {
    throw new Error(failure);
  };
  if (failure === "denied") vi.spyOn(localStorage, "getItem").mockImplementation(fail);
  vi.spyOn(localStorage, "setItem").mockImplementation(fail);
  vi.spyOn(localStorage, "removeItem").mockImplementation(fail);
  const view = render(<Reader />);
  for (const pick of ["light", "dark", "system"] as const) {
    act(() => setThemePick(pick));
    view.rerender(<Reader />);
    expect(screen.getByRole("status").textContent).toMatch(new RegExp(`^${pick}:`));
    expectApplied(pick);
  }
});

test("resolved System follows OS changes while explicit picks remain fixed", () => {
  let dark = false;
  const listeners = new Set<() => void>();
  vi.spyOn(window, "matchMedia").mockImplementation(
    () =>
      ({
        matches: dark,
        addEventListener: (_: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
      }) as unknown as MediaQueryList,
  );
  render(<Reader />);
  expect(screen.getByRole("status").textContent).toBe("system:light");
  act(() => {
    dark = true;
    for (const listener of listeners) listener();
  });
  expect(screen.getByRole("status").textContent).toBe("system:dark");
  act(() => setThemePick("light"));
  expect(screen.getByRole("status").textContent).toBe("light:light");
  act(() => {
    dark = false;
    for (const listener of listeners) listener();
  });
  act(() => setThemePick("dark"));
  expect(screen.getByRole("status").textContent).toBe("dark:dark");
  act(() => setThemePick("system"));
  expect(screen.getByRole("status").textContent).toBe("system:light");
});

test.each([null, "dark", "light", "invalid", "system"])("blocking boot script applies stored %j", (stored) => {
  if (stored !== null) localStorage.setItem(themeKey, stored);
  document.documentElement.dataset.theme = "stale";
  runInNewContext(boot, { document, localStorage });
  expectApplied(stored === "dark" || stored === "light" ? stored : "system");
});

test("blocking boot script falls back to System when accessing storage throws", () => {
  document.documentElement.dataset.theme = "dark";
  runInNewContext(boot, {
    document,
    get localStorage() {
      throw new Error("denied");
    },
  });
  expectApplied("system");
});

test.each(["light", "dark"].flatMap((os) => (["system", "dark", "light"] as const).map((pick) => ({ os, pick }))))(
  "Shiki code and source tokens follow $pick with OS $os",
  ({ os, pick }) => {
    const device = (window as unknown as HappyWindow).happyDOM.settings.device;
    const previous = device.prefersColorScheme;
    device.prefersColorScheme = os;
    const style = document.createElement("style");
    // Happy DOM does not apply cascade layers; keep the real selectors and declarations.
    style.textContent = readFileSync(resolve(import.meta.dirname, "../styles/prose.css"), "utf8")
      .replace("@layer components {", "")
      .replace(/}\s*$/, "");
    document.head.append(style);
    // Happy DOM caches descendant selector matches across ancestor attribute changes.
    // Give each combination fresh nodes; the store tests cover live pick changes.
    setThemePick(pick);
    const tokens = { "--shiki-light": "#112233", "--shiki-dark": "#ddeeff" } as CSSProperties;
    const view = render(
      <>
        <div className="em-prose">
          <pre
            className="shiki"
            style={{ "--shiki-light-bg": "#ffffff", "--shiki-dark-bg": "#000000" } as CSSProperties}
          >
            <code>
              <span style={tokens}>const example = true;</span>
            </code>
          </pre>
        </div>
        <div className="em-source">
          <code className="em-source-code">
            <span style={tokens}>const source = true;</span>
          </code>
        </div>
      </>,
    );
    try {
      const dark = (pick === "system" ? os : pick) === "dark";
      for (const span of view.container.querySelectorAll("span"))
        expect(getComputedStyle(span).color).toBe(dark ? "#ddeeff" : "#112233");
      expect(getComputedStyle(view.container.querySelector("pre") as HTMLElement).backgroundColor).toBe(
        dark ? "#000000" : "#ffffff",
      );
    } finally {
      style.remove();
      device.prefersColorScheme = previous;
    }
  },
);

test("custom font fallbacks match the complete typography declarations", () => {
  const css = readFileSync(resolve(import.meta.dirname, "../styles/typography.css"), "utf8");
  expect(css.match(/--font-sans:\s*([^;]+);/)?.[1]).toBe(themeFontStacks.text);
  expect(css.match(/--font-mono:\s*([^;]+);/)?.[1]).toBe(themeFontStacks.code);
});

function stubFontFaces() {
  const descriptor = Object.getOwnPropertyDescriptor(document, "fonts");
  const fonts = new Set<FontFace>();
  const add = vi.spyOn(fonts, "add");
  const remove = vi.spyOn(fonts, "delete");
  Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
  restoreFonts = () => {
    if (descriptor) Object.defineProperty(document, "fonts", descriptor);
    else Reflect.deleteProperty(document, "fonts");
  };
  const face = vi.fn(
    class {
      family: string;
      source: string;
      descriptors: FontFaceDescriptors;
      status: FontFaceLoadStatus = "unloaded";
      constructor(family: string, source: string, descriptors: FontFaceDescriptors) {
        this.family = family;
        this.source = source;
        this.descriptors = descriptors;
      }
    },
  );
  vi.stubGlobal("FontFace", face);
  return { face, fonts, add, remove };
}

test("the picked theme registers faces with safe URLs, formats and descriptors and keeps unchanged faces", () => {
  const { face, fonts, add, remove } = stubFontFaces();
  const theme: ThemeValid = {
    ...customTheme,
    fonts: {
      ...customTheme.fonts,
      files: [
        { font: "text", file: "Sans.WOFF2", weight: [100, 900] },
        { font: "text", file: "Sans-Italic.woff", weight: [100, 900], style: "italic" },
        { font: "code", file: "Mono.ttf" },
        { font: "code", file: "Mono-Bold.otf", weight: 700, style: "normal" },
      ],
    },
  };
  const store = createThemeStore();
  store.selectCustomTheme(theme);
  expect(face.mock.calls).toEqual([
    [
      "_recense-theme-text",
      'url("/api/v1/themes/mine/fonts/Sans.WOFF2") format("woff2")',
      { weight: "100 900", style: "normal", display: "swap" },
    ],
    [
      "_recense-theme-text",
      'url("/api/v1/themes/mine/fonts/Sans-Italic.woff") format("woff")',
      { weight: "100 900", style: "italic", display: "swap" },
    ],
    [
      "_recense-theme-code",
      'url("/api/v1/themes/mine/fonts/Mono.ttf") format("truetype")',
      { weight: "400", style: "normal", display: "swap" },
    ],
    [
      "_recense-theme-code",
      'url("/api/v1/themes/mine/fonts/Mono-Bold.otf") format("opentype")',
      { weight: "700", style: "normal", display: "swap" },
    ],
  ]);
  expect(add).toHaveBeenCalledTimes(4);
  const original = [...fonts];
  store.applyList("mine", { themes: [{ ...theme, tokens: { accent: "#abcdef" } }], folderError: false });
  expect(face).toHaveBeenCalledTimes(4);
  expect(remove).not.toHaveBeenCalled();
  expect([...fonts]).toEqual(original);
  expect(document.documentElement.style.getPropertyValue("--font-sans")).toBe(
    `"_recense-theme-text", ${themeFontStacks.text}`,
  );
  expect(document.documentElement.style.getPropertyValue("--font-mono")).toBe(
    `"_recense-theme-code", ${themeFontStacks.code}`,
  );
  store.set("dark");
  expect(remove.mock.calls).toEqual(original.map((face) => [face]));
  expect(fonts.size).toBe(0);
});

test.each([false, true])("a successful list retries only failed faces with already checked = %s", (checked) => {
  const { face, fonts, add, remove } = stubFontFaces();
  const theme: ThemeValid = {
    ...customTheme,
    fonts: {
      ...customTheme.fonts,
      files: [
        { font: "text", file: "Sans.woff2", weight: [100, 900], style: "italic" },
        { font: "code", file: "Mono.ttf", weight: 700 },
      ],
    },
  };
  localStorage.setItem(themeKey, "theme:mine");
  localStorage.setItem(customThemeKey, JSON.stringify(theme));
  const store = createThemeStore();
  const listener = vi.fn();
  stop = store.subscribe(listener);
  const list = { themes: [theme], folderError: false };
  if (checked) store.applyList("mine", list);
  const state = store.getState();
  listener.mockClear();
  const original = [...fonts];
  const registrations = face.mock.calls.slice();
  expect(original).toHaveLength(2);
  const failedFace = original[0];
  if (failedFace === undefined) throw new Error("Expected the original text font face");
  for (const [index, face] of original.entries()) Object.assign(face, { status: index === 0 ? "error" : "loaded" });
  expect(document.documentElement.style.getPropertyValue("--font-sans")).toBe(
    `"_recense-theme-text", ${themeFontStacks.text}`,
  );

  store.applyList("mine", list);

  expect(remove).toHaveBeenCalledExactlyOnceWith(failedFace);
  expect(add).toHaveBeenCalledTimes(3);
  expect(face.mock.calls).toEqual([...registrations, registrations[0]]);
  const retried = [...fonts];
  expect(retried).toHaveLength(2);
  expect(fonts.has(failedFace)).toBe(false);
  expect(retried[0]).toBe(original[1]);
  expect(retried[0]?.status).toBe("loaded");
  expect(retried[1]).not.toBe(failedFace);
  expect(retried[1]?.status).toBe("unloaded");
  if (checked) {
    expect(store.getState()).toBe(state);
    expect(listener).not.toHaveBeenCalled();
  }
  store.applyList("mine", list);
  expect(face).toHaveBeenCalledTimes(3);
  expect(add).toHaveBeenCalledTimes(3);
  expect(remove).toHaveBeenCalledExactlyOnceWith(failedFace);
  expect([...fonts][0]).toBe(retried[0]);
  expect([...fonts][1]).toBe(retried[1]);
  store.set("dark");
  expect(remove).toHaveBeenCalledTimes(3);
  for (const face of retried) expect(remove).toHaveBeenCalledWith(face);
  expect(fonts.size).toBe(0);
});

test.each(["unloaded", "loading", "loaded"] as const)(
  "a successful list keeps unchanged faces whose status is %s",
  (status) => {
    const { face, fonts, add, remove } = stubFontFaces();
    const theme: ThemeValid = {
      ...customTheme,
      fonts: { text: "Example", files: [{ font: "text", file: "Sans.woff2" }] },
    };
    const store = createThemeStore();
    store.selectCustomTheme(theme);
    const original = [...fonts];
    for (const face of original) Object.assign(face, { status });
    const list = { themes: [theme], folderError: false };
    store.applyList("mine", list);
    const state = store.getState();
    store.applyList("mine", list);
    expect(store.getState()).toBe(state);
    expect(face).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
    expect([...fonts][0]).toBe(original[0]);
  },
);

test("a refused theme or another pick's list does not retry failed faces", () => {
  const { face, fonts, remove } = stubFontFaces();
  const theme: ThemeValid = {
    ...customTheme,
    fonts: { text: "Example", files: [{ font: "text", file: "Sans.woff2" }] },
  };
  const store = createThemeStore();
  store.selectCustomTheme(theme);
  const original = [...fonts];
  for (const face of original) Object.assign(face, { status: "error" });
  const state = store.getState();
  store.applyList("mine", {
    themes: [{ valid: false, name: "mine", base: "dark", problems: ["theme.json cannot be read."] }],
    folderError: false,
  });
  expect(store.getState()).not.toBe(state);
  store.applyList("another", { themes: [theme], folderError: false });
  expect(face).toHaveBeenCalledTimes(1);
  expect(remove).not.toHaveBeenCalled();
  expect([...fonts][0]).toBe(original[0]);
});

test("changes to a theme's file list replace all its faces without removing other fonts", () => {
  const { face, fonts, remove } = stubFontFaces();
  const builtin = new FontFace("Built In", 'url("/builtin.woff2")');
  fonts.add(builtin);
  const store = createThemeStore();
  store.selectCustomTheme({
    ...customTheme,
    fonts: {
      ...customTheme.fonts,
      files: [
        { font: "text", file: "Old.woff2" },
        { font: "code", file: "Mono.woff2" },
      ],
    },
  });
  const original = [...fonts].filter((font) => font !== builtin);
  for (const face of original) Object.assign(face, { status: "loaded" });
  store.applyList("mine", {
    themes: [
      {
        ...customTheme,
        fonts: {
          ...customTheme.fonts,
          files: [
            { font: "text", file: "New.woff2" },
            { font: "code", file: "Mono.woff2" },
          ],
        },
      },
    ],
    folderError: false,
  });
  expect(remove.mock.calls).toEqual(original.map((face) => [face]));
  for (const face of original) expect(fonts.has(face)).toBe(false);
  expect(fonts.has(builtin)).toBe(true);
  expect(fonts.size).toBe(3);
  expect(face).toHaveBeenCalledTimes(5);
  expect(face).toHaveBeenNthCalledWith(
    4,
    "_recense-theme-text",
    'url("/api/v1/themes/mine/fonts/New.woff2") format("woff2")',
    { weight: "400", style: "normal", display: "swap" },
  );
  expect(face).toHaveBeenLastCalledWith(
    "_recense-theme-code",
    'url("/api/v1/themes/mine/fonts/Mono.woff2") format("woff2")',
    { weight: "400", style: "normal", display: "swap" },
  );
  store.selectCustomTheme({
    ...customTheme,
    name: "another",
    fonts: { text: "New Family", files: [{ font: "text", file: "New.woff2" }] },
  });
  expect(face).toHaveBeenLastCalledWith(
    "_recense-theme-text",
    'url("/api/v1/themes/another/fonts/New.woff2") format("woff2")',
    { weight: "400", style: "normal", display: "swap" },
  );
  store.applyList("another", { themes: [{ ...customTheme, name: "another" }], folderError: false });
  expect([...fonts]).toEqual([builtin]);
});

test("applying a theme revalidates file entries and their family names", () => {
  const { face, fonts } = stubFontFaces();
  const store = createThemeStore();
  store.selectCustomTheme(customTheme);
  const files = [
    { font: "text", file: "Good.woff2" },
    ...["../Bad.woff2", "sub/Bad.woff2", "Bad.css", 'Bad");url(x).woff2', "Bad.woff2\n"].map((file) => ({
      font: "text",
      file,
    })),
    { font: "code", file: "InvalidFamily.woff2" },
    { font: "other", file: "Other.woff2" },
    { font: "text", file: "Weight.woff2", weight: [900, 100] },
    { font: "text", file: "Style.woff2", style: "oblique" },
    { font: "text", file: "Extra.woff2", extra: true },
  ] as ThemeValid["fonts"]["files"];
  store.applyList("mine", {
    themes: [{ ...customTheme, fonts: { text: "Example", code: "url(x)", files } }],
    folderError: false,
  });
  expect(face.mock.calls).toEqual(
    ["Good.woff2", "Extra.woff2"].map((file) => [
      "_recense-theme-text",
      `url("/api/v1/themes/mine/fonts/${file}") format("woff2")`,
      { weight: "400", style: "normal", display: "swap" },
    ]),
  );
  expect(fonts.size).toBe(2);
});

test.each(["_recense-theme-text", "_recense-theme-code"])("font alias %s cannot be a theme font name", (alias) => {
  expect(ThemeFont.safeParse(alias).success).toBe(false);
});

test("a text font named recense-theme-code cannot use the code file's alias", () => {
  const { face } = stubFontFaces();
  const theme: ThemeValid = {
    ...customTheme,
    fonts: {
      text: "recense-theme-code",
      code: "Example Mono",
      files: [{ font: "code", file: "Mono.woff2" }],
    },
  };
  expect(ThemeValid.safeParse(theme).success).toBe(true);
  createThemeStore().selectCustomTheme(theme);
  expect(face.mock.calls.map(([name]) => name)).toEqual(["_recense-theme-code"]);
  const style = document.documentElement.style;
  expect(style.getPropertyValue("--font-sans")).toBe(`"recense-theme-code", ${themeFontStacks.text}`);
  expect(style.getPropertyValue("--font-sans")).not.toContain("_recense-theme-");
  expect(style.getPropertyValue("--font-mono")).toBe(`"_recense-theme-code", ${themeFontStacks.code}`);
});

test.each(["123 Font", "serif", "A  B", "字体"])("font files use fixed aliases for the family %s", (family) => {
  const { face } = stubFontFaces();
  createThemeStore().selectCustomTheme({
    ...customTheme,
    fonts: {
      text: family,
      code: family,
      files: [
        { font: "text", file: "Example.woff2" },
        { font: "code", file: "Mono.woff2" },
      ],
    },
  });
  expect(face.mock.calls.map(([name]) => name)).toEqual(["_recense-theme-text", "_recense-theme-code"]);
  expect(document.documentElement.style.getPropertyValue("--font-sans")).toBe(
    `"_recense-theme-text", ${themeFontStacks.text}`,
  );
  expect(document.documentElement.style.getPropertyValue("--font-mono")).toBe(
    `"_recense-theme-code", ${themeFontStacks.code}`,
  );
});

test.each(["text", "code"] as const)("only the %s role with a usable file gets an alias", (font) => {
  const { face } = stubFontFaces();
  const store = createThemeStore();
  store.selectCustomTheme({
    ...customTheme,
    fonts: { ...customTheme.fonts, files: [{ font, file: "Example.woff2" }] },
  });
  expect(face.mock.calls.map(([name]) => name)).toEqual([`_recense-theme-${font}`]);
  const style = document.documentElement.style;
  expect(style.getPropertyValue("--font-sans")).toBe(
    `"${font === "text" ? "_recense-theme-text" : "Example Sans"}", ${themeFontStacks.text}`,
  );
  expect(style.getPropertyValue("--font-mono")).toBe(
    `"${font === "code" ? "_recense-theme-code" : "Example Mono"}", ${themeFontStacks.code}`,
  );
  store.applyList("mine", {
    themes: [{ ...customTheme, fonts: { ...customTheme.fonts, files: [{ font, file: "Bad.css" }] } }],
    folderError: false,
  });
  expect(style.getPropertyValue("--font-sans")).toBe(`"Example Sans", ${themeFontStacks.text}`);
  expect(style.getPropertyValue("--font-mono")).toBe(`"Example Mono", ${themeFontStacks.code}`);
});

test("changing only the named font preserves registered faces and recense's fallback", () => {
  const { face, fonts, remove } = stubFontFaces();
  const store = createThemeStore();
  const theme: ThemeValid = {
    ...customTheme,
    fonts: { text: "Example", files: [{ font: "text", file: "Example.woff2" }] },
  };
  store.selectCustomTheme(theme);
  const original = [...fonts][0];
  store.applyList("mine", {
    themes: [{ ...theme, fonts: { ...theme.fonts, text: "New Family" } }],
    folderError: false,
  });
  expect(face).toHaveBeenCalledTimes(1);
  expect(remove).not.toHaveBeenCalled();
  expect([...fonts][0]).toBe(original);
  expect(document.documentElement.style.getPropertyValue("--font-sans")).toBe(
    `"_recense-theme-text", ${themeFontStacks.text}`,
  );
});

test.each(["FontFace", "document.fonts"])("font registration does nothing without %s", (missing) => {
  const { face, add } = stubFontFaces();
  if (missing === "FontFace") vi.stubGlobal("FontFace", undefined);
  else Object.defineProperty(document, "fonts", { configurable: true, value: undefined });
  createThemeStore().selectCustomTheme({
    ...customTheme,
    fonts: { text: "Example", files: [{ font: "text", file: "Example.woff2" }] },
  });
  expect(face).not.toHaveBeenCalled();
  expect(add).not.toHaveBeenCalled();
  expect(document.documentElement.style.getPropertyValue("--font-sans")).toBe(
    `"_recense-theme-text", ${themeFontStacks.text}`,
  );
});

test.each(["compact", "roomy"] as const)("a custom theme applies %s density", (density) => {
  createThemeStore().selectCustomTheme({ ...customTheme, density });
  expect(document.documentElement.dataset.density).toBe(density);
});

test.each(["regular", undefined] as const)("a custom theme with %s density clears the previous density", (density) => {
  const store = createThemeStore();
  store.selectCustomTheme({ ...customTheme, density: "compact" });
  expect(document.documentElement.dataset.density).toBe("compact");
  store.applyList("mine", {
    themes: [{ ...customTheme, ...(density === undefined ? {} : { density }) }],
    folderError: false,
  });
  expect(document.documentElement.hasAttribute("data-density")).toBe(false);
});

test.each(["dark", "light", "system", "theme:missing"] as const)(
  "switching from compact to %s clears density",
  (pick) => {
    const store = createThemeStore();
    store.selectCustomTheme({ ...customTheme, density: "compact" });
    expect(document.documentElement.dataset.density).toBe("compact");
    store.set(pick);
    expect(document.documentElement.hasAttribute("data-density")).toBe(false);
  },
);

test("a saved custom theme without density still parses and applies with regular spacing", () => {
  expect(customTheme).not.toHaveProperty("density");
  localStorage.setItem(themeKey, "theme:mine");
  localStorage.setItem(customThemeKey, JSON.stringify(customTheme));
  document.documentElement.dataset.density = "compact";
  const store = createThemeStore();
  stop = store.subscribe(() => {});
  expect(store.getState().custom).toEqual(customTheme);
  expect(document.documentElement.dataset.theme).toBe(customTheme.base);
  expect(document.documentElement.style.getPropertyValue("--fg-1")).toBe(customTheme.tokens["fg-1"]);
  expect(document.documentElement.hasAttribute("data-density")).toBe(false);
});

test("a custom pick applies allowlisted values, fonts and base, and removes its previous overrides", () => {
  const style = document.documentElement.style;
  style.setProperty("--unrelated", "7px");
  const set = vi.spyOn(style, "setProperty");
  const store = createThemeStore();
  store.selectCustomTheme({
    ...customTheme,
    scales: { ...customTheme.scales, "unknown-name": "#123456" },
    tokens: { ...customTheme.tokens, "font-sans": "#123456", "n-0": "#123456" },
  });
  expect(localStorage.getItem(themeKey)).toBe("theme:mine");
  expect(JSON.parse(localStorage.getItem(customThemeKey) ?? "null").name).toBe("mine");
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(set.mock.calls).toEqual([
    ["--n-950", "#112233"],
    ["--bg-app", "var(--n-950)"],
    ["--fg-1", "#eeeeee"],
    ["--font-sans", `"Example Sans", ${themeFontStacks.text}`],
    ["--font-mono", `"Example Mono", ${themeFontStacks.code}`],
  ]);
  expect(
    [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].map((meta) => meta.content),
  ).toEqual(["#112233", "#112233"]);
  store.applyList("mine", {
    themes: [{ ...customTheme, base: "light", fonts: {}, scales: {}, tokens: { accent: "#aabbcc" } }],
    folderError: false,
  });
  for (const property of ["--n-950", "--bg-app", "--fg-1", "--font-sans", "--font-mono"])
    expect(style.getPropertyValue(property)).toBe("");
  expect(style.getPropertyValue("--accent")).toBe("#aabbcc");
  setThemePick("dark");
  expect(style.getPropertyValue("--accent")).toBe("");
  expect(style.getPropertyValue("--unrelated")).toBe("7px");
  style.removeProperty("--unrelated");
});

test.each([
  { name: "../mine" },
  { name: "dark" },
  { density: "dense" },
  { scales: { "n-950": "url(x)" } },
  { tokens: { "bg-app": "red;}" } },
  { tokens: { "bg-app": "var(--n-950)" } },
  { tokens: { "bg-app": "unknown-step" } },
  { fonts: { text: 'Bad"; color: red' } },
  { fonts: { code: "url(x)" } },
  { themeColor: "#112233;" },
])("a tampered cache is refused as a whole: %j", (changes) => {
  localStorage.setItem(themeKey, "theme:mine");
  localStorage.setItem(customThemeKey, JSON.stringify({ ...customTheme, ...changes }));
  const set = vi.spyOn(document.documentElement.style, "setProperty");
  stop = createThemeStore().subscribe(() => {});
  expect(set).not.toHaveBeenCalled();
  expectApplied("system");
});

test("cached picks ignore saved copies of a held name and follow pick storage events", () => {
  localStorage.setItem(themeKey, "theme:hookseed");
  localStorage.setItem(customThemeKey, JSON.stringify({ ...customTheme, name: "hookseed" }));
  render(<Reader />);
  expect(screen.getByRole("status").textContent).toBe("theme:hookseed:dark");
  const applied = vi.spyOn(document.documentElement.style, "setProperty");
  act(() => {
    localStorage.setItem(
      customThemeKey,
      JSON.stringify({ ...customTheme, name: "hookseed", base: "light", scales: { "n-950": "#aabbcc" } }),
    );
    window.dispatchEvent(new StorageEvent("storage", { key: customThemeKey, storageArea: localStorage }));
  });
  expect(screen.getByRole("status").textContent).toBe("theme:hookseed:dark");
  expect(applied).not.toHaveBeenCalled();
  expect(document.documentElement.style.getPropertyValue("--n-950")).toBe("#112233");
  act(() => {
    localStorage.setItem(themeKey, "theme:another");
    window.dispatchEvent(new StorageEvent("storage", { key: themeKey, storageArea: localStorage }));
  });
  expect(document.documentElement.style.getPropertyValue("--n-950")).toBe("");
  act(() => {
    localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: localStorage }));
  });
  expectApplied("system");
});

test("denied cache writes keep the last valid custom theme in memory", () => {
  const fail = () => {
    throw new Error("full");
  };
  vi.spyOn(localStorage, "setItem").mockImplementation(fail);
  render(<Reader />);
  act(() => selectCustomTheme(customTheme));
  expect(screen.getByRole("status").textContent).toBe("theme:mine:dark");
  expect(document.documentElement.style.getPropertyValue("--n-950")).toBe("#112233");
});

test("cache parsing is limited to a new text or name when the tab needs a seed", () => {
  localStorage.setItem(themeKey, "theme:mine");
  localStorage.setItem(customThemeKey, JSON.stringify(customTheme));
  const parse = vi.spyOn(ThemeValid, "safeParse");
  const store = createThemeStore();
  const first = store.getState();
  expect(store.getState()).toBe(first);
  store.getSnapshot();
  expect(parse).toHaveBeenCalledTimes(1);
  localStorage.setItem(customThemeKey, JSON.stringify({ ...customTheme, base: "light" }));
  expect(store.getState()).toBe(first);
  expect(parse).toHaveBeenCalledTimes(1);
  store.set("theme:another");
  expect(parse).toHaveBeenCalledTimes(2);
  store.getState();
  expect(parse).toHaveBeenCalledTimes(2);
  localStorage.setItem(customThemeKey, JSON.stringify({ ...customTheme, name: "another", base: "light" }));
  expect(store.getState().custom?.base).toBe("light");
  expect(parse).toHaveBeenCalledTimes(3);
});

test.each(["mine", "another"])("boot seeds only a cache matching the pick: %s", (name) => {
  localStorage.setItem(themeKey, "theme:mine");
  localStorage.setItem(customThemeKey, JSON.stringify({ ...customTheme, name }));
  const store = createThemeStore();
  stop = store.subscribe(() => {});
  expect(store.getState().custom).toEqual(name === "mine" ? customTheme : undefined);
  expect(document.documentElement.style.getPropertyValue("--n-950")).toBe(name === "mine" ? "#112233" : "");
  expect(store.getState().checked).toBeUndefined();
});

test("unchanged storage events preserve the snapshot and do not notify or reapply CSS", () => {
  const store = createThemeStore();
  store.selectCustomTheme(customTheme);
  const listener = vi.fn();
  stop = store.subscribe(listener);
  const snapshot = store.getState();
  const applied = vi.spyOn(document.documentElement.style, "setProperty");
  for (const key of [themeKey, customThemeKey, null])
    window.dispatchEvent(new StorageEvent("storage", { key, storageArea: localStorage }));
  expect(store.getState()).toBe(snapshot);
  expect(listener).not.toHaveBeenCalled();
  expect(applied).not.toHaveBeenCalled();
});

test("Settings selection keeps a version already held for the same name", () => {
  const store = createThemeStore();
  const newer = { ...customTheme, scales: { "n-950": "#223344" }, themeColor: "#223344" };
  store.selectCustomTheme(newer);
  store.set("light");
  localStorage.setItem(customThemeKey, JSON.stringify(customTheme));
  const writes = vi.spyOn(localStorage, "setItem");
  store.selectCustomTheme(customTheme);
  expect(writes.mock.calls).toEqual([
    [customThemeKey, JSON.stringify(newer)],
    [themeKey, "theme:mine"],
  ]);
  expect(store.getState().custom).toEqual(newer);
  expect(document.documentElement.style.getPropertyValue("--n-950")).toBe("#223344");
});

test("Settings selection adopts a matching saved version before its older list entry", () => {
  const store = createThemeStore();
  const newer = { ...customTheme, scales: { "n-950": "#223344" }, themeColor: "#223344" };
  localStorage.setItem(customThemeKey, JSON.stringify(newer));
  const writes = vi.spyOn(localStorage, "setItem");
  store.selectCustomTheme(customTheme);
  expect(store.getState().custom).toEqual(newer);
  expect(writes.mock.calls).toEqual([[themeKey, "theme:mine"]]);
  expect(document.documentElement.style.getPropertyValue("--n-950")).toBe("#223344");
});

test.each([null, "not json", JSON.stringify({ ...customTheme, name: "another" })])(
  "Settings selection seeds from its entry and writes the cache before the pick: %j",
  (saved) => {
    const store = createThemeStore();
    if (saved !== null) localStorage.setItem(customThemeKey, saved);
    const writes = vi.spyOn(localStorage, "setItem");
    store.selectCustomTheme(customTheme);
    expect(store.getState().custom).toEqual(customTheme);
    expect(writes.mock.calls).toEqual([
      [customThemeKey, JSON.stringify(customTheme)],
      [themeKey, "theme:mine"],
    ]);
    const follower = createThemeStore();
    expect(follower.getState().custom).toEqual(customTheme);
  },
);

test("the boot script uses only a matching cache's base and hex browser colour", () => {
  localStorage.setItem(themeKey, "theme:mine");
  localStorage.setItem(customThemeKey, JSON.stringify(customTheme));
  const set = vi.spyOn(document.documentElement.style, "setProperty");
  runInNewContext(boot, { document, localStorage });
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(
    [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].map((meta) => meta.content),
  ).toEqual(["#112233", "#112233"]);
  expect(set).not.toHaveBeenCalled();
});

test.each([{ name: "another" }, { base: "evil" }, { valid: false }, null, "not json"])(
  "boot ignores a mismatching or malformed custom cache: %j",
  (changes) => {
    localStorage.setItem(themeKey, "theme:mine");
    localStorage.setItem(
      customThemeKey,
      typeof changes === "string" ? changes : JSON.stringify(changes === null ? null : { ...customTheme, ...changes }),
    );
    runInNewContext(boot, { document, localStorage });
    expectApplied("system");
  },
);

test.each(["system", "dark", "light", "fonts"])("boot rejects unsafe meta colours and reserved name %s", (name) => {
  localStorage.setItem(themeKey, "theme:mine");
  localStorage.setItem(customThemeKey, JSON.stringify({ ...customTheme, themeColor: "url(x)" }));
  runInNewContext(boot, { document, localStorage });
  expectApplied("dark");
  localStorage.setItem(themeKey, `theme:${name}`);
  localStorage.setItem(customThemeKey, JSON.stringify({ ...customTheme, name }));
  runInNewContext(boot, { document, localStorage });
  expectApplied("system");
});

test("downloads read only the pick, its checked validity and its held base", () => {
  const state = { pick: "theme:mine" as const, custom: customTheme, checked: undefined };
  expect(downloadTheme({ ...state, checked: { name: "mine", valid: true } })).toBe("mine");
  for (const checked of [undefined, { name: "mine", valid: false }, { name: "another", valid: true }])
    expect(downloadTheme({ ...state, checked })).toBe("dark");
  expect(downloadTheme({ ...state, pick: "theme:another" })).toBeUndefined();
  expect(downloadTheme({ ...state, pick: "system" })).toBeUndefined();
  expect(downloadTheme({ ...state, pick: "light" })).toBe("light");
  expect(downloadTheme({ ...state, pick: "dark" })).toBe("dark");
});
