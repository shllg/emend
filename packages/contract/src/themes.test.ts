import { describe, expect, test } from "vitest";
import {
  DEFAULT_THEME_FONTS,
  DownloadTheme,
  LIMITS,
  ReviewEvent,
  ReviewEventName,
  reviewDownloadPath,
  THEME_DENSITIES,
  THEME_SCALE_STEPS,
  THEME_TOKENS,
  ThemeBase,
  ThemeColor,
  ThemeDensity,
  ThemeEntry,
  ThemeFont,
  ThemeFontFile,
  ThemeFontFileName,
  ThemeList,
  ThemeName,
  ThemeRefused,
  ThemeScaleStep,
  ThemeToken,
  ThemeValid,
  themeFontType,
} from "./index.ts";

const valid = { valid: true, name: "mine", base: "dark", fonts: {}, scales: {}, tokens: {}, themeColor: "#090a0c" };
const refused = { valid: false, name: "Wrong Name", base: null, problems: ["theme.json cannot be read."] };

test.each([
  "#ffffff",
  "#aabbcc00",
  "oklch(0.995 0.001 260)",
  "oklch(0 0 0)",
  "oklch(1 0.5 359.999999 / 0.5)",
  "oklch(0.000001 0.1 0 / 0)",
])("accepts normalized colour %s", (color) => expect(ThemeColor.parse(color)).toBe(color));
test.each([
  "red",
  "rgb(0 0 0)",
  "var(--x)",
  "url(x)",
  "#fff;background:red",
  "oklch(1 0 0);}",
  '"#ffffff"',
  "'oklch(0 0 0)'",
  "oklch(1e0 0 0)",
  "oklch(0 0 1E2)",
  "#fff",
  "#ABCDEF",
  "#fffffffff",
  "oklch(.5 0 0)",
  "oklch(50% 0 0)",
  "oklch(0.5 0 0deg)",
  "oklch(0.5 0 -1)",
  "oklch(0.5  0 0)",
  "oklch(0.50 0 0)",
  "oklch(00 0 0)",
  "oklch(0.1234567 0 0)",
  "oklch(0 0 0 / 1)",
  "oklch(0 0 360)",
  "oklch(1.000001 0 0)",
  "oklch(0 0.500001 0)",
  "oklch(0 0 0 / 1.1)",
  "oklch(0 0 0 / -0.1)",
  "#ffffff\n",
  "oklch(0 0 0)\n",
  `#${"a".repeat(64)}`,
  "oklch(0/**/ 0 0)",
  "oklch(+0 0 0)",
])("refuses noncanonical or unsafe colour %s", (color) => expect(ThemeColor.safeParse(color).success).toBe(false));

test("names and vocabulary have the specified boundaries", () => {
  for (const name of ["a", "0", "my-theme", "a--b", "a".repeat(40)]) expect(ThemeName.parse(name)).toBe(name);
  for (const name of [
    "",
    "system",
    "dark",
    "light",
    "fonts",
    "Dark",
    "two words",
    "x_y",
    "-x",
    "x-",
    "a".repeat(41),
    "a\n",
    "../a",
  ])
    expect(ThemeName.safeParse(name).success, name).toBe(false);
  expect(ThemeScaleStep.options).toEqual(THEME_SCALE_STEPS);
  expect(ThemeToken.options).toEqual(THEME_TOKENS);
  expect(ThemeBase.options).toEqual(["dark", "light"]);
  expect(ThemeDensity.options).toEqual(THEME_DENSITIES);
  expect(ThemeScaleStep.safeParse("fg-1").success).toBe(false);
  expect(ThemeToken.safeParse("n-25").success).toBe(false);
});
test("fonts are plain bounded Unicode names", () => {
  expect(DEFAULT_THEME_FONTS).toEqual({ text: "Geist", code: "JetBrains Mono" });
  for (const name of ["Geist", "JetBrains Mono", "字体", "Écriture 2", "A_B-C", "A", "1", "a".repeat(64)])
    expect(ThemeFont.parse(name)).toBe(name);
  for (const name of [
    "",
    " x",
    "x ",
    "-x",
    "x_",
    "a".repeat(65),
    "x,y",
    '"Geist"',
    "url(x)",
    "x; color:red",
    "x\n",
    "x\u200b",
  ])
    expect(ThemeFont.safeParse(name).success, name).toBe(false);
});
test.each(["InterVariable.woff2", "A.woff", "A_1-B.ttf", "A.B.OTF", `${"a".repeat(94)}.woff2`])(
  "accepts font file name %s",
  (file) => expect(ThemeFontFileName.parse(file)).toBe(file),
);
test.each([
  "",
  "x.css",
  "x.svg",
  "x.woff2.js",
  "sub/x.woff2",
  "/x.woff2",
  "sub\\x.woff2",
  "../x.woff2",
  "x..woff2",
  "x%2Fy.woff2",
  ".x.woff2",
  "x y.woff2",
  "x.woff2\n",
  "x\0.woff2",
  `${"a".repeat(95)}.woff2`,
])("refuses unsafe font file name %j", (file) => expect(ThemeFontFileName.safeParse(file).success).toBe(false));
test.each([
  ["Font.WOFF2", "font/woff2"],
  ["Font.woff", "font/woff"],
  ["Font.TTF", "font/ttf"],
  ["Font.otf", "font/otf"],
  ["Font.css", undefined],
] as const)("font file %s has a server-chosen type", (file, type) => expect(themeFontType(file)).toBe(type));
test("font entries validate descriptors and bound the list", () => {
  const entry = { font: "text", file: "Example.woff2" };
  for (const weight of [undefined, 1, 400, 1000, [1, 1000], [400, 400]])
    for (const style of [undefined, "normal", "italic"])
      expect(ThemeFontFile.safeParse({ ...entry, weight, style }).success).toBe(true);
  for (const patch of [
    { font: "other" },
    { file: "x.svg" },
    { style: "oblique" },
    { style: null },
    ...[null, "400", 0, 1001, 1.5, [900, 100], [0, 400], [1, 1001], [1.5, 400], [1], [1, 2, 3]].map((weight) => ({
      weight,
    })),
  ])
    expect(ThemeFontFile.safeParse({ ...entry, ...patch }).success).toBe(false);
  const fonts = { text: "Example", files: Array(LIMITS.themeFontFiles).fill(entry) };
  expect(ThemeValid.parse({ ...valid, fonts }).fonts).toEqual(fonts);
  expect(ThemeValid.safeParse({ ...valid, fonts: { ...fonts, files: [...fonts.files, entry] } }).success).toBe(false);
  expect(LIMITS).toMatchObject({ themeFontFiles: 16, themeFontBytes: 4194304 });
});
test("font entries and theme lists strip unknown entry keys for additive API fields", () => {
  const entry = { font: "text", file: "Example.woff2", weight: [100, 900], style: "italic" };
  const extended = { ...entry, extra: true };
  expect(ThemeFontFile.parse(extended)).toEqual(entry);
  const theme = { ...valid, fonts: { text: "Example", files: [extended] } };
  expect(ThemeList.parse({ themes: [theme], folderError: false })).toEqual({
    themes: [{ ...theme, fonts: { text: "Example", files: [entry] } }],
    folderError: false,
  });
});
test("valid entries carry overrides and permit future record names", () => {
  const entry = {
    ...valid,
    fonts: DEFAULT_THEME_FONTS,
    scales: { "future-1": "#ffffff" },
    tokens: { "future-bg": "n-0", "fg-1": "#ffffff" },
  };
  expect(ThemeValid.parse(entry)).toEqual(entry);
  expect(ThemeEntry.parse(entry)).toEqual(entry);
  for (const patch of [
    { name: "dark" },
    { base: "system" },
    { fonts: { text: "url(x)" } },
    { scales: { "n-0": "n-25" } },
    { tokens: { "bg-reading": "bg-app" } },
    { tokens: { "fg-1": "red" } },
    { scales: { "Bad key": "#ffffff" } },
    { tokens: { ["a".repeat(41)]: "#ffffff" } },
    { themeColor: "#fff" },
    { themeColor: "#aabbccff" },
    { themeColor: "#AABBCC" },
  ])
    expect(ThemeValid.safeParse({ ...valid, ...patch }).success).toBe(false);
});
test.each(["compact", "regular", "roomy"])("valid entries accept %s density", (density) => {
  expect(ThemeValid.parse({ ...valid, density })).toEqual({ ...valid, density });
});
test("valid entries accept an absent density for older servers and saved themes", () => {
  expect(ThemeValid.parse(valid)).toEqual(valid);
});
test.each(["dense", "Compact", "", 1, null, {}, []])("valid entries refuse invalid density %j", (density) => {
  expect(ThemeValid.safeParse({ ...valid, density }).success).toBe(false);
});
test("refused entries and theme lists enforce wire limits", () => {
  expect(ThemeEntry.parse(refused)).toEqual(refused);
  expect(
    ThemeRefused.parse({ ...refused, name: "a".repeat(80), problems: Array(20).fill("x".repeat(200)) }),
  ).toBeTruthy();
  for (const patch of [
    { name: "" },
    { name: "a".repeat(81) },
    { name: "bad\n" },
    { name: "bad\u200b" },
    { problems: [] },
    { problems: Array(21).fill("bad") },
    { problems: ["x".repeat(201)] },
    { base: "unknown" },
  ])
    expect(ThemeRefused.safeParse({ ...refused, ...patch }).success).toBe(false);
  expect(ThemeList.parse({ themes: [valid, refused], folderError: false }).themes).toHaveLength(2);
  expect(ThemeList.parse({ themes: [], folderError: true }).folderError).toBe(true);
  expect(ThemeList.safeParse({ themes: Array(50).fill(valid), folderError: false }).success).toBe(true);
  expect(ThemeList.safeParse({ themes: Array(51).fill(valid), folderError: false }).success).toBe(false);
  expect(ThemeList.safeParse({ themes: [] }).success).toBe(false);
  expect(LIMITS).toMatchObject({ themes: 50, themeFileBytes: 32768, themeProblems: 20 });
});
describe("themes on the API", () => {
  test("the event has no review id", () => {
    expect(ReviewEventName.parse("themes")).toBe("themes");
    expect(ReviewEvent.parse({ type: "themes" })).toEqual({ type: "themes" });
    expect(ReviewEvent.parse({ type: "themes", reviewId: "ignored" })).toEqual({ type: "themes" });
  });
  test("downloads accept one base or theme name", () => {
    for (const value of [[], ["dark"], ["light"], ["mine"], ["x"]]) expect(DownloadTheme.parse(value)).toEqual(value);
    for (const value of [["system"], ["mine", "dark"], ["mine", "mine"], ["../mine"], ["Bad"], [""]])
      expect(DownloadTheme.safeParse(value).success).toBe(false);
    expect(reviewDownloadPath("review", 1, [], { theme: "mine" })).toBe(
      "/api/v1/reviews/review/revisions/1/download?theme=mine",
    );
    expect(reviewDownloadPath("review", 1, [], { theme: "bad&diff=1" })).toContain("theme=bad%26diff%3D1");
  });
});
