// @vitest-environment node
import { readFileSync } from "node:fs";
import { DEFAULT_THEME_FONTS, THEME_SCALE_STEPS, THEME_TOKENS } from "@emend/contract";
import { expect, test } from "vitest";
import { DARK_THEME, LIGHT_THEME } from "../../../../packages/core/src/theme/bases.ts";
import { parseThemeColor, themeColorHex } from "../../../../packages/core/src/theme/color.ts";

const css = readFileSync(new URL("./colors.css", import.meta.url), "utf8");
function block(pattern: RegExp): Record<string, string> {
  const body = pattern.exec(css)?.[1];
  if (!body) throw new Error("Missing CSS block");
  return Object.fromEntries(
    [...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((match) => [match[1] ?? "", match[2]?.trim() ?? ""]),
  );
}
const light = block(/^:root\s*\{([^}]+)\}/m);
const systemDark = block(
  /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{([^}]+)\}/,
);
const explicitDark = block(/\[data-theme="dark"\]\s*\{([^}]+)\}/);
const scale = /^(?:(?:n|ochre|green|blue|violet|teal|red)-\d+|origin-[1-8]-(?:bg|fg))$/;
for (const [label, declarations, table] of [
  ["light", light, LIGHT_THEME],
  ["system-dark", { ...light, ...systemDark }, DARK_THEME],
  ["explicit-dark", { ...light, ...explicitDark }, DARK_THEME],
] as const) {
  test(`${label} matches every core value and contract name in CSS order`, () => {
    const colors = Object.fromEntries(
      Object.entries(declarations)
        .filter(([name]) => name !== "focus-ring")
        .map(([name, value]) => [name, value?.replace(/^var\(--([\w-]+)\)$/, "$1")]),
    );
    expect(table).toEqual(colors);
    expect(Object.keys(colors).filter((name) => scale.test(name))).toEqual(THEME_SCALE_STEPS);
    expect(Object.keys(colors).filter((name) => !scale.test(name))).toEqual(THEME_TOKENS);
  });
}
test("dark overrides agree and the focus shadow uses its colour token", () => {
  expect(systemDark).toEqual(explicitDark);
  for (const declarations of [light, systemDark, explicitDark])
    expect(declarations["focus-ring"]).toBe("0 0 0 2px var(--bg-surface), 0 0 0 4px var(--focus-color)");
  expect(light["focus-color"]).toBe("var(--ochre-500)");
  expect(systemDark["focus-color"]).toBe("var(--ochre-400)");
});
test("default theme fonts match the first family in typography.css", () => {
  const typography = readFileSync(new URL("./typography.css", import.meta.url), "utf8");
  expect(DEFAULT_THEME_FONTS).toEqual({
    text: /--font-sans:\s*"([^"]+)"/.exec(typography)?.[1],
    code: /--font-mono:\s*"([^"]+)"/.exec(typography)?.[1],
  });
});

test.each([
  [light, ["#2a78d6", "#cf5421", "#14916a", "#b07400"]],
  [systemDark, ["#3987e5", "#d95926", "#199e70", "#c98500"]],
  [explicitDark, ["#3987e5", "#d95926", "#199e70", "#c98500"]],
] as const)("uses the chart palette in theme %#", (theme, expected) => {
  const palette = [1, 2, 3, 4].map((index) => {
    const color = parseThemeColor(theme[`chart-${index}`]);
    return color && themeColorHex(color.rgba);
  });
  expect(palette).toEqual(expected);
});
