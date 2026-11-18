export const THEME_SKILL_PATH = "docs/skills/emend-theme/SKILL.md";
// Main keeps this placeholder; releases stamp a new version before building.
// Its old release tag predates the skill, so a build reporting it is unreleased.
export const UNRELEASED_VERSION = "0.1.0";

const PLAIN_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$(?![\s\S])/;

export function themeSkillUrl(version: string): string {
  const released = PLAIN_VERSION.test(version);
  // Fully qualified refs keep branches and tags with matching names from shadowing each other.
  const ref = released && version !== UNRELEASED_VERSION ? `refs/tags/v${version}` : "refs/heads/main";
  return `https://raw.githubusercontent.com/shllg/emend/${ref}/${THEME_SKILL_PATH}`;
}

export function themeSkillPrompt(version: string): string {
  return `Make me a custom theme for emend. Read the skill at ${themeSkillUrl(version)} and follow it.\n\nWhat I want: `;
}
