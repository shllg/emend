import { z } from "zod";
import { LIMITS } from "./limits.ts";

export const THEME_SCALE_STEPS = [
  "n-0",
  "n-25",
  "n-50",
  "n-100",
  "n-200",
  "n-300",
  "n-400",
  "n-500",
  "n-600",
  "n-700",
  "n-800",
  "n-850",
  "n-900",
  "n-950",
  "n-1000",
  "ochre-50",
  "ochre-100",
  "ochre-200",
  "ochre-300",
  "ochre-400",
  "ochre-500",
  "ochre-600",
  "ochre-700",
  "ochre-800",
  "ochre-900",
  "green-50",
  "green-100",
  "green-400",
  "green-500",
  "green-600",
  "green-700",
  "green-900",
  "blue-50",
  "blue-100",
  "blue-400",
  "blue-500",
  "blue-600",
  "blue-700",
  "blue-900",
  "violet-50",
  "violet-100",
  "violet-400",
  "violet-500",
  "violet-600",
  "violet-700",
  "violet-900",
  "teal-50",
  "teal-100",
  "teal-400",
  "teal-500",
  "teal-600",
  "teal-700",
  "red-50",
  "red-100",
  "red-400",
  "red-500",
  "red-600",
  "red-700",
  "red-900",
  "origin-1-bg",
  "origin-1-fg",
  "origin-2-bg",
  "origin-2-fg",
  "origin-3-bg",
  "origin-3-fg",
  "origin-4-bg",
  "origin-4-fg",
  "origin-5-bg",
  "origin-5-fg",
  "origin-6-bg",
  "origin-6-fg",
  "origin-7-bg",
  "origin-7-fg",
  "origin-8-bg",
  "origin-8-fg",
] as const;

export const THEME_TOKENS = [
  "bg-app",
  "bg-surface",
  "bg-sunken",
  "bg-raised",
  "bg-hover",
  "bg-active",
  "bg-selected",
  "bg-inverse",
  "bg-overlay",
  "fg-1",
  "fg-2",
  "fg-3",
  "fg-disabled",
  "fg-inverse",
  "fg-link",
  "fg-link-hover",
  "border-1",
  "border-2",
  "border-strong",
  "border-focus",
  "focus-color",
  "bg-reading",
  "bg-reading-card",
  "fg-reading",
  "fg-reading-muted",
  "fg-reading-strong",
  "accent",
  "accent-hover",
  "accent-press",
  "accent-fg",
  "accent-text",
  "accent-tint",
  "accent-tint-2",
  "mark-bg",
  "mark-bg-active",
  "mark-line",
  "success-fg",
  "success-bg",
  "success-solid",
  "info-fg",
  "info-bg",
  "info-solid",
  "warning-fg",
  "warning-bg",
  "warning-solid",
  "danger-fg",
  "danger-bg",
  "danger-solid",
  "state-open-fg",
  "state-open-bg",
  "state-approved-fg",
  "state-approved-bg",
  "state-settled-fg",
  "state-settled-bg",
  "state-snoozed-fg",
  "state-snoozed-bg",
  "agent-waiting",
  "agent-working",
  "agent-none",
  "agent-approved",
  "thread-open",
  "thread-sent",
  "thread-answered",
  "thread-resolved",
  "outcome-fixed-fg",
  "outcome-fixed-bg",
  "outcome-explained-fg",
  "outcome-explained-bg",
  "outcome-held-fg",
  "outcome-held-bg",
  "outcome-declined-fg",
  "outcome-declined-bg",
  "changed-fg",
  "changed-bg",
  "changed-line",
  "topic-fg",
  "topic-bg",
  "topic-bg-2",
  "topic-solid",
  "topic-line",
  "topic-on-solid",
  "syn-keyword",
  "syn-type",
  "syn-function",
  "syn-string",
  "syn-number",
  "syn-comment",
  "syn-punct",
  "syn-plain",
  "diff-add-bg",
  "diff-add-word",
  "diff-add-hover",
  "diff-add-fg",
  "diff-del-bg",
  "diff-del-word",
  "diff-del-hover",
  "diff-del-fg",
  "diff-gutter",
  "diff-hunk-bg",
  "diff-select-bg",
] as const;

export const ThemeScaleStep = z.enum(THEME_SCALE_STEPS);
export type ThemeScaleStep = z.infer<typeof ThemeScaleStep>;
export const ThemeToken = z.enum(THEME_TOKENS);
export type ThemeToken = z.infer<typeof ThemeToken>;
export const ThemeBase = z.enum(["dark", "light"]);
export type ThemeBase = z.infer<typeof ThemeBase>;
export const THEME_DENSITIES = ["compact", "regular", "roomy"] as const;
export const ThemeDensity = z.enum(THEME_DENSITIES);
export type ThemeDensity = z.infer<typeof ThemeDensity>;
export const ThemeName = z
  .string()
  .max(40)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$(?![\s\S])/)
  .refine((name) => !["system", "dark", "light", "fonts"].includes(name));
export type ThemeName = z.infer<typeof ThemeName>;

// Canonical decimals only: no exponent, redundant zero, sign or trailing fractional zero.
const number = "(?:0|[1-9][0-9]*)(?:\\.[0-9]{0,5}[1-9])?";
const oklch = new RegExp(`^oklch\\((${number}) (${number}) (${number})(?: / (${number}))?\\)$(?![\\s\\S])`);
export const ThemeColor = z
  .string()
  .max(64)
  .refine((value) => {
    if (/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$(?![\s\S])/.test(value)) return true;
    const match = oklch.exec(value);
    if (!match) return false;
    return (
      Number(match[1]) <= 1 &&
      Number(match[2]) <= 0.5 &&
      Number(match[3]) < 360 &&
      (match[4] === undefined || Number(match[4]) < 1)
    );
  }, "Expected a normalized theme colour");
export type ThemeColor = z.infer<typeof ThemeColor>;
export const ThemeFont = z.string().regex(/^[\p{L}\p{N}](?:[\p{L}\p{N} _-]{0,62}[\p{L}\p{N}])?$(?![\s\S])/u);
export type ThemeFont = z.infer<typeof ThemeFont>;
export const ThemeFontFileName = z
  .string()
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:woff2|woff|ttf|otf)$(?![\s\S])/i)
  .refine((name) => !name.includes(".."));
export type ThemeFontFileName = z.infer<typeof ThemeFontFileName>;
const fontWeight = z.number().int().min(1).max(1000);
export const ThemeFontFile = z.object({
  font: z.enum(["text", "code"]),
  file: ThemeFontFileName,
  weight: z.union([fontWeight, z.tuple([fontWeight, fontWeight]).refine(([min, max]) => min <= max)]).optional(),
  style: z.enum(["normal", "italic"]).optional(),
});
export type ThemeFontFile = z.infer<typeof ThemeFontFile>;

/** The response type comes from the allowlisted extension, never from file contents. */
export function themeFontType(file: string): "font/woff2" | "font/woff" | "font/ttf" | "font/otf" | undefined {
  switch (file.slice(file.lastIndexOf(".") + 1).toLowerCase()) {
    case "woff2":
      return "font/woff2";
    case "woff":
      return "font/woff";
    case "ttf":
      return "font/ttf";
    case "otf":
      return "font/otf";
    default:
      return undefined;
  }
}

export const DEFAULT_THEME_FONTS = { text: "Geist", code: "JetBrains Mono" } as const;
const key = z.string().regex(/^[a-z0-9-]{1,40}$(?![\s\S])/);
export const ThemeValid = z.object({
  valid: z.literal(true),
  name: ThemeName,
  base: ThemeBase,
  density: ThemeDensity.optional(),
  fonts: z.object({
    text: ThemeFont.optional(),
    code: ThemeFont.optional(),
    files: z.array(ThemeFontFile).max(LIMITS.themeFontFiles).optional(),
  }),
  scales: z.record(key, ThemeColor),
  tokens: z.record(key, z.union([ThemeColor, ThemeScaleStep])),
  themeColor: z.string().regex(/^#[0-9a-f]{6}$(?![\s\S])/),
});
export type ThemeValid = z.infer<typeof ThemeValid>;
export const ThemeRefused = z.object({
  valid: z.literal(false),
  name: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[^\p{C}]*$/u),
  base: ThemeBase.nullable(),
  problems: z.array(z.string().max(200)).min(1).max(LIMITS.themeProblems),
});
export type ThemeRefused = z.infer<typeof ThemeRefused>;
export const ThemeEntry = z.discriminatedUnion("valid", [ThemeValid, ThemeRefused]);
export type ThemeEntry = z.infer<typeof ThemeEntry>;
export const ThemeList = z.object({ themes: z.array(ThemeEntry).max(LIMITS.themes), folderError: z.boolean() });
export type ThemeList = z.infer<typeof ThemeList>;
