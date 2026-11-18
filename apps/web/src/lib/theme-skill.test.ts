import { expect, test } from "vitest";
import { themeSkillPrompt, themeSkillUrl } from "./theme-skill.ts";

test("released builds link to the theme skill at their tag", () => {
  expect(themeSkillUrl("0.10.0")).toBe(
    "https://raw.githubusercontent.com/shllg/emend/refs/tags/v0.10.0/docs/skills/emend-theme/SKILL.md",
  );
});

test.each(["0.1.0", "0.0.0-test", "1.2", "01.2.3", "", "1.02.3", "1.2.03", "1.2.3\n", "1.2.3+build"])(
  "unreleased version %j links to main",
  (version) => {
    expect(themeSkillUrl(version)).toBe(
      "https://raw.githubusercontent.com/shllg/emend/refs/heads/main/docs/skills/emend-theme/SKILL.md",
    );
  },
);

test.each(["0.10.0", "0.0.0-test"])("the prompt includes the %s skill and leaves room for a wish", (version) => {
  expect(themeSkillPrompt(version)).toContain(themeSkillUrl(version));
  expect(themeSkillPrompt(version).endsWith("What I want: ")).toBe(true);
});
