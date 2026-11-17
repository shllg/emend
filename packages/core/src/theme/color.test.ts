import { ThemeColor } from "@emend/contract";
import { expect, test } from "vitest";
import { compositeThemeColor, normalizeThemeColor, parseThemeColor, themeColorHex, themeContrast } from "./color.ts";

test.each([
  ["#aBc", "#aabbcc"],
  ["#aBcD", "#aabbccdd"],
  ["#AABBCC", "#aabbcc"],
  ["#AABBCCDD", "#aabbccdd"],
  ["oklch(0.995 0.001 260)", "oklch(0.995 0.001 260)"],
  ["oklch(.5 .1 0)", "oklch(0.5 0.1 0)"],
  ["oklch(50% 0.10 90deg)", "oklch(0.5 0.1 90)"],
  ["oklch(1 0 -30)", "oklch(1 0 330)"],
  ["oklch(0 0 -720deg / 100%)", "oklch(0 0 0)"],
  ["oklch(1 0 720 / .5)", "oklch(1 0 0 / 0.5)"],
  ["oklch(50% .1 30 / 25%)", "oklch(0.5 0.1 30 / 0.25)"],
  ["oklch(0 0 0/0)", "oklch(0 0 0 / 0)"],
  ["oklch(0.12345678 0.12345678 359.9999999 / 0.9999999)", "oklch(0.123457 0.123457 0)"],
  ["oklch(\t.5\n0 0 )", "oklch(0.5 0 0)"],
  ["oklch(.0000001 0 0)", "oklch(0 0 0)"],
])("normalizes %s to %s", (input, expected) => {
  expect(normalizeThemeColor(input)).toBe(expected);
  expect(ThemeColor.parse(expected)).toBe(expected);
  expect(normalizeThemeColor(expected)).toBe(expected);
});
test.each([
  "red",
  "rgb(0 0 0)",
  "var(--x)",
  "url(x)",
  "#fff;background:red",
  "oklch(1 0 0);}",
  '"#fff"',
  "'oklch(0 0 0)'",
  "oklch(1e0 0 0)",
  "oklch(0 0 -1e2)",
  "oklch(+1 0 0)",
  "oklch(0 -0.1 0)",
  "oklch(-0.1 0 0)",
  "oklch(0 0 +1)",
  "oklch(0 0 0 / -1)",
  "oklch(1.01 0 0)",
  "oklch(101% 0 0)",
  "oklch(0 0.501 0)",
  "oklch(0 0 0 / 1.001)",
  "oklch(0 0 0 / 101%)",
  "oklch(0 0 Infinity)",
  "oklch(0 0 NaN)",
  "oklch(0,0,0)",
  "oklch(0/**/ 0 0)",
  "oklch(0 0 0rad)",
  "oklch(0 0% 0)",
  "oklch(0 0 0%)",
  "#fffff",
  "#ggg",
  "#ffffff\n",
  `oklch(${"0".repeat(60)} 0 0)`,
  "",
  null,
  {},
  0,
])("refuses non-colour %s", (input) => expect(parseThemeColor(input)).toBeNull());

function rgba(value: string) {
  const parsed = parseThemeColor(value);
  if (!parsed) throw new Error("Bad test colour");
  return parsed.rgba;
}
test("hex alpha and oklch map to clipped gamma sRGB", () => {
  expect(rgba("#f008")).toEqual({ red: 1, green: 0, blue: 0, alpha: 136 / 255 });
  expect(rgba("oklch(0 0 0)")).toEqual({ red: 0, green: 0, blue: 0, alpha: 1 });
  expect(themeColorHex(rgba("oklch(1 0 0)"))).toBe("#ffffff");
  for (const channel of Object.values(rgba("oklch(0.7 0.5 30)"))) {
    expect(channel).toBeGreaterThanOrEqual(0);
    expect(channel).toBeLessThanOrEqual(1);
  }
});
test("composites gamma channels before WCAG luminance", () => {
  const black = rgba("#000");
  const white = rgba("#fff");
  expect(themeContrast(black, white)).toBe(21);
  expect(themeContrast(white, black)).toBe(21);
  expect(themeContrast(black, black)).toBe(1);
  const grey = compositeThemeColor(rgba("oklch(1 0 0 / 0.5)"), black);
  expect(grey.red).toBeCloseTo(0.5);
  expect(themeContrast(grey, black)).toBeCloseTo(5.2808, 4);
  expect(themeColorHex(grey)).toBe("#808080");
  expect(compositeThemeColor(rgba("#0000"), rgba("#0000"))).toEqual({ ...black, alpha: 0 });
  expect(compositeThemeColor({ ...white, alpha: 0.5 }, { ...black, alpha: 0.5 })).toEqual({
    red: 2 / 3,
    green: 2 / 3,
    blue: 2 / 3,
    alpha: 0.75,
  });
});
