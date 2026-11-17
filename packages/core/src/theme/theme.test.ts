import { DEFAULT_THEME_FONTS, THEME_SCALE_STEPS, THEME_TOKENS, ThemeEntry, type ThemeValid } from "@emend/contract";
import { expect, test } from "vitest";
import { compositeThemeColor, parseThemeColor, themeColorHex } from "./color.ts";
import { themeDownloadLook } from "./download.ts";
import { THEME_READABILITY_PAIRS, themeBackground, themeReadabilityProblems } from "./readability.ts";
import { checkThemeDocument, resolveTheme, themeCopyDocument } from "./theme.ts";

const document = { version: 1, base: "dark" };
function check(value: unknown, name = "mine"): ThemeValid {
  const entry = checkThemeDocument(value, name);
  expect(entry.valid, JSON.stringify(entry)).toBe(true);
  if (!entry.valid) throw new Error("Expected a valid theme");
  expect(ThemeEntry.parse(entry)).toEqual(entry);
  return entry;
}
function problems(value: unknown, name = "mine"): string[] {
  const entry = checkThemeDocument(value, name);
  expect(entry.valid).toBe(false);
  if (entry.valid) throw new Error("Expected a refused theme");
  expect(ThemeEntry.parse(entry)).toEqual(entry);
  return entry.problems;
}
test.each(["dark", "light"] as const)("%s passes all readability pairs", (base) => {
  expect(check({ version: 1, base })).toMatchObject({ base, scales: {}, tokens: {}, fonts: {} });
  expect(themeReadabilityProblems(resolveTheme(base), base)).toEqual([]);
});
test("the readability set covers exactly the design's 146 pairs", () => {
  expect(THEME_READABILITY_PAIRS).toHaveLength(146);
  expect(THEME_READABILITY_PAIRS.filter((pair) => pair.minimum === 3)).toHaveLength(59);
  expect(THEME_READABILITY_PAIRS.filter((pair) => pair.over)).toHaveLength(23);
  expect(THEME_READABILITY_PAIRS).toEqual(
    expect.arrayContaining([
      { foreground: "fg-reading", background: "mark-bg", over: "bg-reading", minimum: 4.5 },
      ...["fg-reading", "fg-reading-strong", "fg-reading-muted"].flatMap((foreground) =>
        ["bg-sunken", "diff-add-bg", "diff-del-bg"].map((background) => ({
          foreground,
          background,
          ...(background === "bg-sunken" ? {} : { over: "bg-sunken" }),
          minimum: foreground === "fg-reading-muted" ? 3 : 4.5,
        })),
      ),
      ...["syn-keyword", "syn-type", "syn-function", "syn-string", "syn-number", "syn-comment", "syn-punct"].flatMap(
        (foreground) =>
          ["diff-add-hover", "diff-del-hover", "diff-select-bg"].map((background) => ({
            foreground,
            background,
            minimum: 3,
          })),
      ),
      ...[
        "syn-plain",
        "syn-keyword",
        "syn-type",
        "syn-function",
        "syn-string",
        "syn-number",
        "syn-comment",
        "syn-punct",
      ].flatMap((foreground) =>
        ["add", "del"].map((kind) => ({
          foreground,
          background: `diff-${kind}-word`,
          over: `diff-${kind}-bg`,
          minimum: foreground === "syn-plain" ? 4.5 : 3,
        })),
      ),
    ]),
  );
  expect(THEME_READABILITY_PAIRS.some((pair) => pair.foreground === "fg-disabled")).toBe(false);
});
test.each([
  [null, "The file must hold a JSON object."],
  [[], "The file must hold a JSON object."],
  ["text", "The file must hold a JSON object."],
  [{}, "version must be 1."],
  [{ ...document, version: "1" }, "version must be 1."],
  [{ ...document, base: "Dark" }, 'base must be "dark" or "light".'],
  [{ ...document, colours: {} }, "Unknown entry: colours."],
  [{ ...document, fonts: null }, "fonts must be a JSON object."],
  [{ ...document, scales: [] }, "scales must be a JSON object."],
  [{ ...document, tokens: "x" }, "tokens must be a JSON object."],
  [
    { ...document, fonts: { text: '"Bad Font"' } },
    "fonts.text must be a plain font name: letters, digits, spaces, hyphens and underscores.",
  ],
  [
    { ...document, fonts: { code: "url(font)" } },
    "fonts.code must be a plain font name: letters, digits, spaces, hyphens and underscores.",
  ],
  [{ ...document, fonts: { other: "Geist" } }, "fonts has an unknown name: other."],
  [{ ...document, scales: { "n-25": "red" } }, "scales.n-25 is not a colour. Use hex (#rrggbb) or oklch(L C H)."],
  [{ ...document, scales: { "n-26": "#fff" } }, "scales has an unknown name: n-26."],
  [{ ...document, tokens: { "fg-1": "red" } }, "tokens.fg-1 is not a colour or a scale step name."],
  [{ ...document, tokens: { other: "#fff" } }, "tokens has an unknown name: other."],
])("document validation uses safe fixed reasons: %j", (input, expected) => expect(problems(input)).toContain(expected));
test("invalid file names get the specified reason and base when known", () => {
  expect(problems(document, "Dark")).toEqual([
    "The file name must use lowercase letters, digits and hyphens, at most 40, and not system, dark or light.",
  ]);
  expect(checkThemeDocument(null, "mine")).toMatchObject({ base: null });
  expect(checkThemeDocument({ base: "unknown" }, "mine")).toMatchObject({ base: null });
});
test.each([
  "x\n",
  "x--y",
  "UPPER",
  "<script>",
  "bad_name",
  "bad key",
  "-a",
  "a-",
  "a".repeat(25),
  "__proto__",
  "constructor",
])("unknown names only appear when safe: %s", (key) => {
  // constructor is a safe plain key; object prototypes must not make it a known key.
  const shown = key === "constructor" ? key : "an unknown name";
  expect(problems({ ...document, [key]: "untrusted contents" })).toEqual([`Unknown entry: ${shown}.`]);
  for (const section of ["fonts", "scales", "tokens"]) {
    expect(problems({ ...document, [section]: { [key]: "untrusted contents" } })).toEqual([
      `${section} has an unknown name: ${shown}.`,
    ]);
  }
});
test("safe unknown names include digits and the 24-character boundary", () => {
  for (const key of ["0", "colour-2", "a".repeat(24)])
    expect(problems({ ...document, [key]: null })).toEqual([`Unknown entry: ${key}.`]);
});
test("problems are capped at 20 with the remaining count", () => {
  const extra = (n: number) =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`unknown-${i}`, "private value"]));
  expect(problems({ ...document, ...extra(20) })).toHaveLength(20);
  const refused = problems({ ...document, ...extra(25) });
  expect(refused).toHaveLength(20);
  expect(refused.at(-1)).toBe("…and 6 more problems.");
  expect(refused.join(" ")).not.toContain("private value");
});
test("only tokens can reference a scale step, never a token", () => {
  expect(check({ ...document, tokens: { "fg-1": "n-50" } }).tokens).toEqual({ "fg-1": "n-50" });
  expect(problems({ ...document, scales: { "n-0": "n-25" } })).toContain(
    "scales.n-0 is not a colour. Use hex (#rrggbb) or oklch(L C H).",
  );
  for (const value of ["fg-2", "var(--n-50)", "n-26"])
    expect(problems({ ...document, tokens: { "fg-1": value } })).toContain(
      "tokens.fg-1 is not a colour or a scale step name.",
    );
});
test("a faint foreground is refused with its pair and two-decimal ratio", () => {
  const errors = problems({ ...document, tokens: { "fg-1": "oklch(.145 .004 260)" } });
  expect(errors).toContain("fg-1 on bg-app: 1.00 to 1, needs 4.5 to 1.");
  expect(problems({ ...document, version: 2, tokens: { "fg-1": "n-1000" } })).toContain(
    "fg-1 on bg-app: 1.00 to 1, needs 4.5 to 1.",
  );
});
test("scale overrides follow base alias chains but a token colour wins", () => {
  const entry = check({ ...document, scales: { "n-50": "#FFFFFF" }, tokens: { "syn-plain": "#EEEEEE" } });
  expect(entry.scales).toEqual({ "n-50": "#ffffff" });
  expect(resolveTheme(entry)).toMatchObject({ "fg-1": "#ffffff", "state-open-fg": "#ffffff", "syn-plain": "#eeeeee" });
  const explicit = check({ ...document, tokens: { "fg-1": "#FFFFFF" } });
  expect(resolveTheme(explicit)["state-open-fg"]).toBe("#ffffff");
});
test.each(["dark", "light"] as const)(
  "copying %s lists every colour, keeps references and resolves identically",
  (base) => {
    const copy = themeCopyDocument(base);
    expect(Object.keys(copy.scales ?? {})).toEqual(THEME_SCALE_STEPS);
    expect(Object.keys(copy.tokens ?? {})).toEqual(THEME_TOKENS);
    expect(copy.fonts).toEqual(DEFAULT_THEME_FONTS);
    expect(copy.tokens?.["bg-reading"]).toBe(base === "dark" ? "n-950" : "n-25");
    expect(resolveTheme(check(copy))).toEqual(resolveTheme(base));
    expect(themeCopyDocument(check(copy))).toEqual(copy);
  },
);
test("copying a theme preserves fonts and stops references at custom token colours", () => {
  const entry = check({
    ...document,
    fonts: { text: "Example Sans" },
    scales: { "n-950": "oklch(.18 .004 260)" },
    tokens: { "bg-surface": "#101010", "agent-none": "n-400" },
  });
  const copy = themeCopyDocument(entry);
  expect(copy.fonts).toEqual({ text: "Example Sans", code: DEFAULT_THEME_FONTS.code });
  expect(copy.tokens?.["bg-reading"]).toBe("#101010");
  expect(copy.tokens?.["agent-none"]).toBe("n-400");
  expect(resolveTheme(check(copy))).toEqual(resolveTheme(entry));
});
test("a copied scale change still recolours dependent tokens", () => {
  const copy = themeCopyDocument("dark");
  copy.scales = { ...copy.scales, "n-950": "oklch(0.19 0.004 260)" };
  expect(resolveTheme(check(copy))["bg-reading"]).toBe("oklch(0.19 0.004 260)");
});
test.each(["bg-app", "bg-surface", "bg-sunken", "bg-raised", "bg-reading", "bg-reading-card", "bg-inverse"])(
  "%s must resolve to an opaque colour, including scale references",
  (surface) => {
    for (const value of ["#171717fe", "oklch(0.18 0.004 260 / 0.99)", "n-950"])
      expect(problems({ ...document, scales: { "n-950": "#171717fe" }, tokens: { [surface]: value } })).toContain(
        `${surface} must be opaque: its colour has transparency.`,
      );
  },
);
test("refuses the translucent app surface that passed contrast over a single canvas", () => {
  expect(problems({ ...document, tokens: { "bg-app": "#ffffff4d", "fg-3": "#ffffff" } })).toContain(
    "bg-app must be opaque: its colour has transparency.",
  );
});
test.each([
  { "diff-add-word": "oklch(0.18 0.004 260)", "diff-del-word": "oklch(0.18 0.004 260)" },
  { "diff-add-bg": "#7c7c7c", "syn-string": "#7c7c7c", "syn-keyword": "#7c7c7c", "diff-add-fg": "#000000" },
])("refuses unreadable diff colours: %j", (tokens) => {
  expect(problems({ version: 1, base: "light", tokens })).toEqual(
    expect.arrayContaining([expect.stringMatching(/^syn-\w+ on diff-(add|del)-(bg|word):/)]),
  );
});
test("diff word backgrounds composite over their line, then the surface", () => {
  const colors = resolveTheme("dark");
  colors["diff-add-bg"] = "#ffffff40";
  colors["diff-add-word"] = "#00000080";
  const surface = parseThemeColor(colors["bg-surface"])?.rgba;
  const line = parseThemeColor(colors["diff-add-bg"])?.rgba;
  const word = parseThemeColor(colors["diff-add-word"])?.rgba;
  if (!surface || !line || !word) throw new Error("Bad test colour");
  expect(themeBackground(colors, "dark", "diff-add-word", "diff-add-bg")).toEqual(
    compositeThemeColor(word, compositeThemeColor(line, surface)),
  );
});
test("refuses a theme whose Download hides reading text on diff lines", () => {
  const tokens = {
    "bg-surface": "#ffffff",
    ...Object.fromEntries(THEME_TOKENS.filter((name) => name.startsWith("syn-")).map((name) => [name, "#767676"])),
    "diff-add-bg": "#000000",
    "diff-add-word": "#000000",
    "diff-add-hover": "#000000",
    "diff-add-fg": "#ffffff",
    "diff-del-bg": "#ffffff",
    "diff-del-word": "#ffffff",
    "diff-del-hover": "#ffffff",
    "diff-select-bg": "#ffffff",
  };
  expect(problems({ version: 1, base: "light", tokens })).toContainEqual(
    expect.stringMatching(/^fg-reading-strong on diff-add-bg: .*needs 4.5 to 1\.$/),
  );
});
test("Download diff backgrounds composite over bg-sunken", () => {
  const colors = resolveTheme("dark");
  colors["bg-sunken"] = "#ffffff";
  colors["diff-add-bg"] = "#00000080";
  const line = parseThemeColor(colors["diff-add-bg"])?.rgba;
  const sunken = parseThemeColor(colors["bg-sunken"])?.rgba;
  if (!line || !sunken) throw new Error("Bad test colour");
  expect(themeBackground(colors, "dark", "diff-add-bg", "bg-sunken")).toEqual(compositeThemeColor(line, sunken));
  expect(themeReadabilityProblems(colors, "dark")).toContainEqual(
    expect.stringMatching(/^fg-reading-strong on diff-add-bg:/),
  );
});
test("refuses syntax colours hidden by hovered and selected diff lines", () => {
  const tokens = {
    "syn-plain": "#000000",
    "fg-1": "#000000",
    "syn-string": "#7a7a7a",
    "diff-add-hover": "#7a7a7a",
    "diff-select-bg": "#7a7a7a",
  };
  expect(problems({ version: 1, base: "light", tokens })).toEqual(
    expect.arrayContaining([
      "syn-string on diff-add-hover: 1.00 to 1, needs 3 to 1.",
      "syn-string on diff-select-bg: 1.00 to 1, needs 3 to 1.",
    ]),
  );
});
test("translucent backgrounds composite through surfaces; valid meta colours use opaque bg-app", () => {
  const colors = resolveTheme("dark");
  colors["bg-app"] = "#ffffff80";
  colors["bg-surface"] = "#00000080";
  colors["bg-hover"] = "#ffffff80";
  const black = parseThemeColor("#000000")?.rgba;
  const white = parseThemeColor("#ffffff80")?.rgba;
  const dark = parseThemeColor("#00000080")?.rgba;
  if (!black || !white || !dark) throw new Error("Bad test colour");
  const app = compositeThemeColor(white, black);
  const surface = compositeThemeColor(dark, app);
  expect(themeBackground(colors, "dark", "bg-surface")).toEqual(surface);
  expect(themeBackground(colors, "dark", "bg-hover")).toEqual(compositeThemeColor(white, surface));
  const entry = check({ ...document, tokens: { "bg-app": "#000000ff" } });
  expect(entry.themeColor).toBe("#000000");
  expect(check({ version: 1, base: "light", tokens: { "bg-app": "#ffffffff" } }).themeColor).toBe("#ffffff");
  expect(themeColorHex(themeBackground(colors, "dark", "bg-app"))).toBe("#808080");
});
test("download look uses the nine resolved reading and diff colours", () => {
  const source = check({ ...document, tokens: { "fg-link": "#ffffff" } });
  const colors = resolveTheme(source);
  expect(themeDownloadLook(source)).toEqual({
    base: "dark",
    colors: {
      bg: colors["bg-reading"],
      sunken: colors["bg-sunken"],
      fg: colors["fg-reading"],
      strong: colors["fg-reading-strong"],
      muted: colors["fg-reading-muted"],
      border: colors["border-1"],
      link: "#ffffff",
      diffAdd: colors["diff-add-bg"],
      diffDel: colors["diff-del-bg"],
    },
  });
});
