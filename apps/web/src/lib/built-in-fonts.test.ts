import { DEFAULT_THEME_FONTS } from "@emend/contract";
import { expect, test } from "vitest";
import { BUILT_IN_FONTS, shouldPrecacheAsset } from "./built-in-fonts.ts";

test("built-in defaults match the contract's theme fonts", () => {
  const defaults = BUILT_IN_FONTS.filter((font) => font.default);
  expect(defaults).toHaveLength(Object.keys(DEFAULT_THEME_FONTS).length);
  expect(Object.fromEntries(defaults.map((font) => [font.role, font.family]))).toEqual(DEFAULT_THEME_FONTS);
});

test.each([
  ["assets/geist-latin-wght-normal-AbC123.woff2", true],
  ["assets/geist-latin-ext-wght-normal-AbC123.woff2", true],
  ["assets/geist-latin-wght-italic-AbC123.woff2", true],
  ["assets/jetbrains-mono-latin-wght-normal-AbC123.woff2", true],
  ["assets/jetbrains-mono-latin-ext-wght-normal-AbC123.woff2", true],
  ["assets/jetbrains-mono-latin-wght-italic-AbC123.woff2", true],
  ["assets/geist-mono-latin-wght-normal-AbC123.woff2", false],
  ["assets/inter-latin-wght-normal-AbC123.woff2", false],
  ["assets/unknown-AbC123.woff2", false],
  ["assets/geist-other-AbC123.woff2", false],
  ["assets/jetbrains-mono-other-AbC123.woff2", false],
  ["assets/geist-latin-directory/unknown.woff2", false],
  ["assets/app-AbC123.js", true],
  ["assets/fonts-AbC123.css", true],
  ["assets/icon-AbC123.png", true],
])("shell precaching for %s is %s", (fileName, expected) => {
  expect(shouldPrecacheAsset(fileName)).toBe(expected);
});
