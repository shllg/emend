import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { Window as HappyWindow } from "happy-dom";
import type { CSSProperties } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createThemeStore, initializeTheme, setThemePick, themeKey, useResolvedTheme, useThemePick } from "./theme.ts";

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
