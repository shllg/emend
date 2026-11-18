// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";

const density = readFileSync(new URL("./density.css", import.meta.url), "utf8");
const files = readFileSync(new URL("./files.css", import.meta.url), "utf8");

test("density follows spacing in the app's base layer and stays outside HTML doc frames", () => {
  const app = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  expect(app).toMatch(
    /@import "\.\/styles\/spacing\.css" layer\(base\);\s*@import "\.\/styles\/density\.css" layer\(base\);/,
  );
  expect(readFileSync(new URL("../../pub-frame.css", import.meta.url), "utf8")).not.toContain("density.css");
});

test("compact and roomy scale spacing while regular keeps the default without an attribute", () => {
  expect(density).toMatch(/:root\s*\{\s*--density: 1;\s*\}/);
  expect(density).toMatch(/:root\[data-density="compact"\]\s*\{\s*--density: 0\.75;\s*\}/);
  expect(density).toMatch(/:root\[data-density="roomy"\]\s*\{\s*--density: 1\.25;\s*\}/);
  expect(density).not.toMatch(/data-density=["']?regular/);
});

test("coarse pointers reset compact to regular spacing after its desktop rule", () => {
  const coarse = density.slice(density.indexOf("@media"));
  expect(coarse).toMatch(
    /^@media \(pointer: coarse\)\s*\{\s*:root\[data-density="compact"\]\s*\{\s*--density: 1;\s*\}\s*\}/,
  );
  expect(density.indexOf("@media")).toBeGreaterThan(density.indexOf("--density: 0.75;"));
});

test("density scales Tailwind spacing, every spacing step and the top and send bars only", () => {
  const spacing = readFileSync(new URL("./spacing.css", import.meta.url), "utf8");
  const steps = [...spacing.matchAll(/(--space-[\w-]+): (\d+)px;/g)].filter(([, name]) => name !== "--space-px");
  expect(steps.length).toBeGreaterThan(0);
  const expected: Record<string, string> = { "--spacing": "calc(0.25rem * var(--density))" };
  for (const [, name, px] of steps) expected[name ?? ""] = `calc(${px}px * var(--density))`;
  expected["--topbar-h"] = "calc(48px * var(--density))";
  expected["--sendbar-h"] = "calc(56px * var(--density))";
  const overrides = /:root\[data-density\]\s*\{([^}]+)\}/.exec(density)?.[1] ?? "";
  expect(
    Object.fromEntries([...overrides.matchAll(/(--[\w-]+): ([^;]+);/g)].map(([, key, value]) => [key, value])),
  ).toEqual(expected);
  for (const fixed of ["--space-0:", "--space-px", "--tab-touch", "--touch-min", "--tabbar-h"])
    expect(density).not.toContain(fixed);
});

test("Files keeps phone touch minimums, viewed boxes and progress bar height fixed", () => {
  const mobile = /@media \(max-width: 767px\)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/.exec(files)?.[1] ?? "";
  expect(mobile).toMatch(/\.em-files-row__main,\s*\.em-viewed-mark\s*\{\s*min-height: 40px;/);
  expect(mobile).toMatch(/\.em-viewed-mark\s*\{\s*min-width: 40px;/);
  expect(mobile).not.toContain("--density");
  expect(files).toMatch(/\.em-viewed-mark__box\s*\{[^}]*width: 14px;\s*height: 14px;/);
  expect(files).toMatch(/\.em-files-progress__bar\s*\{[^}]*height: 3px;/);
});

test("app text never uses Tailwind line heights that scale with the spacing unit", () => {
  const source = new URL("../", import.meta.url);
  for (const path of readdirSync(source, { recursive: true, encoding: "utf8" })) {
    if (!/\.tsx?$/.test(path) || /\.test\.tsx?$/.test(path)) continue;
    // Tailwind 4's numeric leading utilities use --spacing and would scale line height.
    expect(readFileSync(new URL(path, source), "utf8"), path).not.toMatch(/\bleading-\d/);
  }
});

test.each(["Button", "IconButton"])("%s sizes keep horizontal dimensions independent of density", (name) => {
  const source = readFileSync(new URL(`../components/ui/${name}.tsx`, import.meta.url), "utf8");
  const sizes = /const sizes = \{([^}]+)\}/.exec(source)?.[1];
  expect(sizes).toBeTruthy();
  // Density changes button heights, not widths.
  expect(sizes).not.toMatch(/\b(w|px|gap|size)-\d/);
});
