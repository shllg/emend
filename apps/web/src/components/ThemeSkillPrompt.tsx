import { themeSkillPrompt } from "../lib/theme-skill.ts";
import { CopyPrompt } from "./CopyPrompt.tsx";

const PROMPT = themeSkillPrompt(__EMEND_VERSION__);

export function ThemeSkillPrompt() {
  return (
    <div className="mt-4 flex min-w-0 flex-col gap-2">
      <h3 className="text-14 font-semibold">Make a theme with your agent</h3>
      <p className="text-14 text-fg-3">Paste this into any coding agent and add what you want.</p>
      <CopyPrompt prompt={PROMPT} />
    </div>
  );
}
