import {
  DEFAULT_THEME_FONTS,
  LIMITS,
  THEME_SCALE_STEPS,
  THEME_TOKENS,
  ThemeBase,
  type ThemeEntry,
  ThemeFont,
  ThemeName,
  ThemeRefused,
  ThemeScaleStep,
  type ThemeToken,
  type ThemeValid,
} from "@emend/contract";
import { THEME_BASES } from "./bases.ts";
import { normalizeThemeColor, parseThemeColor, themeColorHex } from "./color.ts";
import { type ResolvedTheme, themeReadabilityProblems } from "./readability.ts";

export type ThemeSource = ThemeBase | ThemeValid;
export type ThemeDocument = {
  version: 1;
  base: ThemeBase;
  fonts?: { text?: string; code?: string };
  scales?: Partial<Record<ThemeScaleStep, string>>;
  tokens?: Partial<Record<ThemeToken, string>>;
};
const scaleNames = new Set<string>(THEME_SCALE_STEPS);
const tokenNames = new Set<string>(THEME_TOKENS);
const names = [...THEME_SCALE_STEPS, ...THEME_TOKENS];

function themeValues(source: ThemeSource): ResolvedTheme {
  if (typeof source === "string") return THEME_BASES[source];
  const values = { ...THEME_BASES[source.base] };
  // The wire records can contain future names; this version only knows these names.
  for (const name of THEME_SCALE_STEPS)
    if (Object.hasOwn(source.scales, name)) values[name] = source.scales[name] ?? values[name];
  for (const name of THEME_TOKENS)
    if (Object.hasOwn(source.tokens, name)) values[name] = source.tokens[name] ?? values[name];
  return values;
}

export function resolveTheme(source: ThemeSource): ResolvedTheme {
  const values = themeValues(source);
  const resolved = {} as ResolvedTheme;
  function resolve(name: ThemeScaleStep | ThemeToken, seen = new Set<string>()): string {
    if (Object.hasOwn(resolved, name)) return resolved[name];
    if (seen.has(name)) throw new Error("Circular theme reference");
    seen.add(name);
    const value = values[name];
    const color = normalizeThemeColor(value);
    if (color) resolved[name] = color;
    else {
      if (!scaleNames.has(value) && !tokenNames.has(value)) throw new Error("Unknown theme reference");
      resolved[name] = resolve(value as ThemeScaleStep | ThemeToken, seen);
    }
    return resolved[name];
  }
  for (const name of names) resolve(name);
  return resolved;
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const problemName = (name: string) =>
  name.length <= 24 && /^[a-z0-9]+(?:-[a-z0-9]+)*$(?![\s\S])/.test(name) ? name : "an unknown name";

/** Validate an already parsed JSON document. File reads, byte limits and JSON parsing belong to the caller. */
export function checkThemeDocument(document: unknown, name: string): ThemeEntry {
  // Folder readers skip file names that cannot be displayed under the API contract.
  ThemeRefused.shape.name.parse(name);
  const problems: string[] = [];
  let count = 0;
  function problem(message: string) {
    count++;
    if (problems.length < LIMITS.themeProblems) problems.push(message);
  }
  if (!ThemeName.safeParse(name).success)
    problem("The file name must use lowercase letters, digits and hyphens, at most 40, and not system, dark or light.");
  let base: ThemeBase | null = null;
  const fonts: ThemeValid["fonts"] = {};
  const scales: ThemeValid["scales"] = {};
  const tokens: ThemeValid["tokens"] = {};
  if (!object(document)) {
    problem("The file must hold a JSON object.");
  } else {
    if (document.version !== 1) problem("version must be 1.");
    const checkedBase = ThemeBase.safeParse(document.base);
    if (checkedBase.success) base = checkedBase.data;
    else problem('base must be "dark" or "light".');
    for (const key of Object.keys(document)) {
      if (!["version", "base", "fonts", "scales", "tokens"].includes(key))
        problem(`Unknown entry: ${problemName(key)}.`);
    }
    if (Object.hasOwn(document, "fonts")) {
      if (!object(document.fonts)) problem("fonts must be a JSON object.");
      else
        for (const [key, value] of Object.entries(document.fonts)) {
          if (key !== "text" && key !== "code") problem(`fonts has an unknown name: ${problemName(key)}.`);
          else if (!ThemeFont.safeParse(value).success)
            problem(`fonts.${key} must be a plain font name: letters, digits, spaces, hyphens and underscores.`);
          else fonts[key] = value as string;
        }
    }
    for (const section of ["scales", "tokens"] as const) {
      if (!Object.hasOwn(document, section)) continue;
      const entries = document[section];
      if (!object(entries)) {
        problem(`${section} must be a JSON object.`);
        continue;
      }
      for (const [key, value] of Object.entries(entries)) {
        if (!(section === "scales" ? scaleNames : tokenNames).has(key)) {
          problem(`${section} has an unknown name: ${problemName(key)}.`);
          continue;
        }
        const color = normalizeThemeColor(value);
        if (color) (section === "scales" ? scales : tokens)[key] = color;
        else if (section === "tokens" && ThemeScaleStep.safeParse(value).success) tokens[key] = value as ThemeScaleStep;
        else
          problem(
            section === "scales"
              ? `scales.${key} is not a colour. Use hex (#rrggbb) or oklch(L C H).`
              : `tokens.${key} is not a colour or a scale step name.`,
          );
      }
    }
  }
  let themeColor = "#000000";
  if (base) {
    const colors = resolveTheme({ valid: true, name, base, fonts, scales, tokens, themeColor });
    const app = parseThemeColor(colors["bg-app"]);
    if (app?.rgba.alpha === 1) themeColor = themeColorHex(app.rgba);
    for (const message of themeReadabilityProblems(colors, base)) problem(message);
  }
  if (count || !base) {
    if (count > LIMITS.themeProblems)
      problems[LIMITS.themeProblems - 1] = `…and ${count - LIMITS.themeProblems + 1} more problems.`;
    return { valid: false, name, base, problems };
  }
  return { valid: true, name, base, fonts, scales, tokens, themeColor };
}

/** The caller writes JSON.stringify(document, null, 2) followed by a newline. */
export function themeCopyDocument(source: ThemeSource): ThemeDocument {
  const values = themeValues(source);
  const colors = resolveTheme(source);
  const scales: ThemeDocument["scales"] = {};
  const tokens: ThemeDocument["tokens"] = {};
  for (const name of THEME_SCALE_STEPS) scales[name] = colors[name];
  for (const name of THEME_TOKENS) {
    let end: ThemeScaleStep | ThemeToken = name;
    // resolveTheme has already checked the chains for cycles and missing values.
    while (tokenNames.has(values[end])) end = values[end] as ThemeToken;
    tokens[name] = scaleNames.has(values[end]) ? values[end] : colors[name];
  }
  return {
    version: 1,
    base: typeof source === "string" ? source : source.base,
    fonts: { ...DEFAULT_THEME_FONTS, ...(typeof source === "string" ? {} : source.fonts) },
    scales,
    tokens,
  };
}
