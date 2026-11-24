import {
  DEFAULT_THEME_FONTS,
  LIMITS,
  THEME_SCALE_STEPS,
  THEME_TOKENS,
  ThemeBase,
  ThemeDensity,
  type ThemeEntry,
  ThemeFont,
  ThemeFontFile,
  ThemeName,
  ThemeRefused,
  ThemeScaleStep,
  type ThemeToken,
  type ThemeValid,
} from "@recense/contract";
import { THEME_BASES } from "./bases.ts";
import { normalizeThemeColor, parseThemeColor, themeColorHex } from "./color.ts";
import { type ResolvedTheme, themeReadabilityProblems } from "./readability.ts";

export type ThemeSource = ThemeBase | ThemeValid;
export type ThemeDocument = {
  version: 1;
  base: ThemeBase;
  density?: ThemeDensity;
  fonts?: ThemeValid["fonts"];
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
  // Folder readers skip names that cannot be displayed under the API contract.
  ThemeRefused.shape.name.parse(name);
  const problems: string[] = [];
  let count = 0;
  function problem(message: string) {
    count++;
    if (problems.length < LIMITS.themeProblems) problems.push(message);
  }
  if (!ThemeName.safeParse(name).success)
    problem(
      "The folder name must use lowercase letters, digits and hyphens, at most 40, and not system, dark, light or fonts.",
    );
  let base: ThemeBase | null = null;
  let density: ThemeDensity | undefined;
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
      if (!["version", "base", "density", "fonts", "scales", "tokens"].includes(key))
        problem(`Unknown entry: ${problemName(key)}.`);
    }
    if (Object.hasOwn(document, "density")) {
      const checkedDensity = ThemeDensity.safeParse(document.density);
      if (checkedDensity.success) density = checkedDensity.data;
      else problem('density must be "compact", "regular" or "roomy".');
    }
    if (Object.hasOwn(document, "fonts")) {
      if (!object(document.fonts)) problem("fonts must be a JSON object.");
      else {
        for (const [key, value] of Object.entries(document.fonts)) {
          if (key === "files") continue;
          if (key !== "text" && key !== "code") problem(`fonts has an unknown name: ${problemName(key)}.`);
          else if (!ThemeFont.safeParse(value).success)
            problem(`fonts.${key} must be a plain font name: letters, digits, spaces, hyphens and underscores.`);
          else fonts[key] = value as string;
        }
        if (Object.hasOwn(document.fonts, "files")) {
          const files = document.fonts.files;
          if (!Array.isArray(files)) problem("fonts.files must be a list.");
          else if (files.length > LIMITS.themeFontFiles)
            problem(`fonts.files has more than ${LIMITS.themeFontFiles} entries.`);
          else {
            fonts.files = [];
            for (const [index, entry] of files.entries()) {
              const prefix = `fonts.files[${index}]`;
              if (!object(entry)) {
                problem(`${prefix} must be a JSON object.`);
                continue;
              }
              for (const key of Object.keys(entry))
                if (!["font", "file", "weight", "style"].includes(key))
                  problem(`${prefix} has an unknown name: ${problemName(key)}.`);
              const font = ThemeFontFile.shape.font.safeParse(entry.font);
              if (!font.success) problem(`${prefix}.font must be "text" or "code".`);
              else if (fonts[font.data] === undefined)
                problem(`${prefix} is for the ${font.data} font, but fonts.${font.data} is not set.`);
              if (!ThemeFontFile.shape.file.safeParse(entry.file).success)
                problem(
                  `${prefix}.file must be a .woff2, .woff, .ttf or .otf file name: letters, digits, dots, hyphens and underscores.`,
                );
              if (!ThemeFontFile.shape.weight.safeParse(entry.weight).success)
                problem(
                  `${prefix}.weight must be a whole number from 1 to 1000, or two of them in a list, lowest first.`,
                );
              if (!ThemeFontFile.shape.style.safeParse(entry.style).success)
                problem(`${prefix}.style must be "normal" or "italic".`);
              const checked = ThemeFontFile.safeParse(entry);
              if (checked.success) fonts.files.push(checked.data);
            }
          }
        }
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
  return { valid: true, name, base, ...(density === undefined ? {} : { density }), fonts, scales, tokens, themeColor };
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
    density: typeof source === "string" ? "regular" : (source.density ?? "regular"),
    fonts: { ...DEFAULT_THEME_FONTS, ...(typeof source === "string" ? {} : source.fonts) },
    scales,
    tokens,
  };
}
