import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
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
  updateCustomTheme,
  useResolvedTheme,
  useThemePick,
} from "./theme.ts";

const boot = readFileSync(resolve(import.meta.dirname, "../../public/theme-boot.js"), "utf8");
const index = readFileSync(resolve(import.meta.dirname, "../../index.html"), "utf8");
let stop = () => {};
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
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.remove();
  delete document.documentElement.dataset.theme;
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
  localStorage.setItem("emend.layout.v1", "untouched");
  expect(createThemeStore().getSnapshot()).toBe("system");
  for (const pick of ["dark", "light", "system"] as const) {
    setThemePick(pick);
    expect(createThemeStore().getSnapshot()).toBe(pick);
    expect(localStorage.getItem(themeKey)).toBe(pick === "system" ? null : pick);
    expectApplied(pick);
  }
  expect(localStorage.getItem("emend.layout.v1")).toBe("untouched");
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

test("a custom pick applies allowlisted values, fonts and base, and removes its previous overrides", () => {
  const style = document.documentElement.style;
  style.setProperty("--unrelated", "7px");
  const set = vi.spyOn(style, "setProperty");
  selectCustomTheme({
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
  updateCustomTheme({ ...customTheme, base: "light", fonts: {}, scales: {}, tokens: { accent: "#aabbcc" } });
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
  stop = initializeTheme();
  expect(set).not.toHaveBeenCalled();
  expectApplied("system");
});

test("cached custom picks resolve to their base and follow either storage key", () => {
  localStorage.setItem(themeKey, "theme:mine");
  localStorage.setItem(customThemeKey, JSON.stringify(customTheme));
  render(<Reader />);
  expect(screen.getByRole("status").textContent).toBe("theme:mine:dark");
  act(() => {
    localStorage.setItem(
      customThemeKey,
      JSON.stringify({ ...customTheme, base: "light", scales: { "n-950": "#aabbcc" } }),
    );
    window.dispatchEvent(new StorageEvent("storage", { key: customThemeKey, storageArea: localStorage }));
  });
  expect(screen.getByRole("status").textContent).toBe("theme:mine:light");
  expect(document.documentElement.style.getPropertyValue("--n-950")).toBe("#aabbcc");
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

test("boot rejects unsafe meta colours and reserved theme names", () => {
  localStorage.setItem(themeKey, "theme:mine");
  localStorage.setItem(customThemeKey, JSON.stringify({ ...customTheme, themeColor: "url(x)" }));
  runInNewContext(boot, { document, localStorage });
  expectApplied("dark");
  localStorage.setItem(themeKey, "theme:dark");
  localStorage.setItem(customThemeKey, JSON.stringify({ ...customTheme, name: "dark" }));
  runInNewContext(boot, { document, localStorage });
  expectApplied("system");
});

test("downloads use a currently valid name, otherwise the matching cached base", () => {
  const state = { pick: "theme:mine" as const, custom: customTheme };
  expect(downloadTheme(state, { themes: [customTheme], folderError: false })).toBe("mine");
  for (const list of [
    undefined,
    { themes: [], folderError: false },
    {
      themes: [{ valid: false as const, name: "mine", base: "light" as const, problems: ["Unreadable."] }],
      folderError: false,
    },
  ])
    expect(downloadTheme(state, list)).toBe("dark");
  expect(downloadTheme({ ...state, pick: "theme:another" }, undefined)).toBeUndefined();
  expect(downloadTheme({ ...state, pick: "system" }, undefined)).toBeUndefined();
  expect(downloadTheme({ ...state, pick: "light" }, undefined)).toBe("light");
});
