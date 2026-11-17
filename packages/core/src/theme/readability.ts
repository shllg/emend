import type { ThemeBase, ThemeScaleStep, ThemeToken } from "@emend/contract";
import { compositeThemeColor, parseThemeColor, type ThemeRgba, themeContrast } from "./color.ts";

type ColorName = ThemeScaleStep | ThemeToken;
export type ResolvedTheme = Record<ColorName, string>;
export type ThemeReadabilityPair = { foreground: ColorName; background: ColorName; minimum: number; over?: ColorName };
const pairs = (
  foregrounds: readonly ColorName[],
  backgrounds: readonly ColorName[],
  minimum = 4.5,
): ThemeReadabilityPair[] =>
  foregrounds.flatMap((foreground) => backgrounds.map((background) => ({ foreground, background, minimum })));
const ownBackgrounds = (names: readonly string[]) =>
  names.map((name) => ({
    foreground: `${name}-fg` as ColorName,
    background: `${name}-bg` as ColorName,
    minimum: 4.5,
  }));
export const THEME_READABILITY_PAIRS: readonly ThemeReadabilityPair[] = [
  ...pairs(["fg-1", "fg-2", "fg-3", "fg-link", "accent-text"], ["bg-app", "bg-surface", "bg-sunken", "bg-raised"]),
  ...pairs(["fg-inverse"], ["bg-inverse"]),
  ...pairs(["fg-reading", "fg-reading-strong", "fg-reading-muted"], ["bg-reading", "bg-reading-card"]),
  ...pairs(["fg-reading", "fg-reading-strong"], ["bg-sunken"]),
  ...pairs(["fg-reading-muted"], ["bg-sunken"], 3),
  ...pairs(["fg-reading", "fg-reading-strong", "fg-reading-muted"], ["diff-add-bg", "diff-del-bg"]).map((pair) => ({
    ...pair,
    over: "bg-sunken" as const,
    minimum: pair.foreground === "fg-reading-muted" ? 3 : 4.5,
  })),
  ...pairs(["fg-link"], ["bg-reading"]),
  ...pairs(["fg-1"], ["bg-selected", "bg-hover", "bg-active", "accent-tint", "mark-bg", "mark-bg-active"]),
  { foreground: "fg-reading", background: "mark-bg", over: "bg-reading", minimum: 4.5 },
  ...pairs(["accent-fg"], ["accent", "accent-hover", "accent-press"]),
  ...ownBackgrounds(["success", "info", "warning", "danger"]),
  ...pairs(["success-fg", "info-fg", "warning-fg", "danger-fg"], ["bg-surface"]),
  ...ownBackgrounds(["state-open", "state-approved", "state-settled", "state-snoozed"]),
  ...ownBackgrounds(["outcome-fixed", "outcome-explained", "outcome-held", "outcome-declined", "changed"]),
  ...pairs(["topic-fg"], ["topic-bg", "topic-bg-2", "bg-surface"]),
  ...pairs(["topic-on-solid"], ["topic-solid"]),
  ...ownBackgrounds(Array.from({ length: 8 }, (_, i) => `origin-${i + 1}`)),
  ...pairs(["syn-plain"], ["bg-surface", "diff-add-bg", "diff-del-bg"]),
  ...pairs(["syn-plain"], ["diff-add-hover", "diff-del-hover", "diff-select-bg"]),
  ...["add", "del"].flatMap((kind) =>
    pairs(
      ["syn-plain", "syn-keyword", "syn-type", "syn-function", "syn-string", "syn-number", "syn-comment", "syn-punct"],
      [`diff-${kind}-word` as ColorName],
    ).map((pair) => ({
      ...pair,
      over: `diff-${kind}-bg` as ColorName,
      minimum: pair.foreground === "syn-plain" ? 4.5 : 3,
    })),
  ),
  ...pairs(["diff-add-fg"], ["diff-add-bg"]),
  ...pairs(["diff-del-fg"], ["diff-del-bg"]),
  ...pairs(["fg-3"], ["diff-gutter"]),
  ...pairs(["fg-1", "fg-2"], ["diff-hunk-bg"]),
  ...pairs(["fg-1"], ["diff-select-bg"]),
  ...pairs(
    ["syn-keyword", "syn-type", "syn-function", "syn-string", "syn-number", "syn-comment", "syn-punct"],
    ["bg-surface", "diff-add-bg", "diff-del-bg", "diff-add-hover", "diff-del-hover", "diff-select-bg"],
    3,
  ),
];

const surfaces = new Set<ColorName>([
  "bg-app",
  "bg-surface",
  "bg-sunken",
  "bg-raised",
  "bg-inverse",
  "bg-reading",
  "bg-reading-card",
]);

/** Flatten surfaces over bg-app, and bg-app over the base's opaque canvas. */
export function themeBackground(colors: ResolvedTheme, base: ThemeBase, name: ColorName, over?: ColorName): ThemeRgba {
  const color = parseThemeColor(colors[name]);
  if (!color) throw new Error("Invalid resolved theme colour");
  if (color.rgba.alpha === 1) return color.rgba;
  const canvas = base === "dark" ? 0 : 1;
  const background =
    name === "bg-app"
      ? { red: canvas, green: canvas, blue: canvas, alpha: 1 }
      : themeBackground(colors, base, over ?? (surfaces.has(name) ? "bg-app" : "bg-surface"));
  return compositeThemeColor(color.rgba, background);
}

export function themeReadabilityProblems(colors: ResolvedTheme, base: ThemeBase): string[] {
  const problems = [...surfaces].flatMap((name) =>
    parseThemeColor(colors[name])?.rgba.alpha === 1 ? [] : [`${name} must be opaque: its colour has transparency.`],
  );
  return problems.concat(
    THEME_READABILITY_PAIRS.flatMap(({ foreground, background, minimum, over }) => {
      const back = themeBackground(colors, base, background, over);
      const front = parseThemeColor(colors[foreground]);
      if (!front) throw new Error("Invalid resolved theme colour");
      const ratio = themeContrast(compositeThemeColor(front.rgba, back), back);
      return ratio < minimum
        ? [`${foreground} on ${background}: ${ratio.toFixed(2)} to 1, needs ${minimum} to 1.`]
        : [];
    }),
  );
}
