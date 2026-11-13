// @vitest-environment node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const colors = readFileSync(resolve(import.meta.dirname, "colors.css"), "utf8");
type Tokens = Map<string, string>;

function parseTokens(pattern: RegExp): Tokens {
  const block = pattern.exec(colors)?.[1];
  if (!block) throw new Error(`Missing colour block: ${pattern}`);
  return new Map(
    [...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((match) => [match[1] ?? "", match[2]?.trim() ?? ""]),
  );
}

const light = parseTokens(/^:root\s*\{([^}]+)\}/m);
const systemDark = parseTokens(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]+)\}/);
const explicitDark = parseTokens(/\[data-theme="dark"\]\s*\{([^}]+)\}/);
const readingNames = ["--bg-reading", "--bg-reading-card", "--fg-reading", "--fg-reading-muted", "--fg-reading-strong"];
const readingTokens = (tokens: Tokens) => Object.fromEntries(readingNames.map((name) => [name, tokens.get(name)]));

function resolveToken(name: string, tokens: Tokens, seen = new Set<string>()): string {
  if (seen.has(name)) throw new Error(`Circular colour token: ${name}`);
  seen.add(name);
  const value = tokens.get(name) ?? light.get(name);
  if (!value) throw new Error(`Missing colour token: ${name}`);
  const alias = /^var\((--[\w-]+)\)$/.exec(value)?.[1];
  return alias ? resolveToken(alias, tokens, seen) : value;
}

function linearSrgb(value: string) {
  const match = /^oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/.exec(value);
  if (!match) throw new Error(`Expected an OKLCH colour: ${value}`);
  const lightness = Number(match[1]);
  const chroma = Number(match[2]);
  const hue = (Number(match[3]) * Math.PI) / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);

  // OKLab to linear sRGB; WCAG weights apply directly to these linear channels.
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const red = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const green = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const blue = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return { red, green, blue, alpha: Number(match[4] ?? 1) };
}

function luminance(name: string, tokens: Tokens): number {
  const value = resolveToken(name, tokens);
  const { red, green, blue, alpha } = linearSrgb(value);
  if (alpha !== 1) throw new Error(`Expected an opaque OKLCH colour: ${value}`);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

// Composite clamped gamma sRGB channels over an opaque backdrop, then linearize for WCAG luminance.
function compositedLuminance(name: string, backdrop: string, tokens: Tokens): number {
  const { red, green, blue, alpha } = linearSrgb(resolveToken(name, tokens));
  const background = linearSrgb(resolveToken(backdrop, tokens));
  if (background.alpha !== 1) throw new Error(`Expected an opaque backdrop: ${backdrop}`);
  const encode = (channel: number) => {
    const clamped = Math.max(0, Math.min(1, channel));
    return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
  };
  const blend = (foreground: number, background: number) => {
    const channel = alpha * encode(foreground) + (1 - alpha) * encode(background);
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * blend(red, background.red) +
    0.7152 * blend(green, background.green) +
    0.0722 * blend(blue, background.blue)
  );
}

function contrast(first: number, second: number): number {
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

test("light mode keeps the app colours", () => {
  expect(readingTokens(light)).toEqual({
    "--bg-reading": "var(--bg-app)",
    "--bg-reading-card": "var(--bg-surface)",
    "--fg-reading": "var(--fg-1)",
    "--fg-reading-muted": "oklch(0.55 0.004 260)",
    "--fg-reading-strong": "var(--fg-1)",
  });
});

test("both dark blocks declare the same reading colours", () => {
  expect(readingTokens(systemDark)).toEqual({
    "--bg-reading": "var(--bg-surface)",
    "--bg-reading-card": "var(--bg-raised)",
    "--fg-reading": "oklch(0.79 0.004 260)",
    "--fg-reading-muted": "var(--n-400)",
    "--fg-reading-strong": "var(--n-200)",
  });
  expect(readingTokens(explicitDark)).toEqual(readingTokens(systemDark));
});

test.each([
  { name: "light", tokens: light },
  { name: "system dark", tokens: systemDark },
  { name: "explicit dark", tokens: explicitDark },
])("$name snoozed pill text keeps at least 4.5:1 contrast over the header surface", ({ tokens }) => {
  const background = compositedLuminance("--state-snoozed-bg", "--bg-surface", tokens);
  expect(contrast(luminance("--state-snoozed-fg", tokens), background)).toBeGreaterThanOrEqual(4.5);
});

test.each([
  { name: "light", tokens: light },
  { name: "system dark", tokens: systemDark },
  { name: "explicit dark", tokens: explicitDark },
])("$name code text keeps at least 4.5:1 contrast against the sunken background", ({ tokens }) => {
  expect(contrast(luminance("--fg-reading", tokens), luminance("--bg-sunken", tokens))).toBeGreaterThanOrEqual(4.5);
});

test.each([
  { name: "light", tokens: light },
  { name: "system dark", tokens: systemDark },
  { name: "explicit dark", tokens: explicitDark },
])("$name muted text keeps at least 4.5:1 contrast and is dimmer than body text", ({ tokens }) => {
  const page = luminance("--bg-reading", tokens);
  const mutedContrast = contrast(luminance("--fg-reading-muted", tokens), page);
  expect(mutedContrast).toBeGreaterThanOrEqual(4.5);
  expect(mutedContrast).toBeLessThan(contrast(luminance("--fg-reading", tokens), page));
});

describe.each([
  { name: "system dark", tokens: systemDark },
  { name: "explicit dark", tokens: explicitDark },
])("$name", ({ tokens }) => {
  test("the reading page matches the header bar and tabs row", () => {
    expect(resolveToken("--bg-reading", tokens)).toBe(resolveToken("--bg-surface", tokens));
  });

  test.each(["--bg-reading", "--bg-reading-card", "--bg-sunken"])(
    "body text keeps at least 4.5:1 contrast against %s",
    (background) => {
      expect(contrast(luminance("--fg-reading", tokens), luminance(background, tokens))).toBeGreaterThanOrEqual(4.5);
    },
  );

  test("body text is brighter and strong text is darker, with a smaller step between them", () => {
    const body = luminance("--fg-reading", tokens);
    const strong = luminance("--fg-reading-strong", tokens);
    const page = luminance("--bg-reading", tokens);
    expect(body).toBeGreaterThan(luminance("--fg-3", tokens));
    expect(strong).toBeLessThan(luminance("--fg-1", tokens));
    expect(strong).toBeGreaterThan(body);
    expect(contrast(strong, page) / contrast(body, page)).toBeLessThanOrEqual(1.5);
  });

  test("the card stands out at least as much as before", () => {
    const previous = contrast(luminance("--bg-surface", tokens), luminance("--bg-app", tokens));
    const current = contrast(luminance("--bg-reading-card", tokens), luminance("--bg-reading", tokens));
    expect(current).toBeGreaterThanOrEqual(previous);
  });
});

test("reading rules use the reading colour tokens", () => {
  const prose = readFileSync(resolve(import.meta.dirname, "prose.css"), "utf8");
  const reading = readFileSync(resolve(import.meta.dirname, "reading.css"), "utf8");
  const threads = readFileSync(resolve(import.meta.dirname, "threads.css"), "utf8");
  expect(/\.em-prose\s*\{([^}]+)\}/.exec(prose)?.[1]).toMatch(/\bcolor:\s*var\(--fg-reading\)\s*;/);
  expect(/\.em-prose :is\(h1, h2, h3, h5, h6, strong, code\)\s*\{([^}]+)\}/.exec(prose)?.[1]).toMatch(
    /\bcolor:\s*var\(--fg-reading-strong\)\s*;/,
  );
  expect(/\.em-writeup-card\s*\{([^}]+)\}/.exec(reading)?.[1]).toMatch(/\bbackground:\s*var\(--bg-reading-card\)\s*;/);
  expect(/\.em-thread__comments\s*\{([^}]+)\}/.exec(threads)?.[1]).toMatch(/\bcolor:\s*var\(--fg-reading-strong\)\s*;/);
  expect(
    /\.em-writeup-quiet \.em-prose :is\(code, pre\),\s*\.em-writeup-muted \.em-prose :is\(code, pre\)\s*\{([^}]+)\}/.exec(
      reading,
    )?.[1],
  ).toMatch(/\bcolor:\s*var\(--fg-reading\)\s*;/);
});

test.each([
  { tone: "quiet", reduction: 1, labelColor: "--fg-reading" },
  { tone: "muted", reduction: 2, labelColor: "--fg-reading-muted" },
])("$tone writeup prose follows the reader size and colour hierarchy", ({ tone, reduction, labelColor }) => {
  const reading = readFileSync(resolve(import.meta.dirname, "reading.css"), "utf8");
  const rule = new RegExp(`\\.em-writeup-${tone} \\.em-prose\\s*\\{([^}]+)\\}`).exec(reading)?.[1];
  expect(rule).toContain(`font-size: calc(var(--reader-prose-size, var(--type-prose-size)) - ${reduction}px);`);
  expect(rule).not.toMatch(/\bfont-size:\s*[\d.]+px\s*;/);
  expect(rule).toMatch(/\bcolor:\s*var\(--fg-reading-muted\)\s*;/);

  const labels = new RegExp(
    `\\.em-writeup-${tone} \\.em-prose :is\\(([^)]+)\\),\\s*\\.em-writeup-${tone} \\.em-prose li::marker\\s*\\{([^}]+)\\}`,
  ).exec(reading);
  expect(labels?.[1]).toBe("strong, h1, h2, h3, h4, h5, h6");
  expect(labels?.[2]).toContain(`color: var(${labelColor});`);
});

test.each(["emend-comment", "emend-comment-active"])(
  "%s highlights use body text colour throughout quiet and muted writeup prose",
  (highlight) => {
    const reading = readFileSync(resolve(import.meta.dirname, "reading.css"), "utf8");
    const rules = [...reading.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    for (const descendant of ["", " *"]) {
      const selector = `:is(.em-writeup-quiet, .em-writeup-muted) .em-prose${descendant}::highlight(${highlight})`;
      const rule = rules.find((match) => match[1]?.includes(selector));
      expect(rule?.[2]?.trim(), selector).toBe("color: var(--fg-reading);");
    }
  },
);

test("quiet and muted writeup links inherit colour after the strong and code rules", () => {
  const reading = readFileSync(resolve(import.meta.dirname, "reading.css"), "utf8");
  const links =
    /\.em-writeup-quiet \.em-prose a :is\(strong, code\),\s*\.em-writeup-muted \.em-prose a :is\(strong, code\)\s*\{([^}]+)\}/.exec(
      reading,
    );
  expect(links?.[1]).toMatch(/\bcolor:\s*inherit\s*;/);
  for (const tone of ["quiet", "muted"]) {
    for (const elements of ["strong, h1, h2, h3, h4, h5, h6", "code, pre"]) {
      const position = reading.indexOf(`.em-writeup-${tone} .em-prose :is(${elements})`);
      expect(position).toBeGreaterThanOrEqual(0);
      expect(links?.index).toBeGreaterThan(position);
    }
  }
});
