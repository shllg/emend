/** Gamma-encoded sRGB channels and alpha, each in [0, 1]. */
export type ThemeRgba = { red: number; green: number; blue: number; alpha: number };
export type ParsedThemeColor = { normalized: string; rgba: ThemeRgba };
const decimal = "(?:[0-9]+(?:\\.[0-9]+)?|\\.[0-9]+)";
const space = "[\\t\\n\\f\\r ]";
const oklch = new RegExp(
  `^oklch\\(${space}*(${decimal}%?)${space}+(${decimal})${space}+(-?${decimal})(?:deg)?(?:${space}*/${space}*(${decimal}%?))?${space}*\\)$(?![\\s\\S])`,
);
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const encode = (linear: number) => {
  const value = clamp(linear);
  if (value === 1) return 1;
  return value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
};
const decode = (value: number) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
const fraction = (value: string) => (value.endsWith("%") ? Number(value.slice(0, -1)) / 100 : Number(value));
const round = (value: number) => Number(value.toFixed(6));

/** Parse only theme data, never CSS expressions. Channels reflect the normalized colour. */
export function parseThemeColor(value: unknown): ParsedThemeColor | null {
  if (typeof value !== "string" || value.length > 64) return null;
  if (/^#(?:[a-f0-9]{3,4}|[a-f0-9]{6}|[a-f0-9]{8})$(?![\s\S])/i.test(value)) {
    const hex = value.slice(1).toLowerCase();
    const full = hex.length < 5 ? [...hex].map((char) => char + char).join("") : hex;
    const channel = (offset: number) => Number.parseInt(full.slice(offset, offset + 2), 16) / 255;
    return {
      normalized: `#${full}`,
      rgba: { red: channel(0), green: channel(2), blue: channel(4), alpha: full.length === 8 ? channel(6) : 1 },
    };
  }
  const match = oklch.exec(value);
  if (!match) return null;
  const lightness = fraction(match[1] ?? "");
  const chroma = Number(match[2]);
  const hue = Number(match[3]);
  const alpha = fraction(match[4] ?? "1");
  if (
    ![lightness, chroma, hue, alpha].every(Number.isFinite) ||
    lightness < 0 ||
    lightness > 1 ||
    chroma < 0 ||
    chroma > 0.5 ||
    alpha < 0 ||
    alpha > 1
  )
    return null;
  const L = round(lightness);
  const C = round(chroma);
  const H = round(((hue % 360) + 360) % 360) % 360;
  const A = round(alpha);
  const a = C * Math.cos((H * Math.PI) / 180);
  const b = C * Math.sin((H * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    normalized: `oklch(${L} ${C} ${H}${A === 1 ? "" : ` / ${A}`})`,
    rgba: {
      red: encode(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
      green: encode(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
      blue: encode(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
      alpha: A,
    },
  };
}

export function normalizeThemeColor(value: unknown): string | null {
  return parseThemeColor(value)?.normalized ?? null;
}

/** Source-over compositing in gamma sRGB, as used by CSS colours. */
export function compositeThemeColor(foreground: ThemeRgba, background: ThemeRgba): ThemeRgba {
  const alpha = foreground.alpha + background.alpha * (1 - foreground.alpha);
  const blend = (front: number, back: number) =>
    alpha === 0 ? 0 : (front * foreground.alpha + back * background.alpha * (1 - foreground.alpha)) / alpha;
  return {
    red: blend(foreground.red, background.red),
    green: blend(foreground.green, background.green),
    blue: blend(foreground.blue, background.blue),
    alpha,
  };
}

/** WCAG contrast of opaque, composited colours. */
export function themeContrast(first: ThemeRgba, second: ThemeRgba): number {
  const luminance = (color: ThemeRgba) =>
    0.2126 * decode(color.red) + 0.7152 * decode(color.green) + 0.0722 * decode(color.blue);
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function themeColorHex(color: ThemeRgba): string {
  return `#${[color.red, color.green, color.blue]
    .map((channel) =>
      Math.round(clamp(channel) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}
