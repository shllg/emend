import { fileURLToPath, URL } from "node:url";
import { SyntaxRole } from "@recense/contract";
import { expect, test } from "vitest";
import { sharedHighlighter } from "./highlighter.ts";
import { syntaxColors, syntaxRole, syntaxTheme } from "./syntax-theme.ts";

test("core's roles and font styles match the diff's TextMate rules", async () => {
  // Read the web specialization only in this parity test, without a core runtime dependency.
  const path = fileURLToPath(new URL("../../../../apps/web/src/components/diff/theme.ts", import.meta.url));
  const { syntaxTheme: diff } = (await import(path)) as { syntaxTheme: typeof syntaxTheme };
  expect(syntaxTheme.tokenColors).toEqual(
    diff.tokenColors.map((rule) => ({
      ...rule,
      settings: {
        ...rule.settings,
        foreground: rule.settings.foreground.replace(/^var\(--diffs-[\w-]+, (var\(--[\w-]+\))\)$/, "$1"),
      },
    })),
  );
  expect(Object.keys(syntaxColors)).toEqual(SyntaxRole.options);
});

test("Shiki restores non-hex colours through colorReplacements", async () => {
  const highlighter = await sharedHighlighter();
  expect(highlighter.getLoadedThemes()).toEqual(["recense"]);
  const { tokens, fg, bg } = highlighter.codeToTokens("const count: number = 1; // note", {
    lang: "ts",
    theme: "recense",
    // A loaded machine must not cut the line short in this colour-mapping test.
    tokenizeTimeLimit: 0,
  });
  expect(fg).toBe(syntaxColors.plain);
  expect(bg).toBe("var(--bg-sunken)");
  expect(tokens.flat().map((token) => token.color)).toEqual(
    expect.arrayContaining([syntaxColors.keyword, syntaxColors.type, syntaxColors.number, syntaxColors.comment]),
  );
  for (const token of tokens.flat()) expect(Object.values(syntaxColors)).toContain(token.color);
  for (const role of SyntaxRole.options) expect(syntaxRole(syntaxColors[role])).toBe(role);
  for (const color of [undefined, "#abcdef", "red", "var(--unknown)", "__proto__"])
    expect(syntaxRole(color)).toBe("plain");
});
