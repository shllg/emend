import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { Window as HappyWindow } from "happy-dom";
import { afterEach, beforeEach, expect, onTestFinished, test, vi } from "vitest";
import { setThemePick } from "../../lib/theme.ts";
import { DiffView } from "./FileDiff.tsx";
import { parsePair } from "./parse.worker.ts";
import { diffShadowCSS } from "./shadow.ts";
import { diffTheme, syntaxVariables } from "./theme.ts";

const stylesheet = readFileSync(resolve(import.meta.dirname, "../../styles/diff.css"), "utf8");
const typography = readFileSync(resolve(import.meta.dirname, "../../styles/typography.css"), "utf8");
const colors = readFileSync(resolve(import.meta.dirname, "../../styles/colors.css"), "utf8");
const installed = readFileSync(
  resolve(import.meta.dirname, "../../../node_modules/@pierre/diffs/dist/style.js"),
  "utf8",
);
const overrides = {
  "--diffs-bg-addition-override": "--diff-add-bg",
  "--diffs-bg-addition-number-override": "--diff-add-bg",
  "--diffs-bg-addition-emphasis-override": "--diff-add-word",
  "--diffs-addition-color-override": "--diff-add-fg",
  "--diffs-bg-deletion-override": "--diff-del-bg",
  "--diffs-bg-deletion-number-override": "--diff-del-bg",
  "--diffs-bg-deletion-emphasis-override": "--diff-del-word",
  "--diffs-deletion-color-override": "--diff-del-fg",
  "--diffs-bg-context-override": "--bg-surface",
  "--diffs-bg-context-gutter-override": "--diff-gutter",
  "--diffs-bg-separator-override": "--diff-hunk-bg",
  "--diffs-bg-selection-override": "--diff-select-bg",
  "--diffs-fg-number-override": "--fg-3",
};

beforeEach(() => {
  vi.stubGlobal("localStorage", new Storage());
  setThemePick("system");
});
afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test.each([false, true])(
  "real diff follows both picks with OS dark=%s and retains its host and selection",
  async (osDark) => {
    const device = (window as unknown as HappyWindow).happyDOM.settings.device;
    const previous = device.prefersColorScheme;
    device.prefersColorScheme = osDark ? "dark" : "light";
    const style = document.createElement("style");
    // Happy DOM does not apply cascade layers; keep the real selectors and declarations.
    style.textContent = colors + stylesheet.replace("@layer components {", "").replace(/}\s*$/, "");
    document.head.append(style);
    onTestFinished(() => {
      style.remove();
      device.prefersColorScheme = previous;
    });
    expect(window.matchMedia("(prefers-color-scheme: dark)").matches).toBe(osDark);
    const fileDiff = parsePair({
      oldFile: null,
      newFile: { name: "pick.ts", contents: "// gentle\nconst value = true;\n" },
    });
    const onSelect = vi.fn();
    const { container } = render(
      <DiffView
        fileDiff={fileDiff}
        diffStyle="unified"
        selected={{ side: "additions", start: 1, end: 2 }}
        annotations={[]}
        onSelect={onSelect}
      />,
    );
    const host = container.querySelector<HTMLElement>("diffs-container");
    if (!host) throw new Error("Missing real diff host");
    await waitFor(() =>
      expect(host.shadowRoot?.querySelector('[data-line] span[style*="--diffs-token-keyword"]')).toBeTruthy(),
    );
    const themeCSS = () => host.shadowRoot?.querySelector("style[data-theme-css]")?.textContent ?? "";
    const originalThemeCSS = themeCSS();
    expect(originalThemeCSS).not.toContain("prefers-color-scheme");
    const spans = () => [...(host.shadowRoot?.querySelectorAll("[data-line] span[style]") ?? [])];
    const keyword = spans().find((span) => span.textContent === "const");
    const comment = spans().find((span) => span.textContent?.includes("gentle"));
    expect(keyword?.getAttribute("style")).toContain("color:var(--diffs-token-keyword, var(--syn-keyword))");
    expect(comment?.getAttribute("style")).toContain("color:var(--diffs-token-comment, var(--syn-comment))");
    expect(comment?.getAttribute("style")).toContain("font-style:italic");
    for (const span of spans()) expect(span.getAttribute("style")).not.toMatch(/--diffs-token-(?:light|dark)/);
    const paletteTokens = {
      "--diffs-token-keyword": "--syn-keyword",
      "--diffs-bg-addition-override": "--diff-add-bg",
      "--diffs-bg-deletion-override": "--diff-del-bg",
      "--diffs-background": "--bg-surface",
    };
    const palette = () =>
      Object.keys(paletteTokens).map((name) => getComputedStyle(host).getPropertyValue(name).trim());
    const systemPalette = palette();
    const scroll = host.shadowRoot?.querySelector<HTMLElement>("[data-code]");
    if (!scroll) throw new Error("Missing code scroll container");
    scroll.scrollLeft = 48;
    const selected = () => host.shadowRoot?.querySelectorAll("[data-selected-line]").length;
    const selectedBefore = selected();
    expect(selectedBefore).toBeGreaterThan(0);
    const palettes: string[][] = [];
    for (const pick of ["dark", "light"] as const) {
      act(() => setThemePick(pick));
      // Happy DOM does not compute inherited color-scheme; verify both ends of the inheritance.
      expect(getComputedStyle(document.documentElement).colorScheme).toBe(pick);
      expect(host.style.colorScheme).toBe("inherit");
      const computed = getComputedStyle(host);
      for (const [name, token] of Object.entries({ ...paletteTokens, ...overrides })) {
        const pageValue = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
        expect(pageValue).not.toBe("");
        expect(computed.getPropertyValue(name).trim()).toBe(pageValue);
      }
      palettes.push(palette());
      expect(themeCSS()).toBe(originalThemeCSS);
      expect(spans().find((span) => span.textContent === "const")).toBe(keyword);
      expect(spans().find((span) => span.textContent?.includes("gentle"))).toBe(comment);
      expect(container.querySelector("diffs-container")).toBe(host);
      expect(host.shadowRoot?.querySelector("[data-code]")).toBe(scroll);
      expect(scroll.scrollLeft).toBe(48);
      expect(selected()).toBe(selectedBefore);
    }
    for (const [index, name] of Object.keys(paletteTokens).entries())
      expect(palettes[0]?.[index], name).not.toBe(palettes[1]?.[index]);
    expect(systemPalette).toEqual(palettes[osDark ? 0 : 1]);
    act(() => setThemePick("system"));
    expect(getComputedStyle(document.documentElement).colorScheme).toBe("light dark");
    expect(palette()).toEqual(systemPalette);
    expect(themeCSS()).toBe(originalThemeCSS);
    expect(onSelect).not.toHaveBeenCalled();
  },
);
test("annotation content cannot size the split columns and its controls wrap", () => {
  const annotation = stylesheet.match(/\.em-diff-annotation\s*\{([^}]+)\}/)?.[1];
  expect(annotation).toMatch(/contain:\s*inline-size;/);
  expect(annotation).toMatch(/min-width:\s*0;/);
  expect(stylesheet).toMatch(/\.em-diff-annotation \.em-thread > footer,[\s\S]*?flex-wrap:\s*wrap;/);
  expect(stylesheet).toMatch(/\.em-diff-annotation \.em-composer__foot\s*\{\s*flex-wrap:\s*wrap;/);
  expect(stylesheet).toMatch(/\.em-diff-annotation \.em-composer__target > span\s*\{[^}]*text-overflow:\s*ellipsis;/);
});

test("script-focused headings suppress only their ring; keyboard buttons retain the global rule", () => {
  const css = readFileSync(resolve(import.meta.dirname, "../../styles/base.css"), "utf8");
  const focus = css.match(/:focus-visible\s*\{([^}]+)\}/);
  const suppressed = css.match(/(\[tabindex="-1"\]):focus-visible\s*\{([^}]+)\}/);
  expect(focus?.[1]).toContain("box-shadow: var(--focus-ring)");
  expect(suppressed?.[2]).toContain("box-shadow: none");
  expect(suppressed?.index).toBeGreaterThan(focus?.index ?? 0);
  const view = render(
    <>
      <h1 tabIndex={-1}>Review</h1>
      <button type="button">Keyboard control</button>
    </>,
  );
  const selector = suppressed?.[1] ?? "missing";
  expect(view.getByRole("heading").matches(selector)).toBe(true);
  expect(view.getByRole("button").matches(selector)).toBe(false);
});

test.each(["light", "dark"])("real diff host uses the verified token overrides in %s scheme", async (theme) => {
  const style = document.createElement("style");
  const tokens = Object.fromEntries(
    Object.values(overrides).map((token, index) => [
      token,
      `#${theme === "dark" ? "1" : "e"}${String(index).padStart(5, "0")}`,
    ]),
  );
  // Happy DOM does not apply cascade layers; preserve the actual selectors/declarations.
  style.textContent = typography + stylesheet.replace("@layer components {", "").replace(/}\s*$/, "");
  document.head.append(style);
  try {
    const value = parsePair({ oldFile: null, newFile: { name: "theme.ts", contents: "const value = true;\n" } });
    const { container } = render(
      <div
        data-theme={theme}
        style={{ ...tokens, "--font-mono": "monospace", colorScheme: theme } as React.CSSProperties}
      >
        <DiffView fileDiff={value} diffStyle="split" annotations={[]} onSelect={() => {}} selected={null} />
      </div>,
    );
    const host = container.querySelector<HTMLElement>("diffs-container");
    if (!host) throw new Error("Missing real renderer host");
    await waitFor(() => expect(host.shadowRoot?.querySelector("[data-line]")).toBeTruthy());
    const computed = getComputedStyle(host);
    for (const [name, token] of Object.entries(overrides)) {
      expect(installed).toContain(name);
      expect(computed.getPropertyValue(name).trim()).toBe(tokens[token]);
    }
    for (const name of ["--diffs-font-family", "--diffs-font-features", "--diffs-font-size", "--diffs-line-height"])
      expect(installed).toContain(name);
    expect(computed.getPropertyValue("--diffs-font-family").trim()).toBe("monospace");
    expect(computed.getPropertyValue("--diffs-font-features").trim()).toBe('"calt" 0');
    expect(diffShadowCSS).toContain("font-feature-settings: var(--mono-features)");
    expect(computed.getPropertyValue("--diffs-font-size").trim()).toBe("13px");
    expect(computed.getPropertyValue("--diffs-line-height").trim()).toBe("1lh");
    expect(host.style.colorScheme).toBe("inherit");
    expect(stylesheet).toContain("font: var(--type-code)");
    // One variable palette is inherited through the shadow boundary in either scheme.
    await waitFor(() =>
      expect(host.shadowRoot?.querySelector('[data-line] span[style*="--diffs-token-keyword"]')).toBeTruthy(),
    );
    expect(host.shadowRoot?.querySelector("pre")?.getAttribute("data-indicators")).toBe("classic");
    expect(host.shadowRoot?.querySelector("pre")?.getAttribute("data-overflow")).toBe("scroll");
    expect(host.shadowRoot?.querySelector("style[data-unsafe-css]")?.textContent).toContain(
      "background: var(--bg-sunken)",
    );
    const line = host.shadowRoot?.querySelector("[data-line]");
    const wrapper = container.firstElementChild as HTMLElement;
    wrapper.style.setProperty("--reader-code-size", "14px");
    expect(getComputedStyle(host).getPropertyValue("--diffs-font-size").trim()).toBe("14px");
    wrapper.style.removeProperty("--reader-code-size");
    wrapper.style.setProperty("--type-code-size", "11px");
    expect(getComputedStyle(host).getPropertyValue("--diffs-font-size").trim()).toBe("11px");
    expect(getComputedStyle(host).getPropertyValue("--type-code")).toContain("11px");
    expect(host.shadowRoot?.querySelector("[data-line]")).toBe(line);
    expect(host.shadowRoot?.querySelector("style[data-unsafe-css]")?.textContent).toContain(
      "font-size: calc(var(--diffs-font-size) - 1px)",
    );
  } finally {
    style.remove();
  }
});

test("one registered CSS theme maps every syntax variable to light and both dark token sets", () => {
  expect(diffTheme.name).toBe("recense");
  expect(diffTheme.cssVariables?.variableDefaults).toEqual(syntaxVariables);
  const colors = readFileSync(resolve(import.meta.dirname, "../../styles/colors.css"), "utf8");
  const [light, automaticDark, explicitDark] = colors.split(
    /@media \(prefers-color-scheme: dark\)|\[data-theme="dark"\]/,
  );
  const tokens = ["keyword", "type", "function", "string", "number", "comment", "punct", "plain"];
  for (const token of tokens) {
    const pattern = new RegExp(`--syn-${token}:\\s*([^;]+);`, "g");
    const values = [...colors.matchAll(pattern)].map((match) => match[1]);
    expect(values).toHaveLength(3);
    expect(values[1]).toBe(values[2]);
    for (const block of [light, automaticDark, explicitDark]) expect(block).toContain(`--syn-${token}:`);
  }
  for (const [key, value] of Object.entries(syntaxVariables)) expect(stylesheet).toContain(`--diffs-${key}: ${value};`);
});

test("real TypeScript syntax uses calm variables, distinct types, plain properties/parameters and italic comments", async () => {
  const parsed = parsePair({
    oldFile: null,
    newFile: {
      name: "sample.ts",
      contents:
        '// gentle\ninterface Person { name: string }\nfunction greet(person: Person) { return "hello"; }\nconst ANSWER = 42;\nconst yes = true;\n',
    },
  });
  const view = render(
    <DiffView fileDiff={parsed} diffStyle="unified" selected={null} annotations={[]} onSelect={() => {}} />,
  );
  const spans = () => [
    ...(view.container.querySelector("diffs-container")?.shadowRoot?.querySelectorAll("[data-line] span[style]") ?? []),
  ];
  await waitFor(() =>
    expect(spans().some((span) => span.getAttribute("style")?.includes("--diffs-token-keyword"))).toBe(true),
  );
  for (const [text, variable] of [
    ["interface", "keyword"],
    ["Person", "type"],
    ["greet", "function"],
    ["42", "constant"],
    ["true", "constant"],
  ]) {
    expect(
      spans()
        .find((span) => span.textContent?.trim() === text)
        ?.getAttribute("style"),
    ).toContain(`--diffs-token-${variable}`);
  }
  for (const text of ["name", "person"])
    expect(
      spans()
        .find((span) => span.textContent?.trim() === text)
        ?.getAttribute("style"),
    ).toContain("--syn-plain");
  expect(
    spans()
      .find((span) => span.textContent?.includes("gentle"))
      ?.getAttribute("style"),
  ).toContain("font-style:italic");
});

test("Markdown headings, bold, code, links and list markers share the calm palette", async () => {
  const parsed = parsePair({
    oldFile: null,
    newFile: { name: "sample.md", contents: "# Heading\n**Bold** and `inline`\n[Link](https://example.com)\n- item\n" },
  });
  const view = render(
    <DiffView fileDiff={parsed} diffStyle="unified" selected={null} annotations={[]} onSelect={() => {}} />,
  );
  const spans = () => [
    ...(view.container.querySelector("diffs-container")?.shadowRoot?.querySelectorAll("[data-line] span[style]") ?? []),
  ];
  await waitFor(() =>
    expect(spans().some((span) => span.getAttribute("style")?.includes("--diffs-token-heading"))).toBe(true),
  );
  for (const [text, variable] of [
    ["Heading", "token-heading"],
    ["Bold", "foreground"],
    ["inline", "token-link"],
    ["Link", "token-link"],
    ["-", "token-punctuation"],
  ]) {
    expect(
      spans()
        .find((span) => span.textContent?.trim() === text)
        ?.getAttribute("style"),
    ).toContain(`--diffs-${variable}`);
  }
});

test("prose defaults and reader overrides resolve through the semantic size token", () => {
  const style = document.createElement("style");
  style.textContent = typography;
  document.head.append(style);
  try {
    const { container } = render(
      <div className="em-app">
        <p>Read the synthetic writeup</p>
      </div>,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(getComputedStyle(root).getPropertyValue("--type-prose")).toContain("16px");
    root.style.setProperty("--type-prose-size", "17px");
    expect(getComputedStyle(root).getPropertyValue("--type-prose")).toContain("17px");
    root.style.setProperty("--reader-prose-size", "18px");
    expect(getComputedStyle(root).getPropertyValue("--type-prose")).toContain("18px");
    root.style.removeProperty("--reader-prose-size");
    expect(getComputedStyle(root).getPropertyValue("--type-prose")).toContain("17px");
  } finally {
    style.remove();
  }
});

test("the sticky gutter has an opaque base in scroll mode so scrolled code never shows through", () => {
  expect(installed).toContain("[data-overflow=scroll] [data-gutter]{position:sticky;left:0");
  expect(diffShadowCSS).toMatch(
    /\[data-overflow="scroll"\] \[data-gutter\] \{\s*background: var\(--bg-surface\);\s*\}/,
  );
});
